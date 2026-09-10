import { NextRequest, NextResponse } from 'next/server'
import { ContactMergeService, MergeError } from '@/lib/ContactMergeService'
import {
  getIntegrationAdminPrincipal,
  isExactSameOriginMutationRequest,
} from '@/modules/identity-access/public/v1'

/**
 * POST /api/contacts/:sourceId/merge-to/:targetId
 *
 * Merge source contact INTO target contact (contact-to-contact).
 * Source is archived. Target becomes survivor.
 *
 * The audit actor is derived from the verified integration-admin session.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; targetId: string }> },
) {
  if (!isExactSameOriginMutationRequest(req)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  const principal = await getIntegrationAdminPrincipal()
  if (!principal) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { id: sourceId, targetId } = await params

  try {
    const result = await ContactMergeService.mergeContactToContact(sourceId, targetId, principal.id)
    return NextResponse.json(result)
  } catch (err: unknown) {
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
