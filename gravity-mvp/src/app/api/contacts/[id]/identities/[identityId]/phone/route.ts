import { NextRequest, NextResponse } from 'next/server'

import { manageContactPhoneEvidenceV1 } from '@/modules/contacts/public/v1'

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; identityId: string }> },
) {
  const { id: contactId, identityId } = await params
  const body = await req.json() as { phoneId?: string; actor?: string; basis?: string }
  if (!body.phoneId) return NextResponse.json({ error: 'phoneId is required' }, { status: 400 })
  try {
    const result = await manageContactPhoneEvidenceV1({
      operation: 'attach_identity',
      contactId,
      identityId,
      phoneId: body.phoneId,
      actor: body.actor || req.headers.get('x-crm-user-id') || 'operator:unknown',
      basis: body.basis || 'manual identity-phone association',
    })
    return NextResponse.json(result)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Identity-phone association failed'
    return NextResponse.json({ error: message }, { status: message.endsWith('_NOT_FOUND') ? 404 : 409 })
  }
}
