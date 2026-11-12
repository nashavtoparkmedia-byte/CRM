import { NextRequest, NextResponse } from 'next/server'
import { SET_CONTACT_COMMUNICATION_POLICY_COMMAND_V1 } from '@/contracts/contacts/v1'
import {
  readContactCommunicationRestrictionV1,
  setContactCommunicationPolicyV1,
} from '@/modules/contacts/application/contact-operations'
import { resolveContactReadAuthorityV1, resolveContactWriteAuthorityV1 } from '@/modules/contacts/public/v1'
import { isExactSameOriginMutationRequest, isJsonMutationRequest } from '@/modules/identity-access/public/v1'

/**
 * /api/contacts/{id}/communication-policy — «Ограничения связи» on the person
 * card (Contact Identity V2, Q4; Security W4).
 *
 * GET answers the canonical Contact's standing restriction and the version a
 * change must name, under Contacts' read authority.
 *
 * POST sets or lifts it: the complete requested state of the three flags, a
 * required reason, the version the operator decided against, and a request id
 * that makes a retry replay instead of deciding twice. Contacts' write
 * authority is asked right after the same-origin JSON check and before the body
 * is read; the actor recorded is the one it answered, never a field of the
 * body. A lift is the same command with the flags off, recorded as an event
 * exactly like a set. Calling and SendToContact read the policy on every
 * attempt, so the change applies to the next one. Answers are never cached.
 */
const NO_STORE = { 'Cache-Control': 'no-store' }

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: NO_STORE })
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authority = await resolveContactReadAuthorityV1()
  if (authority.decision !== 'allow') return json({ error: 'Unauthorized' }, 401)
  const { id } = await params
  try {
    const state = await readContactCommunicationRestrictionV1(id)
    if (state.status === 'unknown') return json({ error: 'Not Found' }, 404)
    return json(state)
  } catch (error) {
    console.error('[contacts/communication-policy] read failed:', error instanceof Error ? error.name : 'unknown')
    return json({ error: 'Unavailable' }, 503)
  }
}

type RestrictionRequest = {
  requestId: string
  expectedVersion: number
  restriction: { denyAll: boolean; denyMessage: boolean; denyVoice: boolean }
  reason: string
}

/** Only these fields are read from the body; anything else (an actor, an override) is ignored. */
function restrictionRequest(body: unknown): RestrictionRequest | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const value = body as Record<string, unknown>
  const restriction = value.restriction
  if (!restriction || typeof restriction !== 'object' || Array.isArray(restriction)) return null
  const flags = restriction as Record<string, unknown>
  if (typeof flags.denyAll !== 'boolean' || typeof flags.denyMessage !== 'boolean' || typeof flags.denyVoice !== 'boolean') return null
  if (typeof value.requestId !== 'string' || typeof value.reason !== 'string') return null
  if (typeof value.expectedVersion !== 'number' || !Number.isSafeInteger(value.expectedVersion) || value.expectedVersion < 0) return null
  const reason = value.reason.trim()
  if (reason === '') return null
  return {
    requestId: value.requestId,
    expectedVersion: value.expectedVersion,
    restriction: { denyAll: flags.denyAll, denyMessage: flags.denyMessage, denyVoice: flags.denyVoice },
    reason,
  }
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
  const parsed = restrictionRequest(await req.json().catch(() => null))
  if (parsed === null) return json({ error: 'Bad Request', code: 'INVALID_RESTRICTION_REQUEST' }, 400)

  try {
    const result = await setContactCommunicationPolicyV1({
      contract: SET_CONTACT_COMMUNICATION_POLICY_COMMAND_V1,
      requestId: parsed.requestId,
      contactId: id,
      expectedVersion: parsed.expectedVersion,
      restriction: parsed.restriction,
      actor: authority.actor,
      reason: parsed.reason,
    })
    switch (result.status) {
      case 'applied':
      case 'replayed':
        return json({ status: result.status, version: result.version, restriction: result.restriction })
      case 'version_conflict':
        return json({ error: 'Conflict', code: 'VERSION_CONFLICT', currentVersion: result.currentVersion }, 409)
      case 'idempotency_conflict':
        return json({ error: 'Conflict', code: 'REQUEST_ID_REUSED' }, 409)
      case 'contact_not_canonical':
        return json({ error: 'Conflict', code: 'CONTACT_MERGED', canonicalContactId: result.canonicalContactId }, 409)
      case 'contact_not_found':
        return json({ error: 'Not Found' }, 404)
      case 'lineage_unsafe':
        return json({ error: 'Conflict', code: 'LINEAGE_UNSAFE' }, 409)
    }
    return json({ error: 'Unavailable' }, 503)
  } catch (error) {
    if (error instanceof Error && error.name === 'ContactCommunicationPolicyContractValidationError') {
      return json({ error: 'Bad Request', code: 'INVALID_RESTRICTION_REQUEST' }, 400)
    }
    console.error('[contacts/communication-policy] change failed:', error instanceof Error ? error.name : 'unknown')
    return json({ error: 'Unavailable' }, 503)
  }
}
