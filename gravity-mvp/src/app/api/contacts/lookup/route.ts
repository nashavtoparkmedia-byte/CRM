import { NextRequest, NextResponse } from 'next/server'
import { resolveContactReadAuthorityV1, searchContactsV1 } from '@/modules/contacts/public/v1'

/**
 * GET /api/contacts/lookup?q=...&limit=...
 *
 * The thin browser transport for ContactLookup.v1, so the «Люди» search can
 * reach the capability. It owns no lookup semantics: it passes the public query
 * inputs through and returns ContactLookupResultV1 exactly as searchContactsV1
 * produced it. Query validity, the limit bounds, ranking, ordering and the
 * provider-neutral display all stay in Contacts.
 *
 * Unlike the legacy contact search it requires Contacts' read authority
 * (ContactReadAuthorityQuery.v1), the same answer the person card uses: a lookup
 * result names people, so it is answered only to a caller who may open the card
 * it leads to: a verified Staff Session employee or, transitionally, the
 * integration-admin session. `crm_user_id` is never consulted.
 */
export async function GET(req: NextRequest) {
  const authority = await resolveContactReadAuthorityV1()
  if (authority.decision !== 'allow') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
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
