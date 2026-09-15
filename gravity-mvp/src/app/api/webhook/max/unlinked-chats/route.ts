import { NextResponse } from 'next/server'

/** Retired with the unscoped MAX browser name-sync mutation. */
export async function GET() {
    return NextResponse.json(
        { error: 'MAX_NAME_SYNC_RETIRED', chatIds: [] },
        { status: 409 },
    )
}
