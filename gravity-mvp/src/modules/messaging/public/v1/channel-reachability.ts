// messaging ChannelReachabilityCheck: the live «is there an account on this number»
// check of one channel, and the persistence of an exact provider binding it proves.
// Moved unchanged from POST /api/channels/check-reachability (Contact Identity V2,
// W5; MSR review) so that route and the person card's reachability route share one
// implementation. It takes an already resolved E.164 number and, optionally, an
// exact identity binding, never a request body. The provider calls stay where
// they were, behind each lane's own live guard as a lookup.
import { contactReachabilityV1 } from '@/modules/contacts/public/v1/contact-reachability'

export type CheckChannel = 'telegram' | 'whatsapp' | 'max'
export type ReachabilityState = 'confirmed' | 'unreachable' | 'checking'

export type ReachabilityResult = {
  status: ReachabilityState
  reachable: boolean | null
  confirmed: boolean
  retryable: boolean
  channel: CheckChannel
  error?: string
  errorCode?: string
  telegramId?: string
  maxChatId?: string | null
  providerAccountId?: string
  providerTargetId?: string
  source?: string
}

export type ExactReachabilityBinding = {
  identityId: string
  contactId: string
  providerAccountId: string
}

const MAX_SCRAPER_URL = process.env.MAX_SCRAPER_URL || 'http://localhost:3005'

/**
 * Check one channel for one resolved number and, with an exact identity binding,
 * record what the provider proved. The answer is the route's former JSON body.
 */
export async function checkChannelReachabilityV1(
  channel: CheckChannel,
  normalized: string,
  exactBinding: ExactReachabilityBinding | null,
): Promise<ReachabilityResult> {
  const result = await checkChannelReachability(
    channel,
    normalized,
    exactBinding?.providerAccountId,
  )

  // A phone-only pre-check may inform discovery UI, but it cannot authorize
  // any ContactIdentity. Persistence requires one exact client-selected
  // identity plus the account and opaque target returned by the provider.
  if (
    exactBinding
    && (result.status === 'confirmed' || result.status === 'unreachable')
  ) {
    if (!result.providerAccountId || !result.providerTargetId) {
      return checking(channel, 'Exact provider identity was not proven', {
        retryable: false,
        errorCode: 'exact_provider_binding_unproven',
      })
    }
    if (result.providerAccountId !== exactBinding.providerAccountId) {
      return checking(channel, 'Provider account binding changed during the check', {
        retryable: false,
        errorCode: 'provider_account_mismatch',
      })
    }

    const persisted = await contactReachabilityV1.recordExactProviderReachability({
      identityId: exactBinding.identityId,
      contactId: exactBinding.contactId,
      channel,
      providerAccountId: result.providerAccountId,
      providerTargetId: result.providerTargetId,
      status: result.status,
    })
    if (persisted.outcome === 'confirmed_preserved') {
      return confirmed(channel, {
        providerAccountId: result.providerAccountId,
        providerTargetId: result.providerTargetId,
        source: 'persisted',
      })
    }
    if (persisted.outcome === 'rejected') {
      return checking(channel, 'Exact Contact identity binding was rejected', {
        retryable: false,
        errorCode: persisted.reason,
      })
    }
  }

  return result
}

export function concreteOpaqueId(value: unknown): string | null {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 512
    && value.trim() === value
    && value !== 'legacy'
    ? value
    : null
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}


export function isCheckChannel(channel: unknown): channel is CheckChannel {
  return channel === 'telegram' || channel === 'whatsapp' || channel === 'max'
}

