import { NextResponse } from 'next/server'
import { getCurrentUserIdentityV1 as getCurrentUser } from '@/modules/identity-access/public/v1/user-directory'
import { isMobileShellClientV1 } from '@/modules/identity-access/public/v1/mobile-session-auth'
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
    // The Android shell renders the same pages as the browser, and the root
    // layout mounts the softphone on every one of them. Handing it credentials
    // would register a second SIP endpoint for the same extension, so an
    // incoming call would ring — or worse, be answered — on whichever client
    // FreeSWITCH picked. Telephony is a later stage.
    //
    // This is keyed on the shell, NOT on its session, and that distinction is
    // the whole point. The credential below is granted on the strength of the
    // unsigned `crm_user_id` cookie, which outlives the mobile session in every
    // direction: it is still there before login, it expires on the device clock
    // rather than the server's, and neither a revocation-epoch bump nor a
    // credential rotation touches it. Denying on the session would therefore
    // hand a SIP password to a device at the exact moment its access was
    // revoked. Denying on the client closes all four windows.
    if (await isMobileShellClientV1()) {
        return NextResponse.json({ enabled: false, reason: 'mobile_shell_stage_1' })
    }

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
