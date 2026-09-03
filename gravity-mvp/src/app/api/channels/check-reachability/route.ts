import { NextRequest, NextResponse } from 'next/server'
import { normalizePhoneE164 } from '@/modules/contacts/public/v1/phone-identity'
import { contactReachabilityV1 } from '@/modules/contacts/public/v1/contact-reachability'
import {
  getIntegrationAdminPrincipal,
  isExactSameOriginMutationRequest,
} from '@/modules/identity-access/public/v1'

type CheckChannel = 'telegram' | 'whatsapp' | 'max'
type ReachabilityState = 'confirmed' | 'unreachable' | 'checking'

type ReachabilityResult = {
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

type ExactReachabilityBinding = {
  identityId: string
  contactId: string
  providerAccountId: string
}

const MAX_SCRAPER_URL = process.env.MAX_SCRAPER_URL || 'http://localhost:3005'

/**
 * POST /api/channels/check-reachability
 *
 * Live-check whether a phone number is reachable through a messaging channel.
 *
 * Business states are binary: account exists or does not exist.
 * Operational failures are "checking" and must not be shown as green.
 */
export async function POST(req: NextRequest) {
  if (!isExactSameOriginMutationRequest(req)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  if (!await getIntegrationAdminPrincipal()) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let requestedChannel: CheckChannel = 'max'
  try {
    const body = await req.json()
    const { phone: rawPhone, channel } = body

    if (!rawPhone || !channel) {
      return NextResponse.json(
        { error: 'phone and channel are required' },
        { status: 400 }
      )
    }

    if (!isCheckChannel(channel)) {
      return NextResponse.json(
        { error: 'Pre-check is supported only for telegram, whatsapp and max' },
        { status: 400 }
      )
    }
    requestedChannel = channel

    const exactBinding = parseExactReachabilityBinding(body)
    if (exactBinding === 'invalid') {
      return NextResponse.json(
        { error: 'identityId, contactId and providerAccountId must be supplied together' },
        { status: 400 },
      )
    }

    const normalized = normalizePhoneE164(rawPhone)
    if (!normalized) {
      return NextResponse.json(
        { error: 'Invalid phone number format' },
        { status: 400 }
      )
    }

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
        return NextResponse.json(checking(channel, 'Exact provider identity was not proven', {
          retryable: false,
          errorCode: 'exact_provider_binding_unproven',
        }))
      }
      if (result.providerAccountId !== exactBinding.providerAccountId) {
        return NextResponse.json(checking(channel, 'Provider account binding changed during the check', {
          retryable: false,
          errorCode: 'provider_account_mismatch',
        }))
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
        return NextResponse.json(confirmed(channel, {
          providerAccountId: result.providerAccountId,
          providerTargetId: result.providerTargetId,
          source: 'persisted',
        }))
      }
      if (persisted.outcome === 'rejected') {
        return NextResponse.json(checking(channel, 'Exact Contact identity binding was rejected', {
          retryable: false,
          errorCode: persisted.reason,
        }))
      }
    }

    return NextResponse.json(result)
  } catch (error: unknown) {
    console.error('[check-reachability] Error:', errorMessage(error))
    return NextResponse.json(checking(requestedChannel, 'Reachability check is retrying'))
  }
}

function concreteOpaqueId(value: unknown): string | null {
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

function parseExactReachabilityBinding(body: Record<string, unknown>): ExactReachabilityBinding | null | 'invalid' {
  const supplied = [body.identityId, body.contactId, body.providerAccountId]
    .some(value => value !== undefined && value !== null)
  if (!supplied) return null

  const identityId = concreteOpaqueId(body.identityId)
  const contactId = concreteOpaqueId(body.contactId)
  const providerAccountId = concreteOpaqueId(body.providerAccountId)
  return identityId && contactId && providerAccountId
    ? { identityId, contactId, providerAccountId }
    : 'invalid'
}

function isCheckChannel(channel: unknown): channel is CheckChannel {
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

function checking(channel: CheckChannel, error?: string, extra: Partial<ReachabilityResult> = {}): ReachabilityResult {
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
