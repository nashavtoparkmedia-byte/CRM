import { NextRequest, NextResponse } from 'next/server'

import { ContactMergeService, MergeError } from '@/lib/ContactMergeService'
import { getCurrentUser } from '@/lib/users/user-service'

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const actor = await getCurrentUser()
  if (!actor) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const { id: contactId } = await params
  let body: { driverId?: unknown }
  try {
    body = await req.json() as { driverId?: unknown }
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  if (typeof body.driverId !== 'string' || !body.driverId) {
    return NextResponse.json({ error: 'driverId is required' }, { status: 400 })
  }

  try {
    const result = await ContactMergeService.mergeContactToDriver(contactId, body.driverId, actor.id)
    if (result.status === 'merge_confirmation_required') {
      return NextResponse.json(result, { status: 409 })
    }
    return NextResponse.json(result)
  } catch (error) {
    if (error instanceof MergeError) {
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

    console.error('[API merge] Unexpected error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
