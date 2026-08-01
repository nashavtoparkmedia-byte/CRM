import { NextRequest, NextResponse } from 'next/server'

import { normalizePhoneE164 } from '@/lib/phoneUtils'
import {
  getProviderConnectionHealth,
  resolvePersonalMaxDurableRouteForIdentity,
  resolveReachabilityIdentity,
  updateReachability,
  type ProviderConnectionHealth,
  type ReachabilityIdentityResolution,
} from '@/lib/ReachabilityService'
import {
  getOrCreateReachabilityDecision,
  REACHABILITY_DEFINITIVE_TTL_MS,
  REACHABILITY_OPERATIONAL_TTL_MS,
} from '@/lib/reachability-decision-cache'

export type CheckChannel = 'telegram' | 'whatsapp' | 'max'
export type ReachabilityState = 'confirmed' | 'unreachable' | 'checking'
export type ReachabilityConnectionHealth = ProviderConnectionHealth | 'unavailable'

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
  source?: string
}

type ReachabilityResponse = ReachabilityResult & {
  cached: boolean
  decisionSource: 'persisted' | 'live' | 'cache' | 'coalesced' | 'error'
  checkedAt: string
  expiresAt: string
  connectionHealth: ReachabilityConnectionHealth
  operationalFailure: boolean
  identityResolution: ReachabilityIdentityResolution['kind']
}

const MAX_SCRAPER_URL = process.env.MAX_SCRAPER_URL || 'http://localhost:3005'

/**
 * POST /api/channels/check-reachability
 *
 * A request is a refresh decision, not an unconditional provider call:
 * - fresh persisted identity state wins;
 * - phone-level decisions are cached for a TTL;
 * - concurrent decisions for the same phone/channel are coalesced;
 * - operational failures are cached briefly to prevent retry storms.
 */
export async function POST(req: NextRequest) {
  let requestedChannel: CheckChannel = 'max'
  try {
    const body = await req.json()
    const rawPhone = body.phone
    const channel = body.channel
    const requestedIdentityId = typeof body.identityId === 'string' ? body.identityId : null
    const force = body.force === true

    if (!rawPhone || !channel) {
      return NextResponse.json(
        { error: 'phone and channel are required' },
        { status: 400 },
      )
    }
    if (!isCheckChannel(channel)) {
      return NextResponse.json(
        { error: 'Pre-check is supported only for telegram, whatsapp and max' },
        { status: 400 },
      )
    }
    requestedChannel = channel

    const normalized = normalizePhoneE164(rawPhone)
    if (!normalized) {
      return NextResponse.json(
        { error: 'Invalid phone number format' },
        { status: 400 },
      )
    }

    const [identityResolution, storedConnectionHealth] = await Promise.all([
      resolveReachabilityIdentity(normalized, channel, requestedIdentityId),
      getProviderConnectionHealth(channel),
    ])
    if (channel === 'max' && identityResolution.kind === 'matched') {
      const durableRoute = await resolvePersonalMaxDurableRouteForIdentity(identityResolution.identity.id)
      const now = Date.now()
      if (durableRoute.kind === 'active') {
        await updateReachability(identityResolution.identity.id, 'confirmed')
        return NextResponse.json(withDecisionMetadata(confirmed(channel, {
          maxChatId: durableRoute.protocolChatId,
          source: 'durable-route-registry',
        }), {
          cached: false,
          decisionSource: 'persisted',
          checkedAtMs: now,
          expiresAtMs: now + REACHABILITY_DEFINITIVE_TTL_MS,
          connectionHealth: storedConnectionHealth,
          identityResolution,
        }))
      }
      if (durableRoute.kind === 'ambiguous') {
        return NextResponse.json(withDecisionMetadata(checking(channel, 'MAX route requires engineer review', {
          retryable: false,
          errorCode: 'durable_route_ambiguous',
          source: 'durable-route-registry',
        }), {
          cached: false,
          decisionSource: 'error',
          checkedAtMs: now,
          expiresAtMs: now + REACHABILITY_OPERATIONAL_TTL_MS,
          connectionHealth: storedConnectionHealth,
          identityResolution,
        }))
      }
      if (durableRoute.kind === 'unavailable') {
        return NextResponse.json(withDecisionMetadata(checking(channel, 'CRM сейчас не может проверить MAX route', {
          retryable: false,
          errorCode: 'durable_route_unavailable',
          source: 'durable-route-registry',
        }), {
          cached: false,
          decisionSource: 'error',
          checkedAtMs: now,
          expiresAtMs: now + REACHABILITY_OPERATIONAL_TTL_MS,
          connectionHealth: storedConnectionHealth,
          identityResolution,
        }))
      }
    }
    const persisted = freshPersistedDecision(identityResolution, channel, force)
    if (persisted) {
      return NextResponse.json(withDecisionMetadata(persisted.result, {
        cached: true,
        decisionSource: 'persisted',
        checkedAtMs: persisted.checkedAtMs,
        expiresAtMs: persisted.expiresAtMs,
        connectionHealth: storedConnectionHealth,
        identityResolution,
      }))
    }

    const cacheKey = `${channel}:${normalized}`
    const decision = await getOrCreateReachabilityDecision({
      key: cacheKey,
      force,
      load: async () => {
        const result = await checkChannelReachability(channel, normalized)
        return {
          value: result,
          ttlMs: result.status === 'checking'
            ? REACHABILITY_OPERATIONAL_TTL_MS
            : REACHABILITY_DEFINITIVE_TTL_MS,
        }
      },
    })

    let result = decision.value
    if (identityResolution.kind === 'matched') {
      if (
        result.status === 'unreachable'
        && identityResolution.identity.reachabilityStatus === 'confirmed'
      ) {
        result = confirmed(channel, { source: 'persisted_protected' })
      } else if (result.status === 'confirmed' || result.status === 'unreachable') {
        await updateReachability(identityResolution.identity.id, result.status)
      }
    }

    return NextResponse.json(withDecisionMetadata(result, {
      cached: decision.source === 'cache',
      decisionSource: decision.source,
      checkedAtMs: decision.checkedAtMs,
      expiresAtMs: decision.expiresAtMs,
      connectionHealth: effectiveConnectionHealth(
        result,
        storedConnectionHealth,
        decision.source,
      ),
      identityResolution,
    }))
  } catch (error: unknown) {
    const now = Date.now()
    console.error('[check-reachability] Error:', errorMessage(error))
    return NextResponse.json(withDecisionMetadata(
      checking(requestedChannel, 'CRM сейчас не может проверить канал', {
        retryable: false,
        errorCode: 'decision_failed',
      }),
      {
        cached: false,
        decisionSource: 'error',
        checkedAtMs: now,
        expiresAtMs: now + REACHABILITY_OPERATIONAL_TTL_MS,
        connectionHealth: 'unavailable',
        identityResolution: { kind: 'not_found' },
      },
    ))
  }
}