async function checkChannelReachability(
  channel: CheckChannel,
  phone: string,
  requestedProviderAccountId?: string,
): Promise<ReachabilityResult> {
  if (channel === 'telegram') {
    const { checkOperationalTelegramReachabilityV1 } = await import('@/infrastructure/telegram/operational-capabilities')
    const result = await checkOperationalTelegramReachabilityV1(phone, requestedProviderAccountId)
    if (result.telegramId) {
      return confirmed(channel, {
        telegramId: result.telegramId,
        providerAccountId: concreteOpaqueId(result.providerAccountId) ?? undefined,
        providerTargetId: result.telegramId,
        source: 'telegram',
      })
    }
    if (result.reachable === false) {
      return unreachable(channel, result.error || 'Telegram аккаунт не найден', {
        providerAccountId: concreteOpaqueId(result.providerAccountId) ?? undefined,
      })
    }
    return checking(channel, result.error || 'Telegram проверяется')
  }

  if (channel === 'whatsapp') {
    const { checkOperationalWhatsAppReachabilityV1 } = await import('@/infrastructure/whatsapp/operational-capabilities')
    const result = await checkOperationalWhatsAppReachabilityV1(phone, requestedProviderAccountId)
    const providerResult = result as typeof result & {
      providerAccountId?: unknown
      providerTargetId?: unknown
    }
    const providerAccountId = concreteOpaqueId(providerResult.providerAccountId) ?? undefined
    const providerTargetId = concreteOpaqueId(providerResult.providerTargetId) ?? undefined
    if (result.confirmed) {
      return confirmed(channel, { providerAccountId, providerTargetId, source: 'whatsapp' })
    }
    if (result.reachable === false) {
      return unreachable(channel, result.error || 'WhatsApp аккаунт не найден', {
        providerAccountId,
        providerTargetId,
      })
    }
    return checking(channel, result.error || 'WhatsApp проверяется', {
      retryable: result.retryable !== false,
      errorCode: result.reason,
      source: 'whatsapp',
    })
  }

  return checkMaxReachability(phone, requestedProviderAccountId)
}

async function checkMaxReachability(
  phone: string,
  requestedProviderAccountId?: string,
): Promise<ReachabilityResult> {
  const providerAccountId = concreteOpaqueId(requestedProviderAccountId)
  if (!providerAccountId || providerAccountId === 'max-default') {
    return checking('max', 'An exact live MAX account is required', {
      retryable: false,
      errorCode: 'provider_account_unproven',
    })
  }
  try {
    const res = await fetch(`${MAX_SCRAPER_URL}/check-reachability`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, providerAccountId }),
      cache: 'no-store',
      signal: AbortSignal.timeout(30_000),
    })
    const data = await res.json().catch(() => ({}))
    if (data.code === 'MAX_PROVIDER_ACCOUNT_MISMATCH') {
      return checking('max', data.error || 'MAX live account differs from the requested account', {
        retryable: false,
        errorCode: 'provider_account_mismatch',
      })
    }
    const definitivePositive = res.ok
      && (data.status === 'confirmed' || data.confirmed === true || data.reachable === true)
    const definitiveNegative = res.status === 404
      || data.status === 'unreachable'
      || data.reachable === false

    if (definitivePositive || definitiveNegative) {
      const liveProviderAccountId = concreteOpaqueId(data.providerAccountId)
      if (!liveProviderAccountId) {
        return checking('max', 'MAX did not attest the live account', {
          retryable: false,
          errorCode: 'exact_provider_binding_unproven',
        })
      }
      if (liveProviderAccountId !== providerAccountId) {
        return checking('max', 'MAX live account differs from the requested account', {
          retryable: false,
          errorCode: 'provider_account_mismatch',
        })
      }
    }

    if (definitivePositive) {
      return confirmed('max', {
        maxChatId: data.chatId || data.maxChatId || null,
        providerAccountId,
        providerTargetId: concreteOpaqueId(data.chatId || data.maxChatId) ?? undefined,
        source: data.source || 'max-scraper',
      })
    }

    if (definitiveNegative) {
      return unreachable('max', data.error || 'MAX аккаунт не найден', {
        providerAccountId,
        providerTargetId: concreteOpaqueId(data.chatId || data.maxChatId) ?? undefined,
      })
    }

    return checking('max', data.error || `MAX проверяется (HTTP ${res.status})`)
  } catch (error: unknown) {
    const message = errorMessage(error)
    console.error('[check-reachability] MAX error:', message)
    return checking('max', message || 'MAX проверяется')
  }
}

function confirmed(channel: CheckChannel, extra: Partial<ReachabilityResult> = {}): ReachabilityResult {
  return {
    status: 'confirmed',
    reachable: true,
    confirmed: true,
    retryable: false,
    channel,
    ...extra,
  }
}

function unreachable(
  channel: CheckChannel,
  error?: string,
  extra: Partial<ReachabilityResult> = {},
): ReachabilityResult {
  return {
    status: 'unreachable',
    reachable: false,
    confirmed: false,
    retryable: false,
    channel,
    error,
    ...extra,
  }
}

export function checking(channel: CheckChannel, error?: string, extra: Partial<ReachabilityResult> = {}): ReachabilityResult {
  return {
    status: 'checking',
    reachable: null,
    confirmed: false,
    retryable: extra.retryable ?? true,
    channel,
    error,
    ...extra,
  }
}
