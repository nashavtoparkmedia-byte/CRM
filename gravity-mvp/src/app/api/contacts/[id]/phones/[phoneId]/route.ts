import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

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
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; phoneId: string }> },
) {
  const { id: contactId, phoneId } = await params

  const phone = await prisma.contactPhone.findFirst({
    where: { id: phoneId, contactId, isActive: true },
  })
  if (!phone) {
    return NextResponse.json({ error: 'Phone not found' }, { status: 404 })
  }

  await prisma.$transaction(async (tx) => {
    await tx.contactPhone.update({
      where: { id: phoneId },
      data: { isActive: false, isPrimary: false },
    })
    // If we just removed the primary, clear it on the contact too.
    const contact = await tx.contact.findUnique({
      where: { id: contactId },
      select: { primaryPhoneId: true },
    })
    if (contact?.primaryPhoneId === phoneId) {
      await tx.contact.update({
        where: { id: contactId },
        data: { primaryPhoneId: null },
      })
    }
  })

  return NextResponse.json({ ok: true })
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; phoneId: string }> },
) {
  const { id: contactId, phoneId } = await params
  const body = await req.json().catch(() => ({}))

  const phone = await prisma.contactPhone.findFirst({
    where: { id: phoneId, contactId, isActive: true },
  })
  if (!phone) {
    return NextResponse.json({ error: 'Phone not found' }, { status: 404 })
  }

  if (typeof body.isPrimary === 'boolean' && body.isPrimary) {
    await prisma.$transaction(async (tx) => {
      await tx.contactPhone.updateMany({
        where: { contactId, isPrimary: true },
        data: { isPrimary: false },
      })
      await tx.contactPhone.update({
        where: { id: phoneId },
        data: { isPrimary: true },
      })
      await tx.contact.update({
        where: { id: contactId },
        data: { primaryPhoneId: phoneId },
      })
    })
  }

  const updated = await prisma.contactPhone.findUnique({
    where: { id: phoneId },
  })
  return NextResponse.json(updated)
}
