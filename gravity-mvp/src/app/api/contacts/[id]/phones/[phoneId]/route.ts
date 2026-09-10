import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { contactOwnershipBusyResultV1, manageContactPhoneEvidenceV1 } from '@/modules/contacts/public/v1'
import {
  getIntegrationAdminPrincipal,
  isExactSameOriginMutationRequest,
} from '@/modules/identity-access/public/v1'

/**
 * DELETE /api/contacts/:id/phones/:phoneId
 *
 * Soft-delete: marks the phone as inactive. We deliberately do NOT
 * hard-delete because:
 *   - Call rows reference this contact and historically dialled the phone;
 *     the journal should still surface them.
 *   - ContactIdentity rows may reference phoneId; orphaning those is fine
 *     (we just hide them in the active phones list).
 *
 * Returns 404 if either the contact or the phone don't exist (or already
 * inactive), 200 with `{ ok: true }` otherwise.
 *
 * PATCH /api/contacts/:id/phones/:phoneId
 *
 * Tweak phone metadata. Today only supports `isPrimary`, which is the most
 * common UX operation ("star this number"). Setting isPrimary:true also
 * demotes any other primary on the same contact and updates Contact.primaryPhoneId.
 */

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; phoneId: string }> },
) {
  if (!isExactSameOriginMutationRequest(req)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  const principal = await getIntegrationAdminPrincipal()
  if (!principal) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const { id: contactId, phoneId } = await params

    const result = await manageContactPhoneEvidenceV1({
      operation: 'set_state',
      contactId,
      phoneId,
      actor: principal.id,
      basis: 'manual removal',
      lifecycle: 'removed',
      freshness: 'stale',
    })
    return NextResponse.json({ ok: true, auditId: result.auditId })
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

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; phoneId: string }> },
) {
  if (!isExactSameOriginMutationRequest(req)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  const principal = await getIntegrationAdminPrincipal()
  if (!principal) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const { id: contactId, phoneId } = await params
    const body = await req.json().catch(() => ({}))

    await manageContactPhoneEvidenceV1({
      operation: 'set_state',
      contactId,
      phoneId,
      actor: principal.id,
      basis: String(body.basis || 'manual phone update'),
      ...(typeof body.lifecycle === 'string' ? { lifecycle: body.lifecycle } : {}),
      ...(typeof body.freshness === 'string' ? { freshness: body.freshness } : {}),
      ...(typeof body.resolutionState === 'string' ? { resolutionState: body.resolutionState } : {}),
      makePrimary: body.isPrimary === true,
    })

    const updated = await prisma.contactPhone.findUnique({
      where: { id: phoneId },
    })
    return NextResponse.json(updated)
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
