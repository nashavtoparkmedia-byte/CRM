import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import {
  matchesDriverProfileSearch,
  rankDriverProfileSearchResults,
  toDriverSearchResult,
} from '@/lib/driver-profile-search'
import { normalizeContactPhoneDigits } from '@/lib/contact-search'

const MIN_QUERY_LENGTH = 2
const MAX_RESULTS = 50
const DEFAULT_LIMIT = 20

/**
 * GET /api/drivers-search?q=...
 *
 * Searches the local, synchronized DriverProfile catalogue across every park.
 * It never sends an operator's query to Yandex and never picks a park based on
 * connection creation order. The returned `id` remains the existing DriverProfile
 * id so legacy Telegram manual binding stays backward-compatible.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const query = searchParams.get('q')?.trim() || ''
  const requestedLimit = Number.parseInt(searchParams.get('limit') || '', 10)
  const limit = Number.isFinite(requestedLimit)
    ? Math.min(Math.max(requestedLimit, 1), MAX_RESULTS)
    : DEFAULT_LIMIT

  if (query.length < MIN_QUERY_LENGTH) {
    return NextResponse.json({ drivers: [], total: 0 })
  }

  try {
    const candidateLimit = Math.min(Math.max(limit * 10, 100), 500)
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
      take: candidateLimit,
    })

    const ranked = rankDriverProfileSearchResults(
      profiles.filter(profile => matchesDriverProfileSearch(profile, query)),
      query,
    )
    const drivers = ranked.slice(0, limit).map(toDriverSearchResult)

    return NextResponse.json({ drivers, total: drivers.length })
  } catch (error: unknown) {
    console.error('[drivers-search] local DriverProfile search failed', error)
    return NextResponse.json({ error: 'Не удалось выполнить поиск водителей' }, { status: 500 })
  }
}
