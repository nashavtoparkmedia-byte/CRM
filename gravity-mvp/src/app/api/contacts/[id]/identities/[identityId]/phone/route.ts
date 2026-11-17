import { NextRequest, NextResponse } from 'next/server'

import { manageContactPhoneEvidenceV1, resolveContactWriteAuthorityV1 } from '@/modules/contacts/public/v1'
import {
  isExactSameOriginMutationRequest,
} from '@/modules/identity-access/public/v1'

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; identityId: string }> },
) {
  if (!isExactSameOriginMutationRequest(req)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  const authority = await resolveContactWriteAuthorityV1()
  if (authority.decision !== 'allow') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { id: contactId, identityId } = await params
  const body = await req.json() as { phoneId?: string; basis?: string }
  if (!body.phoneId) return NextResponse.json({ error: 'phoneId is required' }, { status: 400 })
  try {
    const result = await manageContactPhoneEvidenceV1({
      operation: 'attach_identity',
      contactId,
      identityId,
      phoneId: body.phoneId,
      actor: authority.actor,
      basis: body.basis || 'manual identity-phone association',
    })
    return NextResponse.json(result)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Identity-phone association failed'
    return NextResponse.json({ error: message }, { status: message.endsWith('_NOT_FOUND') ? 404 : 409 })
  }
}
