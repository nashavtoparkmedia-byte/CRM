import { NextRequest, NextResponse } from 'next/server'

import { searchContactsV1 } from '@/modules/contacts/public/v1'

/**
 * GET /api/contacts/lookup?q=...&limit=...
 *
 * The thin browser transport for ContactLookup.v1, so a Contacts client surface
 * can reach the capability. It owns no lookup semantics: it
 * passes the public query inputs through and returns ContactLookupResultV1
 * exactly as searchContactsV1 produced it. Query validity, the limit bounds,
 * ranking, ordering and the provider-neutral display all stay in Contacts.
 *
 * Like the legacy contact search it sits behind the CRM edge perimeter and adds
 * no application-level principal of its own: it is a read of provider-neutral
 * Contact rows, and every mutation it can lead to keeps its own authorization.
 */
export async function GET(req: NextRequest) {
  const query = req.nextUrl.searchParams.get('q')
  const limitParam = req.nextUrl.searchParams.get('limit')
  // A non-numeric limit is simply absent: the capability applies its default.
  const parsedLimit = limitParam === null || limitParam.trim() === '' ? undefined : Number(limitParam)
  const limit = parsedLimit !== undefined && Number.isFinite(parsedLimit) ? parsedLimit : undefined

  try {
    const result = await searchContactsV1({ query, limit })
    return NextResponse.json(result)
  } catch (err: unknown) {
    // The cause is logged, never returned: a lookup failure is not operator text.
    console.error('[contacts/lookup] Error:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
