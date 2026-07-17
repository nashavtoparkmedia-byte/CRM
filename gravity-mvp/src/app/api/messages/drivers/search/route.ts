import { NextResponse } from 'next/server'

import { normalizeContactPhoneDigits } from '@/lib/contact-search'
import {
  matchesDriverProfileSearch,
  rankDriverProfileSearchResults,
  toDriverSearchResult,
} from '@/lib/driver-profile-search'
import { prisma } from '@/lib/prisma'

const MAX_RESULTS = 20

type LegacyDriverSearchResult = {
  id: string
  fullName: string
  phone: string | null
  segment: string
  profileId: string | null
  contactId: string | null
  status: string
}

/**
 * Compatibility endpoint for the legacy Messenger component.
 * It keeps the historical array response, but searches the same local,
 * multi-park DriverProfile catalogue as /api/drivers-search.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const query = searchParams.get('q')?.trim() || ''
  if (query.length < 2) return NextResponse.json([])

  try {
    const phoneDigits = normalizeContactPhoneDigits(query)
    const profiles = await prisma.driver.findMany({
      where: {
        OR: [
          { fullName: { contains: query, mode: 'insensitive' } },
          { phone: { contains: query } },
          ...(phoneDigits.length >= 4 ? [{ phone: { contains: phoneDigits } }] : []),
          { yandexDriverId: { contains: query, mode: 'insensitive' } },
          { externalDriverProfileId: { contains: query, mode: 'insensitive' } },
          { externalPersonKey: { contains: query, mode: 'insensitive' } },
        ],
      },
      select: {
        id: true,
        fullName: true,
        phone: true,
        yandexDriverId: true,
        externalDriverProfileId: true,
        externalParkId: true,
        externalPersonKey: true,
        dismissedAt: true,
        contactId: true,
        park: { select: { id: true, parkCode: true, parkName: true } },
      },
      take: 200,
    })
    const drivers: LegacyDriverSearchResult[] = rankDriverProfileSearchResults(
      profiles.filter(profile => matchesDriverProfileSearch(profile, query)),
      query,
    ).slice(0, MAX_RESULTS).map(profile => {
      const result = toDriverSearchResult(profile)
      return {
        id: result.id,
        fullName: result.fullName,
        phone: result.phone,
        segment: result.park?.parkName || 'Профиль водителя',
        profileId: result.profileId,
        contactId: result.contactId,
        status: result.status,
      }
    })

    // The legacy modal needs a deliberate "new contact" affordance for a full
    // phone number. It is not a synthetic DriverProfile and start-chat handles
    // it as a Contact-only flow.
    if (phoneDigits.length >= 10 && !drivers.some(driver => normalizeContactPhoneDigits(driver.phone) === phoneDigits)) {
      drivers.push({
        id: `unsaved_${phoneDigits}`,
        fullName: 'Новый контакт',
        phone: query,
        segment: 'Новый Contact',
        profileId: null,
        contactId: null,
        status: 'new',
      })
    }

    return NextResponse.json(drivers)
  } catch (error: unknown) {
    console.error('[API-DRIVERS-SEARCH] local DriverProfile search failed', error)
    return NextResponse.json({ error: 'Не удалось выполнить поиск водителей' }, { status: 500 })
  }
}
