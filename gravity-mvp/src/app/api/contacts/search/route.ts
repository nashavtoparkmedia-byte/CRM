import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { buildCanonicalContactSummary } from '@/lib/contact-display'
import {
  expandContactSearchTextVariants,
  isPhoneLikeContactSearch,
  MIN_CONTACT_PHONE_SEARCH_DIGITS,
  normalizeContactPhoneDigits,
  normalizeContactSearchText,
} from '@/lib/contact-search'
import { normalizeTelegramUsername } from '@/lib/telegram-identity-metadata'

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

    const isPhoneQuery = isPhoneLikeContactSearch(q)
    const digits = normalizeContactPhoneDigits(q)
    const nameTokens = isPhoneQuery ? [] : normalizeContactSearchText(q).split(' ').filter(Boolean)
    const candidateLimit = isPhoneQuery ? limit : Math.min(Math.max(limit * 8, 50), 200)

    const contactIds = new Set<string>()
    const results: string[] = []

    // ── Stable Telegram identity search ───────────────────────
    // Username is mutable and therefore never used as an identity key.
    // Current username ranks above historical observations; telegramUserId
    // and ContactIdentity.externalId remain the stable lookup keys.
    const telegramQuery = normalizeTelegramUsername(q)
    const telegramIdQuery = /^\d{5,}$/.test(q) ? q : null
    if ((telegramQuery && !isPhoneQuery && telegramQuery.length >= 2) || telegramIdQuery) {
      const telegramMatches = await prisma.$queryRaw<Array<{ contactId: string; matchRank: number }>>(Prisma.sql`
        SELECT identity."contactId",
          CASE
            WHEN identity."externalId" = ${telegramIdQuery || ''} THEN 0
            WHEN identity.metadata->>'telegramUserId' = ${telegramIdQuery || ''} THEN 0
            WHEN lower(COALESCE(identity.metadata->>'username', '')) = ${telegramQuery || ''} THEN 1
            WHEN lower(COALESCE(identity.metadata->>'username', '')) LIKE ${`${telegramQuery || ''}%`} THEN 2
            WHEN lower(COALESCE(identity.metadata->>'lastObservedUsername', '')) = ${telegramQuery || ''} THEN 3
            WHEN EXISTS (
              SELECT 1
              FROM jsonb_array_elements(
                CASE
                  WHEN jsonb_typeof(identity.metadata->'usernameHistory') = 'array'
                    THEN identity.metadata->'usernameHistory'
                  ELSE '[]'::jsonb
                END
              ) history
              WHERE lower(COALESCE(history->>'username', '')) = ${telegramQuery || ''}
            ) THEN 4
            ELSE 5
          END AS "matchRank"
        FROM "ContactIdentity" identity
        JOIN "Contact" contact ON contact.id = identity."contactId"
        WHERE identity.channel = 'telegram'
          AND identity."isActive" = true
          AND contact."isArchived" = false
          AND (
            identity."externalId" = ${telegramIdQuery || ''}
            OR identity.metadata->>'telegramUserId' = ${telegramIdQuery || ''}
            OR lower(COALESCE(identity.metadata->>'username', '')) LIKE ${`%${telegramQuery || ''}%`}
            OR lower(COALESCE(identity.metadata->>'lastObservedUsername', '')) LIKE ${`%${telegramQuery || ''}%`}
            OR EXISTS (
              SELECT 1
              FROM jsonb_array_elements(
                CASE
                  WHEN jsonb_typeof(identity.metadata->'usernameHistory') = 'array'
                    THEN identity.metadata->'usernameHistory'
                  ELSE '[]'::jsonb
                END
              ) history
              WHERE lower(COALESCE(history->>'username', '')) LIKE ${`%${telegramQuery || ''}%`}
            )
          )
        ORDER BY "matchRank", identity."contactId"
        LIMIT ${candidateLimit}
      `)

      for (const match of telegramMatches) {
        if (!contactIds.has(match.contactId)) {
          contactIds.add(match.contactId)
          results.push(match.contactId)
        }
      }
    }

    // ── Phone search ──────────────────────────────────────────
    if (isPhoneQuery && digits.length >= MIN_CONTACT_PHONE_SEARCH_DIGITS) {
      const phoneMatches = await prisma.$queryRaw<Array<{ contactId: string }>>(Prisma.sql`
        WITH source_phones AS (
          SELECT phone."contactId", regexp_replace(COALESCE(phone.phone, ''), '[^0-9]', '', 'g') AS "phoneDigits"
          FROM "ContactPhone" phone
          WHERE phone."isActive" = true
          UNION ALL
          SELECT driver."contactId", regexp_replace(COALESCE(driver.phone, ''), '[^0-9]', '', 'g') AS "phoneDigits"
          FROM "Driver" driver
          WHERE driver."contactId" IS NOT NULL AND driver.phone IS NOT NULL
        ), normalized_phones AS (
          SELECT "contactId",
            CASE
              WHEN "phoneDigits" ~ '^8[0-9]{10}$' THEN '7' || substring("phoneDigits" FROM 2)
              WHEN "phoneDigits" ~ '^[0-9]{10}$' THEN '7' || "phoneDigits"
              ELSE "phoneDigits"
            END AS "normalizedPhone"
          FROM source_phones
        )
        SELECT DISTINCT normalized."contactId"
        FROM normalized_phones normalized
        JOIN "Contact" contact ON contact.id = normalized."contactId"
        WHERE contact."isArchived" = false
          AND normalized."normalizedPhone" LIKE ${`%${digits}%`}
        LIMIT ${limit}
      `)

      for (const pm of phoneMatches) {
        if (!contactIds.has(pm.contactId)) {
          contactIds.add(pm.contactId)
          results.push(pm.contactId)
        }
      }
    }

    // ── Name search ───────────────────────────────────────────
    if (!isPhoneQuery && q.length >= 2) {
      const tokenFilters = nameTokens.map(token => {
        const variants = expandContactSearchTextVariants(token)
        return Prisma.sql`(${Prisma.join(
          variants.map(variant => Prisma.sql`searchable."searchText" LIKE ${`%${variant}%`}`),
          ' OR ',
        )})`
      })

      const nameMatches = tokenFilters.length > 0
        ? await prisma.$queryRaw<Array<{ contactId: string }>>(Prisma.sql`
          WITH searchable AS (
            SELECT contact.id AS "contactId",
              replace(lower(concat_ws(' ',
                contact."displayName",
                string_agg(DISTINCT identity."displayName", ' '),
                string_agg(DISTINCT driver."fullName", ' '),
                max(main_driver."fullName")
              )), 'ё', 'е') AS "searchText"
            FROM "Contact" contact
            LEFT JOIN "ContactIdentity" identity
              ON identity."contactId" = contact.id AND identity."isActive" = true
            LEFT JOIN "Driver" driver
              ON driver."contactId" = contact.id
            LEFT JOIN "Driver" main_driver
              ON main_driver.id = contact."mainDriverId"
            WHERE contact."isArchived" = false
            GROUP BY contact.id
          )
          SELECT searchable."contactId"
          FROM searchable
          WHERE ${Prisma.join(tokenFilters, ' AND ')}
          LIMIT ${candidateLimit}
        `)
        : []

      for (const nm of nameMatches) {
        if (!contactIds.has(nm.contactId)) {
          contactIds.add(nm.contactId)
          results.push(nm.contactId)
        }
      }
    }

    // ── ExternalId search (parallel, both query types) ────────
    if ((!isPhoneQuery && q.length >= 3)
      || (isPhoneQuery && digits.length >= MIN_CONTACT_PHONE_SEARCH_DIGITS)) {
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

      const profileMatches = await prisma.driver.findMany({
        where: {
          externalDriverProfileId: { startsWith: q, mode: 'insensitive' },
          contactId: { not: null },
          contact: { isArchived: false },
        },
        select: { contactId: true },
        take: limit,
      })

      for (const match of profileMatches) {
        if (match.contactId && !contactIds.has(match.contactId)) {
          contactIds.add(match.contactId)
          results.push(match.contactId)
        }
      }
    }

    // ── Hydrate contacts ──────────────────────────────────────
    const uniqueIds = results.slice(0, candidateLimit)

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
        primaryPhoneId: true,
        mainDriverId: true,
        phones: {
          where: { isActive: true },
          select: { id: true, phone: true, isPrimary: true, source: true },
          orderBy: { isPrimary: 'desc' },
        },
        identities: {
          where: { isActive: true },
          select: {
            id: true,
            channel: true,
            externalId: true,
            displayName: true,
            metadata: true,
            reachabilityStatus: true,
          },
        },
        chats: {
          select: { id: true, channel: true, lastMessageAt: true },
          orderBy: { lastMessageAt: 'desc' },
          take: 5,
        },
        driverProfiles: {
          select: {
            id: true,
            fullName: true,
            phone: true,
            segment: true,
            dismissedAt: true,
            lastExternalPark: true,
          },
        },
      },
    })

    // Find additional chats linked via Driver (same phone number)
    // Contact.chats only includes chats with matching contactId,
    // but TG/other chats may be linked via driverId (same phone → same Driver)
    const contactPhones = new Map<string, string[]>() // contactId → phones
    for (const c of contacts) {
      const phones = c.phones.map(p => normalizeContactPhoneDigits(p.phone))
      if (phones.length > 0) contactPhones.set(c.id, phones)
    }

    // Batch: find chats via driverId where driver.phone matches contact phones
    const allPhones = [...new Set([...contactPhones.values()].flat())]
    const driverChats = allPhones.length > 0
      ? await prisma.chat.findMany({
          where: {
            driver: { phone: { in: allPhones.map(phone => `+${phone}`) } },
            chatType: 'private',
          },
          select: { id: true, channel: true, driverId: true, driver: { select: { phone: true } } },
        })
      : []

    // Map driver chats to contacts by phone
    const driverChatsByPhone = new Map<string, typeof driverChats>()
    for (const dc of driverChats) {
      const normPhone = normalizeContactPhoneDigits(dc.driver?.phone)
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

      const providerChannels = [...new Set([
        ...c.identities.map(identity => identity.channel),
        ...Object.keys(hasChat),
      ])]
      const canonicalSummary = buildCanonicalContactSummary({
        contact: c,
        profiles: c.driverProfiles,
        currentChannel: c.chats[0]?.channel || null,
        providerChannels,
      })

      return {
        id: c.id,
        displayName: canonicalSummary.displayName,
        masterSource: c.masterSource,
        phones: c.phones,
        identities: c.identities,
        hasChat,
        channels: providerChannels,
        mainDriverProfileId: c.mainDriverId ?? c.driverProfiles[0]?.id ?? null,
        canonicalSummary,
      }
    })

    // Preserve search result order, but rank canonical CRM contacts above provider-only rows.
    const orderMap = new Map(uniqueIds.map((id, i) => [id, i]))
    formatted.sort((a, b) => {
      if (!isPhoneQuery) {
        const strengthDiff = canonicalContactStrength(b) - canonicalContactStrength(a)
        if (strengthDiff !== 0) return strengthDiff
      }

      return (orderMap.get(a.id) ?? 99) - (orderMap.get(b.id) ?? 99)
    })

    const visibleFormatted = isPhoneQuery
      ? formatted
      : preferCanonicalContactRows(formatted, nameTokens)

    const limitedFormatted = visibleFormatted.slice(0, limit)

    return NextResponse.json({ contacts: limitedFormatted, total: limitedFormatted.length })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[contacts/search] Error:', message)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}

