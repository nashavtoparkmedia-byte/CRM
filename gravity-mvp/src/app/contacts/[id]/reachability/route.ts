import { NextRequest, NextResponse } from 'next/server'
import {
  readContactReachabilityTargetV1,
  resolveContactWriteAuthorityV1,
  type ContactReachabilityChannelV1,
} from '@/modules/contacts/public/v1'
import { isExactSameOriginMutationRequest, isJsonMutationRequest } from '@/modules/identity-access/public/v1'
import { checkChannelReachabilityV1, checking } from '@/modules/messaging/public/v1/channel-reachability'

/**
 * POST /contacts/{id}/reachability — «Проверить» in the person card's
 * «Мессенджеры» (Contact Identity V2, W5; MSR criteria).
 *
 * The body names one channel and this Contact's own phone and/or account by id:
 * { channel, phoneId?, identityId? }. Contacts' write authority is asked right
 * after the same-origin JSON check (a check may record what the provider proved,
 * and a mobile session is never admitted); Contacts then resolves the stored
 * number and the exact provider binding from those ids, which must belong to
 * this Contact. A raw `phone` in the body is refused. Messaging's one check runs
 * the provider lookup behind each lane's own live guard. The answer is the
 * reachability only, never the number or a provider target that could carry it.
 *
 * It sits beside the card page rather than under /api/contacts because the
 * Contacts module may not import Messaging; the platform shell composes both.
 */
const NO_STORE = { 'Cache-Control': 'no-store' }
const CHANNELS: readonly ContactReachabilityChannelV1[] = ['telegram', 'whatsapp', 'max']

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: NO_STORE })
}

function opaqueId(value: unknown): string | null | 'invalid' {
  if (value === undefined || value === null) return null
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && value.trim() === value ? value : 'invalid'
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isExactSameOriginMutationRequest(req) || !isJsonMutationRequest(req)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  const authority = await resolveContactWriteAuthorityV1()
  if (authority.decision !== 'allow') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { id } = await params
  const body = await req.json().catch(() => null) as Record<string, unknown> | null
  if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'Bad Request', code: 'INVALID_REACHABILITY_REQUEST' }, 400)
  // A number is resolved by Contacts from the ids below, never taken from the request.
  if ('phone' in body) return json({ error: 'Bad Request', code: 'RAW_PHONE_REFUSED' }, 400)
  const channel = CHANNELS.find(candidate => candidate === body.channel)
  const phoneId = opaqueId(body.phoneId)
  const identityId = opaqueId(body.identityId)
  if (channel === undefined || phoneId === 'invalid' || identityId === 'invalid' || (phoneId === null && identityId === null)) {
    return json({ error: 'Bad Request', code: 'INVALID_REACHABILITY_REQUEST' }, 400)
  }

  const target = await readContactReachabilityTargetV1({ contactId: id, channel, phoneId, identityId })
  if (target.status !== 'found') return json({ error: 'Not Found' }, 404)

  let result
  try {
    result = await checkChannelReachabilityV1(channel, target.phone, target.exactBinding)
  } catch (error) {
    console.error('[contacts/reachability] check failed:', error instanceof Error ? error.name : 'unknown')
    result = checking(channel, 'Reachability check is retrying')
  }
  return json({
    channel,
    status: result.status,
    reachable: result.reachable,
    confirmed: result.confirmed,
    retryable: result.retryable,
    ...(result.errorCode ? { errorCode: result.errorCode } : {}),
  })
}