function freshPersistedDecision(
  resolution: ReachabilityIdentityResolution,
  channel: CheckChannel,
  force: boolean,
): { result: ReachabilityResult; checkedAtMs: number; expiresAtMs: number } | null {
  if (force || resolution.kind !== 'matched') return null
  const checkedAt = resolution.identity.reachabilityCheckedAt
  if (!checkedAt || resolution.identity.reachabilityStatus === 'unknown') return null
  const checkedAtMs = checkedAt.getTime()
  const expiresAtMs = checkedAtMs + REACHABILITY_DEFINITIVE_TTL_MS
  if (expiresAtMs <= Date.now()) return null
  return {
    result: resolution.identity.reachabilityStatus === 'confirmed'
      ? confirmed(channel, { source: 'persisted' })
      : unreachable(channel, 'Канал проверен: аккаунт у провайдера не найден'),
    checkedAtMs,
    expiresAtMs,
  }
}

function withDecisionMetadata(
  result: ReachabilityResult,
  metadata: {
    cached: boolean
    decisionSource: ReachabilityResponse['decisionSource']
    checkedAtMs: number
    expiresAtMs: number
    connectionHealth: ReachabilityConnectionHealth
    identityResolution: ReachabilityIdentityResolution
  },
): ReachabilityResponse {
  return {
    ...result,
    cached: metadata.cached,
    decisionSource: metadata.decisionSource,
    checkedAt: new Date(metadata.checkedAtMs).toISOString(),
    expiresAt: new Date(metadata.expiresAtMs).toISOString(),
    connectionHealth: metadata.connectionHealth,
    operationalFailure: result.status === 'checking'
      && (metadata.connectionHealth === 'disconnected' || metadata.connectionHealth === 'unavailable'),
    identityResolution: metadata.identityResolution.kind,
  }
}

function effectiveConnectionHealth(
  result: ReachabilityResult,
  stored: ProviderConnectionHealth,
  source: 'live' | 'cache' | 'coalesced',
): ReachabilityConnectionHealth {
  if (source !== 'cache' && (result.status === 'confirmed' || result.status === 'unreachable')) {
    return 'connected'
  }
  if (result.status === 'checking') {
    if (result.errorCode === 'client_not_ready' || stored === 'disconnected') {
      return 'disconnected'
    }
    return 'unavailable'
  }
  return stored
}

function isCheckChannel(channel: unknown): channel is CheckChannel {
  return channel === 'telegram' || channel === 'whatsapp' || channel === 'max'
}

async function checkChannelReachability(channel: CheckChannel, phone: string): Promise<ReachabilityResult> {
  if (channel === 'telegram') {
    const { checkTelegramReachability } = await import('@/app/tg-actions')
    const result = await checkTelegramReachability(phone)
    if (result.telegramId) {
      return confirmed(channel, { telegramId: result.telegramId, source: 'telegram' })
    }
    if (result.reachable === false) {
      return unreachable(channel, result.error || 'Telegram аккаунт не найден')
    }
    return checking(channel, result.error || 'Telegram проверяется')
  }

  if (channel === 'whatsapp') {
    const { checkReachability } = await import('@/lib/whatsapp/WhatsAppService')
    const result = await checkReachability(phone)
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
    return checking('max', data.error || `MAX проверяется (HTTP ${res.status})`, {
      errorCode: data.errorCode || 'provider_unavailable',
    })
  } catch (error: unknown) {
    console.error('[check-reachability] MAX error:', errorMessage(error))
    return checking('max', 'CRM сейчас не может проверить MAX', {
      retryable: false,
      errorCode: 'provider_unavailable',
    })
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

function checking(
  channel: CheckChannel,
  error?: string,
  extra: Partial<ReachabilityResult> = {},
): ReachabilityResult {
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
