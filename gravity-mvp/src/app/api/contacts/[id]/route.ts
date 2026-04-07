import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { normalizePhoneE164 } from '@/lib/phoneUtils'

/**
 * GET /api/contacts/:id
 *
 * Полная карточка контакта: phones, identities, chats, driver, mergeHistory.
 * Spec: unified-contact-spec.md v1.1 §12.2 (API contracts)
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params

    const contact = await prisma.contact.findUnique({
      where: { id },
      include: {
        phones: {
          where: { isActive: true },
          orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
          select: {
            id: true,
            phone: true,
            label: true,
            isPrimary: true,
            source: true,
            isActive: true,
            verifiedAt: true,
            createdAt: true,
          },
        },
        identities: {
          where: { isActive: true },
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            channel: true,
            externalId: true,
            phoneId: true,
            displayName: true,
            source: true,
            confidence: true,
            isActive: true,
            createdAt: true,
            reachabilityStatus: true,
            reachabilityCheckedAt: true,
          },
        },
        chats: {
          orderBy: { lastMessageAt: 'desc' },
          select: {
            id: true,
            channel: true,
            externalChatId: true,
            contactIdentityId: true,
            lastMessageAt: true,
            unreadCount: true,
            status: true,
            name: true,
          },
        },
        mergesAsSurvivor: {
          orderBy: { createdAt: 'desc' },
          take: 10,
          select: {
            id: true,
            mergedId: true,
            action: true,
            mergedBy: true,
            reason: true,
            createdAt: true,
          },
        },
        mergesAsMerged: {
          orderBy: { createdAt: 'desc' },
          take: 10,
          select: {
            id: true,
            survivorId: true,
            action: true,
            mergedBy: true,
            reason: true,
            createdAt: true,
          },
        },
      },
    })

    if (!contact || contact.isArchived) {
      return NextResponse.json({ error: 'Contact not found' }, { status: 404 })
    }

    // Fetch Driver if linked
    let driver = null
    if (contact.yandexDriverId) {
      driver = await prisma.driver.findUnique({
        where: { yandexDriverId: contact.yandexDriverId },
        select: {
          id: true,
          fullName: true,
          phone: true,
          segment: true,
          score: true,
          lastOrderAt: true,
          hiredAt: true,
          dismissedAt: true,
        },
      })
    }

    const mergeHistory = [
      ...contact.mergesAsSurvivor.map(m => ({ ...m, role: 'survivor' as const })),
      ...contact.mergesAsMerged.map(m => ({ ...m, role: 'merged' as const })),
    ].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())

    return NextResponse.json({
      id: contact.id,
      displayName: contact.displayName,
      displayNameSource: contact.displayNameSource,
      masterSource: contact.masterSource,
      yandexDriverId: contact.yandexDriverId,
      primaryPhoneId: contact.primaryPhoneId,
      notes: contact.notes,
      tags: contact.tags,
      customFields: contact.customFields,
      isArchived: contact.isArchived,
      createdAt: contact.createdAt,
      updatedAt: contact.updatedAt,
      phones: contact.phones,
      identities: contact.identities,
      chats: contact.chats,
      driver,
      mergeHistory,
    })
  } catch (err: any) {
    console.error('[contacts/:id] GET Error:', err.message)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}

/**
 * PATCH /api/contacts/:id
 *
 * Обновляемые поля: displayName, primaryPhoneId, tags, notes, customFields.
 * displayName → displayNameSource = "manual".
 * masterSource и yandexDriverId НЕ редактируются.
 *
 * Spec: unified-contact-spec.md v1.1 §12.2
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const body = await req.json()

    const contact = await prisma.contact.findUnique({ where: { id } })
    if (!contact || contact.isArchived) {
      return NextResponse.json({ error: 'Contact not found' }, { status: 404 })
    }

    // Block immutable fields
    if ('masterSource' in body || 'yandexDriverId' in body) {
      return NextResponse.json(
        { error: 'IMMUTABLE_FIELD', message: 'masterSource and yandexDriverId cannot be changed via PATCH' },
        { status: 400 }
      )
    }

    const data: any = {}

    if ('displayName' in body && typeof body.displayName === 'string' && body.displayName.trim()) {
      data.displayName = body.displayName.trim()
      data.displayNameSource = 'manual'
    }

    if ('primaryPhoneId' in body) {
      if (body.primaryPhoneId) {
        // Validate phone belongs to this contact
        const phone = await prisma.contactPhone.findFirst({
          where: { id: body.primaryPhoneId, contactId: id, isActive: true },
        })
        if (!phone) {
          return NextResponse.json(
            { error: 'INVALID_PHONE_ID', message: 'Phone does not belong to this contact' },
            { status: 400 }
          )
        }
      }
      data.primaryPhoneId = body.primaryPhoneId || null
    }

    if ('tags' in body && Array.isArray(body.tags)) {
      data.tags = body.tags.filter((t: any) => typeof t === 'string')
    }

    if ('notes' in body) {
      data.notes = typeof body.notes === 'string' ? body.notes : null
    }

    if ('customFields' in body && typeof body.customFields === 'object') {
      data.customFields = body.customFields
    }

    if (Object.keys(data).length === 0) {
      return NextResponse.json(
        { error: 'NO_CHANGES', message: 'No valid fields to update' },
        { status: 400 }
      )
    }

    const updated = await prisma.contact.update({
      where: { id },
      data,
      select: {
        id: true,
        displayName: true,
        displayNameSource: true,
        masterSource: true,
        primaryPhoneId: true,
        tags: true,
        notes: true,
        customFields: true,
        updatedAt: true,
      },
    })

    return NextResponse.json(updated)
  } catch (err: any) {
    console.error('[contacts/:id] PATCH Error:', err.message)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
