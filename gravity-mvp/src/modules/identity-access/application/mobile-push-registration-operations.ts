import type {
    MobilePushEligibleDeviceV1,
    MobilePushRegistrationResultV1,
} from '../../../contracts/identity-access/v1'
import {
    createMobilePushRegistrationHandlerV1,
    type MobilePushEligibilityFactsV1,
} from '../public/v1/mobile-push-registration-handler'
import { prismaMobileDeviceRegistrationPortV1 } from '../public/v1/prisma-mobile-device-registration-adapter'
import {
    currentMobilePushCredentialFactsV1,
    getMobileSessionRevocationEpoch,
    MOBILE_SESSION_TTL_SECONDS,
    type MobileSessionPrincipalV1,
} from '../public/v1/mobile-session-credentials'

/**
 * Mobile Push v1 registration operations, bound to the live server facts.
 *
 * Every eligibility decision reads the CURRENT revocation epoch and credential
 * subject, so raising MOBILE_SESSION_REVOCATION_EPOCH silences every
 * registration bound to an older generation at once, without a job and without
 * touching the rows. Rotating MOBILE_ACCESS_PASS must advance that epoch too:
 * nothing password-derived is stored, because such a value would let anyone
 * holding the database verify password guesses offline.
 */

const registrations = createMobilePushRegistrationHandlerV1(prismaMobileDeviceRegistrationPortV1)

/** The live server facts eligibility is judged against; null when the mobile lane is unprovisioned. */
export function currentMobilePushEligibilityFactsV1(now: Date): MobilePushEligibilityFactsV1 | null {
    const credential = currentMobilePushCredentialFactsV1()
    if (!credential) return null
    return {
        now,
        revocationEpoch: getMobileSessionRevocationEpoch(),
        credentialSubject: credential.credentialSubject,
    }
}

/**
 * Register the device's current provider token for an ALREADY VERIFIED
 * session. Only identity_access's own session reader may call this; every
 * field it stores comes from that verification, none from the client.
 */
export async function registerVerifiedMobilePushDeviceV1(
    session: { principal: MobileSessionPrincipalV1, sessionBindingId: string, barrierEntry: string },
    token: string,
): Promise<MobilePushRegistrationResultV1> {
    const now = new Date()
    const facts = currentMobilePushEligibilityFactsV1(now)
    if (!facts) return { ok: false, code: 'MOBILE_SESSION_REQUIRED' }
    const result = await registrations.register({
        deviceId: session.principal.deviceId,
        fcmToken: token,
        credentialSubject: session.principal.credentialSubject,
        runtimeOperatorId: session.principal.runtimeOperatorId,
        sessionBindingId: session.sessionBindingId,
        barrierEntry: session.barrierEntry,
        sessionIssuedAt: new Date((session.principal.expiresAtSeconds - MOBILE_SESSION_TTL_SECONDS) * 1000),
        sessionExpiresAt: new Date(session.principal.expiresAtSeconds * 1000),
        sessionRevocationEpoch: facts.revocationEpoch,
        now,
    }, facts)
    return result.ok
        ? { ok: true, registrationId: result.registrationId, reclaimedStaleBinding: result.reclaimedStaleBinding }
        : { ok: false, code: result.code }
}

/**
 * Logout revokes the device's registration, releases its token and records the
 * logged-out session in the device's durable barrier, so no later request
 * proven by that same session can register again. Message state is never
 * touched. Only identity_access's own session reader may call this: the
 * session must already be verified.
 */
export async function revokeMobilePushDeviceForLogoutV1(
    session: { principal: MobileSessionPrincipalV1, sessionBindingId: string | null, barrierEntry: string | null },
): Promise<{ revoked: number }> {
    const now = new Date()
    // A session issued before Mobile Push v1 could never have registered, so
    // there is nothing to bar; its device row is still revoked if one exists.
    const barrier = session.sessionBindingId && session.barrierEntry
        ? { sessionBindingId: session.sessionBindingId, entry: session.barrierEntry }
        : null
    return {
        revoked: await registrations.revokeForLogout(session.principal.deviceId, barrier, {
            credentialSubject: session.principal.credentialSubject,
            runtimeOperatorId: session.principal.runtimeOperatorId,
            sessionIssuedAt: new Date((session.principal.expiresAtSeconds - MOBILE_SESSION_TTL_SECONDS) * 1000),
            sessionExpiresAt: new Date(session.principal.expiresAtSeconds * 1000),
            sessionRevocationEpoch: getMobileSessionRevocationEpoch(),
        }, now),
    }
}

/** Every registration that may receive push now: ids and session bindings, never tokens. */
export async function listPushEligibleMobileDevicesV1(): Promise<MobilePushEligibleDeviceV1[]> {
    const facts = currentMobilePushEligibilityFactsV1(new Date())
    if (!facts) return []
    const devices = await registrations.listEligible(facts)
    return devices.map((device) => ({ registrationId: device.registrationId, sessionBindingId: device.sessionBindingId }))
}

/**
 * The provider reported the token unregistered. Clear it only if the
 * registration still carries exactly that token; if the device already
 * rotated, the new token must survive.
 */
export async function markMobilePushTokenRejectedV1(
    registrationId: string,
    rejectedToken: string,
): Promise<{ result: 'cleared' | 'already_rotated' }> {
    return { result: await registrations.markTokenRejected(registrationId, rejectedToken) }
}

/** The token belongs to another sender project: revoke this registration (CAS on the token). */
export async function revokeMobilePushSenderMismatchV1(
    registrationId: string,
    rejectedToken: string,
): Promise<{ result: 'revoked' | 'already_rotated' }> {
    return { result: await registrations.revokeSenderMismatch(registrationId, rejectedToken, new Date()) }
}
