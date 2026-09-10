import { NextRequest, NextResponse } from 'next/server'

import { RECOVER_AUTOMATED_CONTACT_MERGE_COMMAND_V1 } from '@/contracts/contacts/v1'
import { mergeContactsV1 } from '@/infrastructure/contact-merge-composition'
import { contactOwnershipBusyResultV1 } from '@/modules/contacts/public/v1'
import {
  getIntegrationAdminPrincipal,
  isExactSameOriginMutationRequest,
} from '@/modules/identity-access/public/v1'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isExactSameOriginMutationRequest(request)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  const principal = await getIntegrationAdminPrincipal()
  if (!principal) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const { id } = await params
    const body = await request.json().catch(() => ({}))
    const result = await mergeContactsV1.recover({
      contract: RECOVER_AUTOMATED_CONTACT_MERGE_COMMAND_V1,
      mergeId: id,
      requestedBy: principal.id,
      basis: String(body.basis || 'operator requested automated merge recovery'),
    })
    return NextResponse.json(result, {
      status: result.status === 'recovered' || result.status === 'already_recovered' ? 200 : 409,
    })
  } catch (error: unknown) {
    const busy = contactOwnershipBusyResultV1(error)
    if (busy) {
      return NextResponse.json(busy, {
        status: 503,
        headers: { 'Retry-After': '2', 'Cache-Control': 'no-store' },
      })
    }
    throw error
  }
}
