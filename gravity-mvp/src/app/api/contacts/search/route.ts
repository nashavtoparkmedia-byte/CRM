import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { stripToDigits } from '@/lib/phoneUtils'

/**
 * GET /api/contacts/search?q=...&limit=10
 *
 * Поиск контактов по ФИО, номеру телефона или externalId.
 * Определяет тип ввода автоматически:
 *   - только цифры/+/()- пробелы → поиск по phone
 *   - иначе → поиск по displayName
 *   - параллельно: поиск по ContactIdentity.externalId (prefix)
 *
 * Spec: unified-contact-spec.md v1.1 §7.7, AC SR-01..SR-08
 */
export async function GET(req: NextRequest) {
  try {
    const q = req.nextUrl.searchParams.get('q')?.trim()
    const limitParam = req.nextUrl.searchParams.get('limit')
    const limit = Math.min(Math.max(parseInt(limitParam || '10', 10) || 10, 1), 50)

    if (!q || q.length < 2) {
      return NextResponse.json({ contacts: [], total: 0 })
    }

    const isPhoneQuery = /^[\d\s\+\-\(\)]+$/.test(q)
    const digits = stripToDigits(q)

    const contactIds = new Set<string>()
    const results: any[] = []

    // ── Phone search ──────────────────────────────────────────
    if (isPhoneQuery && digits.length >= 3) {
      const phoneMatches = await prisma.contactPhone.findMany({
        where: {
          phone: { contains: digits },
          isActive: true,
          contact: { isArchived: false },
        },
        include: {
          contact: {
            select: { id: true, displayName: true, masterSource: true, yandexDriverId: true, isArchived: true },
          },
        },
        take: limit,
      })

      for (const pm of phoneMatches) {
        if (!contactIds.has(pm.contact.id)) {
          contactIds.add(pm.contact.id)
          results.push(pm.contact.id)
        }
      }
    }

    // ── Name search ───────────────────────────────────────────
    if (!isPhoneQuery && q.length >= 2) {
      const nameMatches = await prisma.contact.findMany({
        where: {
          displayName: { contains: q, mode: 'insensitive' },
          isArchived: false,
        },
        select: { id: true },
        take: limit,
      })

      for (const nm of nameMatches) {
        if (!contactIds.has(nm.id)) {
          contactIds.add(nm.id)
          results.push(nm.id)
        }
      }
    }

    // ── ExternalId search (parallel, both query types) ────────
    if (q.length >= 3) {
      const identityMatches = await prisma.contactIdentity.findMany({
        where: {
          externalId: { startsWith: q },
          isActive: true,
          contact: { isArchived: false },
        },
        select: { contactId: true },
        take: limit,
      })

      for (const im of identityMatches) {
        if (!contactIds.has(im.contactId)) {
          contactIds.add(im.contactId)
          results.push(im.contactId)
        }
      }
    }

    // ── Hydrate contacts ──────────────────────────────────────
    const uniqueIds = results.slice(0, limit)

    if (uniqueIds.length === 0) {
      return NextResponse.json({ contacts: [], total: 0 })
    }

    const contacts = await prisma.contact.findMany({
      where: { id: { in: uniqueIds } },
      select: {
        id: true,
        displayName: true,
        masterSource: true,
        yandexDriverId: true,
        phones: {
          where: { isActive: true },
          select: { id: true, phone: true, isPrimary: true, source: true },
          orderBy: { isPrimary: 'desc' },
        },
        identities: {
          where: { isActive: true },
          select: { id: true, channel: true, externalId: true },
        },
        chats: {
          select: { id: true, channel: true, lastMessageAt: true },
          orderBy: { lastMessageAt: 'desc' },
          take: 5,
        },
      },
    })

    // Find additional chats linked via Driver (same phone number)
    // Contact.chats only includes chats with matching contactId,
    // but TG/other chats may be linked via driverId (same phone → same Driver)
    const contactPhones = new Map<string, string[]>() // contactId → phones
    for (const c of contacts) {
      const phones = c.phones.map(p => p.phone.replace(/\D/g, ''))
      if (phones.length > 0) contactPhones.set(c.id, phones)
    }

    // Batch: find chats via driverId where driver.phone matches contact phones
    const allPhones = [...new Set([...contactPhones.values()].flat())]
    const driverChats = allPhones.length > 0
      ? await prisma.chat.findMany({
          where: {
            driver: { phone: { in: allPhones.map(p => p.startsWith('7') ? `+${p}` : `+7${p}`) } },
            chatType: 'private',
          },
          select: { id: true, channel: true, driverId: true, driver: { select: { phone: true } } },
        })
      : []

    // Map driver chats to contacts by phone
    const driverChatsByPhone = new Map<string, typeof driverChats>()
    for (const dc of driverChats) {
      const normPhone = dc.driver?.phone?.replace(/\D/g, '') || ''
      if (!driverChatsByPhone.has(normPhone)) driverChatsByPhone.set(normPhone, [])
      driverChatsByPhone.get(normPhone)!.push(dc)
    }

    // Build hasChat map per contact
    const formatted = contacts.map(c => {
      // Direct chats (via contactId)
      const hasChat = c.chats.reduce((acc, ch) => {
        if (!acc[ch.channel]) acc[ch.channel] = ch.id
        return acc
      }, {} as Record<string, string>)

      // Additional chats via driver phone
      const phones = contactPhones.get(c.id) || []
      for (const phone of phones) {
        const extraChats = driverChatsByPhone.get(phone) || []
        for (const dc of extraChats) {
          if (!hasChat[dc.channel]) hasChat[dc.channel] = dc.id
        }
      }

      return {
        id: c.id,
        displayName: c.displayName,
        masterSource: c.masterSource,
        phones: c.phones,
        identities: c.identities,
        hasChat,
        channels: [...new Set([
          ...c.identities.map(i => i.channel),
          ...Object.keys(hasChat),
        ])],
      }
    })

    // Preserve search result order
    const orderMap = new Map(uniqueIds.map((id, i) => [id, i]))
    formatted.sort((a, b) => (orderMap.get(a.id) ?? 99) - (orderMap.get(b.id) ?? 99))

    return NextResponse.json({ contacts: formatted, total: formatted.length })
  } catch (err: any) {
    console.error('[contacts/search] Error:', err.message)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
