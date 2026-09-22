import type {
    MobilePushEligibleDeviceV1,
    MobilePushRegistrationResultV1,
    MobilePushTargetResolutionV1,
} from '../../../../contracts/identity-access/v1'

/**
 * Mobile Push v1 — device registration rules, independent of storage.
 *
 * One stable registration per app install (`deviceId`), one device per live
 * provider token. Both are database uniqueness invariants; this handler only
 * decides what to do when the database says a token is already bound.
 */

/** A device id the client falls back to when WebView storage fails; shared across devices. */
export const UNSTABLE_DEVICE_ID_V1 = 'ephemeral-device'

/**
 * Server-known facts that decide whether a registration may receive push right
 * now. All of them are non-secret: nothing derived from MOBILE_ACCESS_PASS is
 * stored or compared, so the database holds no verifier for password guesses.
 * Rotating that password therefore requires advancing
 * MOBILE_SESSION_REVOCATION_EPOCH to silence sessions issued under the old one.
 */
export interface MobilePushEligibilityFactsV1 {
    now: Date
    revocationEpoch: string
    credentialSubject: string
}

/** What a logout tombstone records about the session that logged out. */
export interface MobilePushRevokedSessionFactsV1 {
    credentialSubject: string
    runtimeOperatorId: string
    sessionIssuedAt: Date
    sessionExpiresAt: Date
    sessionRevocationEpoch: string
}

/** Everything a registration binds, all derived from the verified session. */
export interface MobilePushRegistrationWriteV1 {
    deviceId: string
    fcmToken: string
    credentialSubject: string
    runtimeOperatorId: string
    sessionBindingId: string
    sessionIssuedAt: Date
    sessionExpiresAt: Date
    sessionRevocationEpoch: string
    now: Date
}

/** Why a delivery is not sendable, as metadata: no token, no credential facts. */
export interface MobilePushRegistrationStatusV1 {
    id: string
    sessionBindingId: string
    revoked: boolean
}

export type MobilePushBindOutcomeV1 =
    | { outcome: 'bound', registrationId: string }
    | { outcome: 'token_conflict' }
    /** This device has completed a logout for this very session; it can never bind again. */
    | { outcome: 'session_revoked' }

export type MobilePushReclaimOutcomeV1 =
    | { outcome: 'bound', registrationId: string }
    | { outcome: 'holder_not_reclaimable' }
    | { outcome: 'token_conflict' }
    | { outcome: 'session_revoked' }

export interface MobilePushRegistrationPortV1 {
    /**
     * Bind by deviceId, but ONLY if this device has not already completed a
     * logout for this session: the database evaluates that barrier in the same
     * statement that writes, so a logout committing concurrently either
     * precedes the bind (which is then refused) or follows it (and revokes
     * what it wrote). A unique violation on the token is reported, never
     * resolved here.
     */
    bind(write: MobilePushRegistrationWriteV1): Promise<MobilePushBindOutcomeV1>
    /**
     * In ONE transaction: release the token from its current holder only if
     * that holder is ineligible by server facts (the conditional update locks
     * and re-evaluates the holder row), then bind the token to this device.
     */
    reclaimFromIneligibleHolderAndBind(
        write: MobilePushRegistrationWriteV1,
        facts: MobilePushEligibilityFactsV1,
    ): Promise<MobilePushReclaimOutcomeV1>
    /** Whether a row of ANOTHER device currently holds this token; this device's own row never counts. */
    tokenIsBoundToOtherDevice(token: string, deviceId: string): Promise<boolean>
    /**
     * Revoke this device and record the logged-out session in the device's
     * durable barrier. Writes a tombstone row when the device has no
     * registration yet, so a registration still in flight from that same
     * session cannot create one afterwards.
     */
    revokeDevice(
        deviceId: string,
        sessionBindingId: string,
        session: MobilePushRevokedSessionFactsV1,
        reason: 'logout',
        now: Date,
    ): Promise<number>
    listEligible(facts: MobilePushEligibilityFactsV1): Promise<MobilePushEligibleDeviceV1[]>
    status(registrationId: string): Promise<MobilePushRegistrationStatusV1 | null>
    /**
     * The one read of the provider token, for the delivery being sent now. ONE
     * query, conditioned on the registration, the delivery's session binding
     * and every eligibility fact, so no logout, re-login or revocation can land
     * between the checks and the read. `sendable: false` when any condition
     * fails; no stored credential fact is read back.
     */
    sendableToken(
        registrationId: string,
        sessionBindingId: string,
        facts: MobilePushEligibilityFactsV1,
    ): Promise<{ sendable: false } | { sendable: true, token: string | null }>
    /** CAS: clear the token only if it is still exactly the one the provider rejected. */
    clearTokenIfCurrent(registrationId: string, rejectedToken: string): Promise<boolean>
    /** CAS: revoke only if the registration still carries the rejected token. */
    revokeIfTokenCurrent(registrationId: string, rejectedToken: string, reason: 'sender_mismatch', now: Date): Promise<boolean>
}

