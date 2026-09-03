import { NextResponse } from 'next/server'

/**
 * Retired: browser-scraped names are not account-scoped provider identity
 * evidence and may not rename an admitted Chat or canonical Contact.
 */
export async function POST() {
    return NextResponse.json(
        { error: 'MAX_NAME_SYNC_RETIRED' },
        { status: 409 },
    )
}
