import { NextRequest, NextResponse } from 'next/server'
import { normalizePhoneE164 } from '@/modules/contacts/public/v1/phone-identity'
import { findIdentityByPhoneAndChannel, updateReachability } from '@/lib/ReachabilityService'
import { prisma } from '@/lib/prisma'

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
  source?: string
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

    const normalized = normalizePhoneE164(rawPhone)
    if (!normalized) {
      return NextResponse.json(
        { error: 'Invalid phone number format' },
        { status: 400 }
      )
    }

    const result = await checkChannelReachability(channel, normalized)

    // Persist only definitive outcomes. "checking" means CRM failed to get
    // a reliable answer and must retry instead of pretending green success.
    if (result.status === 'confirmed' || result.status === 'unreachable') {
      const identityId = await findIdentityByPhoneAndChannel(normalized, channel)
      if (identityId) {
        if (result.status === 'unreachable') {
          // Protect confirmed identities: a single negative live check can be
          // caused by provider limits/privacy/UI flakiness and must not erase
          // an account proven by a real conversation or delivery confirmation.
          const existing = await prisma.contactIdentity.findUnique({
            where: { id: identityId },
            select: { reachabilityStatus: true },
          })
          if (existing?.reachabilityStatus === 'confirmed') {
            return NextResponse.json(confirmed(channel, { source: 'persisted' }))
          }
        }
        await updateReachability(identityId, result.status)
      }
    }

    return NextResponse.json(result)
  } catch (err: any) {
    console.error('[check-reachability] Error:', err.message)
    return NextResponse.json(checking(requestedChannel, 'Reachability check is retrying'))
  }
}

function isCheckChannel(channel: unknown): channel is CheckChannel {
  return channel === 'telegram' || channel === 'whatsapp' || channel === 'max'
}

async function checkChannelReachability(channel: CheckChannel, phone: string): Promise<ReachabilityResult> {
  if (channel === 'telegram') {
    const { checkOperationalTelegramReachabilityV1 } = await import('@/infrastructure/telegram/operational-capabilities')
    const result = await checkOperationalTelegramReachabilityV1(phone)
    if (result.telegramId) {
      return confirmed(channel, { telegramId: result.telegramId, source: 'telegram' })
    }
    if (result.reachable === false) {
      return unreachable(channel, result.error || 'Telegram аккаунт не найден')
    }
    return checking(channel, result.error || 'Telegram проверяется')
  }

  if (channel === 'whatsapp') {
    const { checkOperationalWhatsAppReachabilityV1 } = await import('@/infrastructure/whatsapp/operational-capabilities')
    const result = await checkOperationalWhatsAppReachabilityV1(phone)
    if (result.confirmed) {
      return confirmed(channel, { source: 'whatsapp' })
    }
    if (result.reachable === false) {
      return unreachable(channel, result.error || 'WhatsApp аккаунт не найден')
    }
    return checking(channel, result.error || 'WhatsApp проверяется', {
      retryable: result.retryable !== false,
      errorCode: result.reason,
      source: 'whatsapp',
    })
  }

  return checkMaxReachability(phone)
}

async function checkMaxReachability(phone: string): Promise<ReachabilityResult> {
  try {
    const res = await fetch(`${MAX_SCRAPER_URL}/check-reachability`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone }),
      cache: 'no-store',
      signal: AbortSignal.timeout(30_000),
    })
    const data = await res.json().catch(() => ({}))

    if (res.ok && (data.status === 'confirmed' || data.confirmed === true || data.reachable === true)) {
      return confirmed('max', {
        maxChatId: data.chatId || data.maxChatId || null,
        source: data.source || 'max-scraper',
      })
    }

    if (res.status === 404 || data.status === 'unreachable' || data.reachable === false) {
      return unreachable('max', data.error || 'MAX аккаунт не найден')
    }

    return checking('max', data.error || `MAX проверяется (HTTP ${res.status})`)
  } catch (err: any) {
    console.error('[check-reachability] MAX error:', err.message)
    return checking('max', err.message || 'MAX проверяется')
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

function unreachable(channel: CheckChannel, error?: string): ReachabilityResult {
  return {
    status: 'unreachable',
    reachable: false,
    confirmed: false,
    retryable: false,
    channel,
    error,
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
