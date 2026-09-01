import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { normalizePhoneE164 } from '@/modules/contacts/public/v1/phone-identity'
import { contactOwnershipBusyResultV1 } from '@/modules/contacts/public/v1'
import { manageContactPhoneEvidenceV1 } from '@/modules/contacts/public/v1'

/**
 * POST /api/contacts/:id/phones
 *
 * Добавить телефон к контакту.
 * Нормализация в E.164, проверка дублей, warning если номер у другого Contact.
 *
 * Spec: unified-contact-spec.md v1.1 §12.2 (API contracts)
 *
 * Errors:
 *   INVALID_PHONE — невалидный формат
 *   PHONE_EXISTS — уже есть у этого контакта
 *   PHONE_BELONGS_TO_OTHER — есть у другого контакта (+ suggestMerge)
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const body = await req.json()
    const { phone: rawPhone, isPrimary, actor, basis, resolutionState } = body

    // Normalize phone
    const normalized = normalizePhoneE164(rawPhone)
    if (!normalized) {
      return NextResponse.json(
        { error: 'INVALID_PHONE', message: 'Invalid phone number format' },
        { status: 400 }
      )
    }

    const result = await manageContactPhoneEvidenceV1({
      operation: 'add_or_verify',
      contactId: id,
      rawPhone,
      actor: String(actor || req.headers.get('x-crm-user-id') || 'operator:unknown'),
      basis: String(basis || 'manual phone management'),
      makePrimary: isPrimary === true,
      resolutionState: ['unique', 'shared', 'disputed'].includes(resolutionState)
        ? resolutionState
        : 'unique',
    })
    const newPhone = await prisma.contactPhone.findUnique({
      where: { id: result.phoneId },
    })

    return NextResponse.json(newPhone, { status: 201 })
  } catch (err: any) {
    const busy = contactOwnershipBusyResultV1(err)
    if (busy) {
      return NextResponse.json(busy, {
        status: 503,
        headers: { 'Retry-After': '2', 'Cache-Control': 'no-store' },
      })
    }
    if (err?.code === 'CONTACT_NOT_FOUND') {
      return NextResponse.json({ error: 'Contact not found' }, { status: 404 })
    }
    if (err?.message === 'PHONE_BELONGS_TO_OTHER') {
      return NextResponse.json({
        warning: 'PHONE_BELONGS_TO_OTHER',
        message: 'Phone belongs to another contact; mark it shared/disputed or reconcile manually',
        suggestMerge: true,
      }, { status: 409 })
    }
    console.error('[contacts/:id/phones] POST Error:', err.message)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
