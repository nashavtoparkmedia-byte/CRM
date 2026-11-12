import { NextRequest, NextResponse } from 'next/server'
import { isExactSameOriginMutationRequest, isJsonMutationRequest } from '@/modules/identity-access/public/v1'
import { searchPeopleByExactLicenceV1 } from '@/modules/platform-shell/public/v1'

/**
 * POST /contacts/licence-search   body: { "licence": "<full ВУ>" }
 *
 * The browser transport of the «Люди» search by an exact driving licence (ВУ)
 * (Owner D2, OD-03). The licence travels in the body, never in the URL, so it
 * does not land in access logs, history or a Referer. It lives beside the
 * «Люди» pages, not under /api/contacts, because it composes two contexts
 * (Contacts and Fleet) through platform-shell, which Contacts itself may not
 * import. The platform-shell
 * composition asks Contacts' read authority first and Fleet only after it
 * allows; every reader role may search, and the ВУ in the answer is masked on
 * the server for the caller's view.
 *
 * The typed licence is never echoed: no answer, error or log line carries it.
 * A too-short value is answered exactly like a licence nobody holds.
 */
const NO_STORE = { 'Cache-Control': 'no-store' }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export async function POST(req: NextRequest) {
  if (!isExactSameOriginMutationRequest(req) || !isJsonMutationRequest(req)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403, headers: NO_STORE })
  }
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Bad Request' }, { status: 400, headers: NO_STORE })
  }
  const result = await searchPeopleByExactLicenceV1(isRecord(body) ? body.licence : undefined)
  switch (result.status) {
    case 'denied':
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: NO_STORE })
    case 'invalid':
      return NextResponse.json({ error: 'Bad Request' }, { status: 400, headers: NO_STORE })
    case 'unavailable':
      return NextResponse.json({ error: 'Service Unavailable' }, { status: 503, headers: NO_STORE })
    case 'answered':
      return NextResponse.json({ profiles: result.profiles, truncated: result.truncated }, { headers: NO_STORE })
  }
}
