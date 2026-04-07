import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { normalizePhoneE164 } from '@/lib/phoneUtils'

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
    const { phone: rawPhone, label, isPrimary } = body

    // Validate contact exists
    const contact = await prisma.contact.findUnique({ where: { id } })
    if (!contact || contact.isArchived) {
      return NextResponse.json({ error: 'Contact not found' }, { status: 404 })
    }

    // Normalize phone
    const normalized = normalizePhoneE164(rawPhone)
    if (!normalized) {
      return NextResponse.json(
        { error: 'INVALID_PHONE', message: 'Invalid phone number format' },
        { status: 400 }
      )
    }

    // Check duplicate within this contact
    const existingOwn = await prisma.contactPhone.findUnique({
      where: { contactId_phone: { contactId: id, phone: normalized } },
    })
    if (existingOwn) {
      return NextResponse.json(
        { error: 'PHONE_EXISTS', message: 'Phone already belongs to this contact' },
        { status: 409 }
      )
    }

    // Check if phone belongs to another contact
    const existingOther = await prisma.contactPhone.findFirst({
      where: { phone: normalized, isActive: true, contactId: { not: id } },
      include: { contact: { select: { id: true, displayName: true } } },
    })

    if (existingOther) {
      // Return warning with suggestMerge — do NOT auto-merge
      return NextResponse.json({
        warning: 'PHONE_BELONGS_TO_OTHER',
        message: 'Phone belongs to another contact',
        existingContact: {
          id: existingOther.contact.id,
          displayName: existingOther.contact.displayName,
        },
        suggestMerge: true,
        phone: normalized,
      })
    }

    // If isPrimary, unset other primaries
    if (isPrimary) {
      await prisma.contactPhone.updateMany({
        where: { contactId: id, isPrimary: true },
        data: { isPrimary: false },
      })
    }

    // Create phone
    const newPhone = await prisma.contactPhone.create({
      data: {
        contactId: id,
        phone: normalized,
        label: label || null,
        isPrimary: isPrimary || false,
        source: 'manual',
      },
    })

    // Update primaryPhoneId if this is primary
    if (isPrimary) {
      await prisma.contact.update({
        where: { id },
        data: { primaryPhoneId: newPhone.id },
      })
    }

    return NextResponse.json(newPhone, { status: 201 })
  } catch (err: any) {
    console.error('[contacts/:id/phones] POST Error:', err.message)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
