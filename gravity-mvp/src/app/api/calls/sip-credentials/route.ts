import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/users/user-service'
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

    return NextResponse.json({
        enabled: true,
        wsUrl,
        sipUri: `sip:${ext.extension}@${sipDomain}`,
        authUser: ext.extension,
        password: ext.password,
        displayName: `${user.firstName} ${user.lastName}`.trim(),
        extension: ext.extension,
    })
}