interface SearchResultForDedupe {
  id: string
  displayName?: string | null
  phones?: unknown[]
  canonicalSummary?: {
    displayName?: string | null
    displayTitle?: string | null
    primaryPhone?: string | null
    currentMainDriverProfile?: { id?: string | null } | null
  } | null
}

function preferCanonicalContactRows<T extends SearchResultForDedupe>(rows: T[], tokens: string[]): T[] {
  const strongBySurname = new Map<string, T>()

  for (const row of rows) {
    const surname = getSearchSurname(row)
    if (!surname || !tokens.some(token => token.length >= 3 && surname.startsWith(token))) continue
    if (!hasCanonicalContactStrength(row)) continue

    const current = strongBySurname.get(surname)
    if (!current || canonicalContactStrength(row) > canonicalContactStrength(current)) {
      strongBySurname.set(surname, row)
    }
  }

  if (strongBySurname.size === 0) return rows

  return rows.filter(row => {
    const surname = getSearchSurname(row)
    if (!surname || !tokens.some(token => token.length >= 3 && surname.startsWith(token))) return true

    const strong = strongBySurname.get(surname)
    if (!strong || row.id === strong.id || hasCanonicalContactStrength(row)) return true

    return false
  })
}

function getSearchSurname(row: SearchResultForDedupe): string {
  return normalizeContactSearchText(
    row.canonicalSummary?.currentMainDriverProfile?.id
      ? row.canonicalSummary.displayName
      : row.canonicalSummary?.displayName || row.displayName,
  ).split(' ')[0] || ''
}

function hasCanonicalContactStrength(row: SearchResultForDedupe): boolean {
  return canonicalContactStrength(row) > 0
}

function canonicalContactStrength(row: SearchResultForDedupe): number {
  let score = 0
  if ((row.phones || []).length > 0) score += 2
  if (row.canonicalSummary?.primaryPhone) score += 2
  if (row.canonicalSummary?.currentMainDriverProfile?.id) score += 3
  return score
}
