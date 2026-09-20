import { NextResponse } from 'next/server'

import { managerEvidence, managerSession } from '../../manager-data'

/**
 * The support screenshot of one application, for a signed-in manager.
 *
 * The browser asks for an application, never for a file: the Telegram file id
 * is resolved on the server and handed to the bot account that received it, so
 * it appears in no URL, no markup and no redirect. The bot token stays in the
 * bot process throughout.
 *
 * The response is deliberately dull: one of a few media types, no store, no
 * sniffing, and an attachment disposition, so nothing served here can be
 * rendered as a document in the CRM's own origin.
 */

const FAILURE_STATUS: Record<string, number> = {
    missing: 404,
    not_found: 404,
    unsupported_media: 415,
    too_large: 413,
    unavailable: 502,
}

export async function GET(
    _request: Request,
    { params }: { params: Promise<{ applicationId: string }> },
) {
    const session = await managerSession()
    if (!session.ok) {
        return NextResponse.json({ error: session.refusal }, { status: session.refusal === 'role_not_allowed' ? 403 : 401 })
    }

    const { applicationId } = await params
    const evidence = await managerEvidence(applicationId)
    if (!evidence.ok) {
        return NextResponse.json({ error: evidence.reason }, { status: FAILURE_STATUS[evidence.reason] ?? 502 })
    }

    return new NextResponse(new Uint8Array(evidence.bytes), {
        status: 200,
        headers: {
            'Content-Type': evidence.contentType,
            'Content-Length': String(evidence.bytes.byteLength),
            'Content-Disposition': 'inline; filename="support-reply"',
            'Cache-Control': 'private, no-store',
            'X-Content-Type-Options': 'nosniff',
            'Content-Security-Policy': "default-src 'none'; sandbox",
            'Referrer-Policy': 'no-referrer',
        },
    })
}