const MAX_BIND_ROUNDS = 3

export function createMobilePushRegistrationHandlerV1(port: MobilePushRegistrationPortV1) {
    return {
        /**
         * Bind the device's current token.
         *
         * A token held by another device is released only when that holder is
         * provably dead by server facts; a live holder is never displaced
         * (fail closed with PUSH_TOKEN_BOUND_TO_OTHER_DEVICE, no row changes).
         * Every conflict is re-evaluated against the database, because another
         * request may have bound, released or rebound the token meanwhile.
         */
        async register(
            write: MobilePushRegistrationWriteV1,
            facts: MobilePushEligibilityFactsV1,
        ): Promise<MobilePushRegistrationResultV1> {
            if (write.deviceId === UNSTABLE_DEVICE_ID_V1) return { ok: false, code: 'PUSH_DEVICE_ID_NOT_STABLE' }

            for (let round = 0; round < MAX_BIND_ROUNDS; round += 1) {
                const bound = await port.bind(write)
                if (bound.outcome === 'bound') {
                    return { ok: true, registrationId: bound.registrationId, reclaimedStaleBinding: false }
                }
                // The device logged this session out. No later request proven
                // by it may register again, however long it was in flight.
                if (bound.outcome === 'session_revoked') return { ok: false, code: 'MOBILE_SESSION_REVOKED' }

                const reclaimed = await port.reclaimFromIneligibleHolderAndBind(write, facts)
                if (reclaimed.outcome === 'bound') {
                    return { ok: true, registrationId: reclaimed.registrationId, reclaimedStaleBinding: true }
                }
                if (reclaimed.outcome === 'session_revoked') return { ok: false, code: 'MOBILE_SESSION_REVOKED' }
                // Nothing was released. If another device still holds the
                // token, it is (or has just become) a live binding: refuse. If
                // none does, the holder let go concurrently, or a concurrent
                // request of this same device already bound it; bind again.
                if (await port.tokenIsBoundToOtherDevice(write.fcmToken, write.deviceId)) {
                    return { ok: false, code: 'PUSH_TOKEN_BOUND_TO_OTHER_DEVICE' }
                }
            }
            return { ok: false, code: 'PUSH_TOKEN_BOUND_TO_OTHER_DEVICE' }
        },

        async revokeForLogout(
            deviceId: string,
            sessionBindingId: string,
            session: MobilePushRevokedSessionFactsV1,
            now: Date,
        ): Promise<number> {
            return port.revokeDevice(deviceId, sessionBindingId, session, 'logout', now)
        },

        async listEligible(facts: MobilePushEligibilityFactsV1): Promise<MobilePushEligibleDeviceV1[]> {
            return port.listEligible(facts)
        },

        /**
         * Decide one delivery at send time. The token is read here, never
         * carried in the delivery event, so a rotation after fan-out is honoured.
         */
        async resolveTarget(
            registrationId: string,
            sessionBindingId: string,
            facts: MobilePushEligibilityFactsV1,
        ): Promise<MobilePushTargetResolutionV1> {
            const target = await port.sendableToken(registrationId, sessionBindingId, facts)
            if (target.sendable) return target.token ? { kind: 'send', token: target.token } : { kind: 'await_token' }
            // Not sendable: that decision is final. The reason below is metadata
            // for the operations log only and never turns a skip into a send.
            const status = await port.status(registrationId)
            if (!status) return { kind: 'skip', reason: 'not_found' }
            if (status.revoked) return { kind: 'skip', reason: 'revoked' }
            if (status.sessionBindingId !== sessionBindingId) return { kind: 'skip', reason: 'stale_session' }
            return { kind: 'skip', reason: 'ineligible' }
        },

        async markTokenRejected(registrationId: string, rejectedToken: string): Promise<'cleared' | 'already_rotated'> {
            return (await port.clearTokenIfCurrent(registrationId, rejectedToken)) ? 'cleared' : 'already_rotated'
        },

        async revokeSenderMismatch(registrationId: string, rejectedToken: string, now: Date): Promise<'revoked' | 'already_rotated'> {
            return (await port.revokeIfTokenCurrent(registrationId, rejectedToken, 'sender_mismatch', now))
                ? 'revoked'
                : 'already_rotated'
        },
    }
}

export type MobilePushRegistrationHandlerV1 = ReturnType<typeof createMobilePushRegistrationHandlerV1>
