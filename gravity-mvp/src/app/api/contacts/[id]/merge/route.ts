import { NextRequest, NextResponse } from 'next/server'
import { ContactMergeService, MergeError } from '@/lib/ContactMergeService'

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: contactId } = await params

  let body: { driverId?: string; mergedBy?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { driverId, mergedBy } = body

  if (!driverId || typeof driverId !== 'string') {
    return NextResponse.json({ error: 'driverId is required' }, { status: 400 })
  }

  try {
    const result = await ContactMergeService.mergeContactToDriver(contactId, driverId, mergedBy)
    return NextResponse.json(result)
  } catch (err: any) {
    if (err instanceof MergeError) {
      const statusMap: Record<string, number> = {
        CONTACT_NOT_FOUND: 404,
        DRIVER_NOT_FOUND: 404,
        CONTACT_ARCHIVED: 409,
        SURVIVOR_ARCHIVED: 409,
        CONTACT_LINKED_TO_OTHER_DRIVER: 409,
        INVALID_MERGE_STATE: 409,
      }
      const status = statusMap[err.code] || 500
      return NextResponse.json({ error: err.message, code: err.code }, { status })
    }

    console.error('[API merge] Unexpected error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
