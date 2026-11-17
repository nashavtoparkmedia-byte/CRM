import { NextRequest, NextResponse } from 'next/server'
import { normalizePhoneE164 } from '@/modules/contacts/public/v1/phone-identity'
import {
  getIntegrationAdminPrincipal,
  isExactSameOriginMutationRequest,
} from '@/modules/identity-access/public/v1'
import {
  checkChannelReachabilityV1,
  checking,
  concreteOpaqueId,
  isCheckChannel,
  type CheckChannel,
  type ExactReachabilityBinding,
} from '@/modules/messaging/public/v1/channel-reachability'

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

    return NextResponse.json(await checkChannelReachabilityV1(channel, normalized, exactBinding))
  } catch (error: unknown) {
    console.error('[check-reachability] Error:', errorMessage(error))
    return NextResponse.json(checking(requestedChannel, 'Reachability check is retrying'))
  }
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
