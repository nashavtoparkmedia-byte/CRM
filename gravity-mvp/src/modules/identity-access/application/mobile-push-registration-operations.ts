import type {
    MobilePushEligibleDeviceV1,
    MobilePushRegistrationResultV1,
    MobilePushTargetResolutionV1,
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
 * key, so raising MOBILE_SESSION_REVOCATION_EPOCH or rotating the mobile
 * credential silences every registration bound to the old values at once,
 * without a job and without touching the rows.
 */

const registrations = createMobilePushRegistrationHandlerV1(prismaMobileDeviceRegistrationPortV1)

function currentEligibilityFacts(now: Date): MobilePushEligibilityFactsV1 | null {
    const credential = currentMobilePushCredentialFactsV1()
    if (!credential) return null
    return {
        now,
        revocationEpoch: getMobileSessionRevocationEpoch(),
        credentialSubject: credential.credentialSubject,
        credentialKeyId: credential.credentialKeyId,
    }
}

/**
 * Register the device's current provider token for an ALREADY VERIFIED
 * session. Only identity_access's own session reader may call this; every
 * field it stores comes from that verification, none from the client.
 */
export async function registerVerifiedMobilePushDeviceV1(
    session: { principal: MobileSessionPrincipalV1, sessionBindingId: string },
    token: string,
): Promise<MobilePushRegistrationResultV1> {
    const now = new Date()
    const facts = currentEligibilityFacts(now)
    if (!facts) return { ok: false, code: 'MOBILE_SESSION_REQUIRED' }
    const result = await registrations.register({
        deviceId: session.principal.deviceId,
        fcmToken: token,
        credentialSubject: session.principal.credentialSubject,
        runtimeOperatorId: session.principal.runtimeOperatorId,
        sessionBindingId: session.sessionBindingId,
        sessionIssuedAt: new Date((session.principal.expiresAtSeconds - MOBILE_SESSION_TTL_SECONDS) * 1000),
        sessionExpiresAt: new Date(session.principal.expiresAtSeconds * 1000),
        sessionRevocationEpoch: facts.revocationEpoch,
        credentialKeyId: facts.credentialKeyId,
        now,
    }, facts)
    return result.ok
        ? { ok: true, registrationId: result.registrationId, reclaimedStaleBinding: result.reclaimedStaleBinding }
        : { ok: false, code: result.code }
}

/** Logout revokes the device's registration and releases its token. Message state is never touched. */
export async function revokeMobilePushDeviceForLogoutV1(deviceId: string): Promise<{ revoked: number }> {
    return { revoked: await registrations.revokeForLogout(deviceId, new Date()) }
}

/** Every registration that may receive push now: ids and session bindings, never tokens. */
export async function listPushEligibleMobileDevicesV1(): Promise<MobilePushEligibleDeviceV1[]> {
    const facts = currentEligibilityFacts(new Date())
    if (!facts) return []
    const devices = await registrations.listEligible(facts)
    return devices.map((device) => ({ registrationId: device.registrationId, sessionBindingId: device.sessionBindingId }))
}

/** Send-time resolution of one delivery against the session binding it was fanned out under. */
export async function resolveMobilePushTargetV1(
    registrationId: string,
    sessionBindingId: string,
): Promise<MobilePushTargetResolutionV1> {
    const facts = currentEligibilityFacts(new Date())
    if (!facts) return { kind: 'skip', reason: 'ineligible' }
    const resolution = await registrations.resolveTarget(registrationId, sessionBindingId, facts)
    if (resolution.kind === 'send') return { kind: 'send', token: resolution.token }
    if (resolution.kind === 'skip') return { kind: 'skip', reason: resolution.reason }
    return { kind: 'await_token' }
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
