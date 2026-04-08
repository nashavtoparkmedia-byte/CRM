import { NextRequest, NextResponse } from 'next/server'
import { ContactMergeService, MergeError } from '@/lib/ContactMergeService'

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
    const result = await ContactMergeService.mergeContactToContact(sourceId, targetId, mergedBy)
    return NextResponse.json(result)
  } catch (err: any) {
    if (err instanceof MergeError) {
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
