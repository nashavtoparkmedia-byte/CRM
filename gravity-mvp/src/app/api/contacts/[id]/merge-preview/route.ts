import { NextRequest, NextResponse } from 'next/server'
import { CONTACT_MERGE_PREVIEW_QUERY_V1 } from '@/contracts/contacts/v1'
import { previewContactMergeV1, resolveContactReadAuthorityV1 } from '@/modules/contacts/public/v1'

/**
 * GET /api/contacts/{id}/merge-preview?target={otherContactId}
 *
 * The person card's merge dialog asks which Contact a manual merge of these two
 * would keep before the operator confirms (Contact Identity V2, Owner mandate
 * §7.1). The answer is the merge's own survivor policy over the two Contacts as
 * the merge loads them; nothing is merged, locked or written. Contacts' read
 * authority is asked first, as for every people read. Answers are never cached.
 */
const NO_STORE = { 'Cache-Control': 'no-store' }

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authority = await resolveContactReadAuthorityV1()
  if (authority.decision !== 'allow') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: NO_STORE })
  }
  const { id } = await params
  const target = req.nextUrl.searchParams.get('target')
  try {
    const result = await previewContactMergeV1({ contract: CONTACT_MERGE_PREVIEW_QUERY_V1, sourceContactId: id, targetContactId: target })
    return NextResponse.json(result, { headers: NO_STORE })
  } catch (error) {
    if (error instanceof Error && error.name === 'ContactMergePreviewQueryValidationError') {
      return NextResponse.json({ error: 'Bad Request' }, { status: 400, headers: NO_STORE })
    }
    console.error('[contacts/merge-preview] failed:', error instanceof Error ? error.name : 'unknown')
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500, headers: NO_STORE })
  }
}
