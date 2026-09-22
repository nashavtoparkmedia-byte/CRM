import { cookies } from 'next/headers'
import type { MobilePushRegistrationResultV1 } from '../../../../contracts/identity-access/v1'
import { registerVerifiedMobilePushDeviceV1 } from '../../application/mobile-push-registration-operations'
import {
    MOBILE_SESSION_COOKIE,
    mobileSessionBindingIdV1,
    verifyMobileSession,
    type MobileSessionPrincipalV1,
} from './mobile-session-credentials'

/**
 * Mobile Push v1 — the one place a push registration meets the session cookie.
 *
 * The session is verified here, inside identity_access, and the registration
 * is derived entirely from what that verification returns plus a one-way
 * fingerprint of the verified token. The raw token is read, verified,
 * fingerprinted and dropped; it is never stored, logged or returned.
 */
async function readVerifiedMobileSessionBinding(): Promise<
    { principal: MobileSessionPrincipalV1, sessionBindingId: string } | null
> {
    const token = (await cookies()).get(MOBILE_SESSION_COOKIE)?.value
    const principal = verifyMobileSession(token)
    if (!principal || typeof token !== 'string') return null
    return { principal, sessionBindingId: mobileSessionBindingIdV1(token) }
}

/**
 * Bind the calling device's current provider token to its verified mobile
 * session. The token is the only client input; the device, operator label,
 * credential, session and expiry all come from the verified session.
 */
export async function registerMobilePushDeviceFromSessionV1(token: string): Promise<MobilePushRegistrationResultV1> {
    const session = await readVerifiedMobileSessionBinding()
    if (!session) return { ok: false, code: 'MOBILE_SESSION_REQUIRED' }
    const result = await registerVerifiedMobilePushDeviceV1(session, token)
    return result.ok
        ? { ok: true, registrationId: result.registrationId, reclaimedStaleBinding: result.reclaimedStaleBinding }
        : { ok: false, code: result.code }
}
