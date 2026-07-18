import { NextRequest, NextResponse } from 'next/server'

import { ContactMergeService, MergeError } from '@/lib/ContactMergeService'
import { getCurrentUser } from '@/lib/users/user-service'

type MergeExecuteBody = {
  planHash?: unknown
  sourceVersion?: unknown
  targetVersion?: unknown
  confirmationToken?: unknown
}

function mergeErrorResponse(error: MergeError) {
  const statusMap: Record<MergeError['code'], number> = {
    CONTACT_NOT_FOUND: 404,
    DRIVER_NOT_FOUND: 404,
    CONTACT_ARCHIVED: 409,
    SURVIVOR_ARCHIVED: 409,
    SELF_MERGE: 400,
    DRIVER_PROFILE_NOT_ACTIVE: 409,
    MERGE_CONFIRMATION_REQUIRED: 409,
    MERGE_BLOCKED: 409,
    STALE_MERGE_PLAN: 409,
    INVALID_CONFIRMATION_TOKEN: 403,
    ACTOR_MISMATCH: 403,
  }
  return NextResponse.json(
    { error: error.message, code: error.code, details: error.details ?? null },
    { status: statusMap[error.code] },
  )
}

/**
 * GET /api/contacts/:sourceId/merge-to/:targetId
 *
 * Read-only merge preview bound to the authenticated CRM actor.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; targetId: string }> },
) {
  const actor = await getCurrentUser()
  if (!actor) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const { id: sourceId, targetId } = await params
  try {
    const preview = await ContactMergeService.previewContactMerge(sourceId, targetId, actor.id)
    return NextResponse.json(preview)
  } catch (error) {
    if (error instanceof MergeError) return mergeErrorResponse(error)
    console.error('[API merge-to preview] Unexpected error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

/**
 * POST /api/contacts/:sourceId/merge-to/:targetId
 *
 * Executes exactly the signed preview. The actor is always resolved from the
 * CRM cookie; mergedBy is deliberately not accepted from the request body.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; targetId: string }> },
) {
  const actor = await getCurrentUser()
  if (!actor) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const { id: sourceId, targetId } = await params
  let body: MergeExecuteBody
  try {
    body = await req.json() as MergeExecuteBody
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  if (
    typeof body.planHash !== 'string'
    || typeof body.sourceVersion !== 'string'
    || typeof body.targetVersion !== 'string'
    || typeof body.confirmationToken !== 'string'
  ) {
    return NextResponse.json({
      error: 'Merge preview is required',
      code: 'MERGE_CONFIRMATION_REQUIRED',
    }, { status: 409 })
  }

  try {
    const result = await ContactMergeService.executeContactMerge({
      sourceId,
      targetId,
      actorId: actor.id,
      planHash: body.planHash,
      sourceVersion: body.sourceVersion,
      targetVersion: body.targetVersion,
      confirmationToken: body.confirmationToken,
    })
    return NextResponse.json(result)
  } catch (error) {
    if (error instanceof MergeError) return mergeErrorResponse(error)
    console.error('[API merge-to execute] Unexpected error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
