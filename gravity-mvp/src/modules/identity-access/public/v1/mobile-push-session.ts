import { cookies } from 'next/headers'
import type { MobilePushRegistrationResultV1 } from '../../../../contracts/identity-access/v1'
import { registerVerifiedMobilePushDeviceV1 } from '../../application/mobile-push-registration-operations'
import {
    MOBILE_SESSION_COOKIE,
    mobileSessionBarrierEntryV1,
    mobileSessionBindingIdV1,
    verifyMobileSession,
    type MobileSessionPrincipalV1,
} from './mobile-session-credentials'

/**
 * Mobile Push v1 — the one place a push registration meets the session cookie.
 *
 * The session is verified here, inside identity_access, and the registration
 * is derived entirely from what that verification returns. The raw token is
 * read, verified and dropped: it is never stored, logged, returned, or mixed
 * into any stored value.
 */
export async function readVerifiedMobileSessionBindingV1(): Promise<
    | { principal: MobileSessionPrincipalV1, sessionBindingId: string, barrierEntry: string }
    | { principal: MobileSessionPrincipalV1, sessionBindingId: null, barrierEntry: null }
    | null
> {
    const token = (await cookies()).get(MOBILE_SESSION_COOKIE)?.value
    const principal = verifyMobileSession(token)
    if (!principal) return null
    const sessionBindingId = mobileSessionBindingIdV1(principal)
    const barrierEntry = mobileSessionBarrierEntryV1(principal)
    // A session issued before Mobile Push v1 carries no instance id. It stays
    // valid for ordinary CRM access; push has no session identity to bind to.
    if (!sessionBindingId || !barrierEntry) return { principal, sessionBindingId: null, barrierEntry: null }
    return { principal, sessionBindingId, barrierEntry }
}

/**
 * Bind the calling device's current provider token to its verified mobile
 * session. The token is the only client input; the device, operator label,
 * credential, session and expiry all come from the verified session.
 */
export async function registerMobilePushDeviceFromSessionV1(token: string): Promise<MobilePushRegistrationResultV1> {
    const session = await readVerifiedMobileSessionBindingV1()
    if (!session) return { ok: false, code: 'MOBILE_SESSION_REQUIRED' }
    // Fail closed rather than invent an identity for a session that has none.
    if (!session.sessionBindingId) return { ok: false, code: 'MOBILE_SESSION_REISSUE_REQUIRED' }
    const result = await registerVerifiedMobilePushDeviceV1(
        { principal: session.principal, sessionBindingId: session.sessionBindingId, barrierEntry: session.barrierEntry },
        token,
    )
    return result.ok
        ? { ok: true, registrationId: result.registrationId, reclaimedStaleBinding: result.reclaimedStaleBinding }
        : { ok: false, code: result.code }
}
