import { NextResponse } from 'next/server'
import { getCurrentUserIdentityV1 as getCurrentUser } from '@/modules/identity-access/public/v1/user-directory'
import { getSipExtensionForUser } from '@/lib/sip/extensions'

/**
 * GET /api/calls/sip-credentials
 *
 * Returns the SIP credentials the current CRM user uses to register their
 * browser softphone (and the same creds work in Linphone on their phone).
 *
 * The password is exposed to the authenticated client — that's intentional
 * for browser WebRTC. Anyone with valid CRM session cookie gets their own
 * extension creds; password rotation is done by changing MANAGER_NNN_PASSWORD
 * in the FreeSWITCH .env.
 */
export async function GET() {
    const user = await getCurrentUser()
    if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

    const ext = getSipExtensionForUser(user.id)
    if (!ext) return NextResponse.json({ error: 'no_extension_for_user' }, { status: 403 })

    // Без явного SIP_WS_URL софтфон отключён: дефолт ws://localhost:7080
    // в проде приводил к бесконечному reconnect-спаму на каждой странице.
    const wsUrl = process.env.SIP_WS_URL
    if (!wsUrl) return NextResponse.json({ enabled: false })

    const sipDomain = process.env.SIP_DOMAIN ?? 'crm.local'

    const turnUrl = process.env.TURN_URL ?? 'turn:127.0.0.1:3478?transport=tcp'
    const turnUsername = process.env.TURN_USERNAME ?? 'crm'
    const turnCredential = process.env.TURN_CREDENTIAL ?? 'turnpass'

    return NextResponse.json({
        enabled: true,
        wsUrl,
        sipUri: `sip:${ext.extension}@${sipDomain}`,
        authUser: ext.extension,
        password: ext.password,
        displayName: `${user.firstName} ${user.lastName}`.trim(),
        extension: ext.extension,
        turn: { url: turnUrl, username: turnUsername, credential: turnCredential },
    })
}
