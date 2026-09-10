import { NextResponse } from 'next/server'

/**
 * Retired legacy endpoint.
 *
 * This route used to accept a Driver id plus a caller-supplied/synthesized
 * external id and mutate Chat before Contacts had selected an exact active
 * provider identity. That makes a phone or stale Driver annotation capable of
 * claiming somebody else's channel peer. New conversations must be opened via
 * POST /api/contacts/:contactId/chats, whose platform-shell orchestrator
 * validates the exact ContactIdentity, provider account, reachability, target,
 * and bound transport before Messaging writes.
 */
export async function POST(_request: Request) {
    return NextResponse.json({
        error: 'PROVIDER_IDENTITY_REQUIRED',
        message: 'A stable provider identity is required; open the conversation from the Contact profile.',
    }, { status: 409 })
}
