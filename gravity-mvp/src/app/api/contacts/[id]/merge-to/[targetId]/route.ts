import { NextRequest, NextResponse } from 'next/server'
import { MERGE_CONTACTS_COMMAND_V1 } from '@/contracts/contacts/v1'
import { ContactMergeErrorV1 } from '@/modules/contacts/public/v1'
import { mergeContactsV1 } from '@/app/contact-merge-composition'

/**
 * POST /api/contacts/:sourceId/merge-to/:targetId
 *
 * Merge source contact INTO target contact (contact-to-contact).
 * Source is archived. Target becomes survivor.
 *
 * Body (optional): { mergedBy?: string }
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; targetId: string }> },
) {
  const { id: sourceId, targetId } = await params

  let mergedBy = 'system'
  try {
    const body = await req.json()
    if (body.mergedBy) mergedBy = body.mergedBy
  } catch {
    // No body is fine — mergedBy defaults to 'system'
  }

  try {
    const result = await mergeContactsV1({
      contract: MERGE_CONTACTS_COMMAND_V1,
      operation: 'contact_to_contact',
      sourceId,
      targetId,
      mergedBy,
    })
    const { contract: _contract, ...legacyResult } = result
    return NextResponse.json(legacyResult)
  } catch (err: any) {
    if (err instanceof ContactMergeErrorV1) {
      const statusMap: Record<string, number> = {
        CONTACT_NOT_FOUND: 404,
        CONTACT_ARCHIVED: 409,
        SURVIVOR_ARCHIVED: 409,
        ALREADY_MERGED: 200,
        SELF_MERGE: 400,
        SOURCE_HAS_DRIVER: 409,
        INVALID_MERGE_STATE: 409,
      }
      const status = statusMap[err.code] || 500
      return NextResponse.json({ error: err.message, code: err.code }, { status })
    }
    console.error('[API merge-to] Error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
