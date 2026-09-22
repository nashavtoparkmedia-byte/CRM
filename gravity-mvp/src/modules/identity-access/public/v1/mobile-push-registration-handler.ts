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

/** Server-known facts that decide whether a registration may receive push right now. */
export interface MobilePushEligibilityFactsV1 {
    now: Date
    revocationEpoch: string
    credentialSubject: string
    credentialKeyId: string
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
    credentialKeyId: string
    now: Date
}

export interface MobilePushRegistrationViewV1 {
    id: string
    hasToken: boolean
    sessionBindingId: string
    sessionExpiresAt: Date
    sessionRevocationEpoch: string
    credentialSubject: string
    credentialKeyId: string
    revoked: boolean
}

export type MobilePushBindOutcomeV1 =
    | { outcome: 'bound', registrationId: string }
    | { outcome: 'token_conflict' }

export type MobilePushReclaimOutcomeV1 =
    | { outcome: 'bound', registrationId: string }
    | { outcome: 'holder_not_reclaimable' }
    | { outcome: 'token_conflict' }

export interface MobilePushRegistrationPortV1 {
    /** Upsert by deviceId. A unique violation on the token is reported, never resolved here. */
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
    /** Whether any row currently holds this token. */
    tokenIsBound(token: string): Promise<boolean>
    revokeDevice(deviceId: string, reason: 'logout', now: Date): Promise<number>
    listEligible(facts: MobilePushEligibilityFactsV1): Promise<MobilePushEligibleDeviceV1[]>
    view(registrationId: string): Promise<MobilePushRegistrationViewV1 | null>
    currentToken(registrationId: string): Promise<string | null>
    /** CAS: clear the token only if it is still exactly the one the provider rejected. */
    clearTokenIfCurrent(registrationId: string, rejectedToken: string): Promise<boolean>
    /** CAS: revoke only if the registration still carries the rejected token. */
    revokeIfTokenCurrent(registrationId: string, rejectedToken: string, reason: 'sender_mismatch', now: Date): Promise<boolean>
}

export function isEligibleMobilePushRegistrationV1(
    view: Pick<MobilePushRegistrationViewV1, 'revoked' | 'sessionExpiresAt' | 'sessionRevocationEpoch' | 'credentialSubject' | 'credentialKeyId'>,
    facts: MobilePushEligibilityFactsV1,
): boolean {
    return !view.revoked
        && view.sessionExpiresAt.getTime() > facts.now.getTime()
        && view.sessionRevocationEpoch === facts.revocationEpoch
        && view.credentialSubject === facts.credentialSubject
        && view.credentialKeyId === facts.credentialKeyId
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

                const reclaimed = await port.reclaimFromIneligibleHolderAndBind(write, facts)
                if (reclaimed.outcome === 'bound') {
                    return { ok: true, registrationId: reclaimed.registrationId, reclaimedStaleBinding: true }
                }
                // Nothing was released. If some row still holds the token, it
                // is (or has just become) a live binding: refuse. If no row
                // holds it any more, the holder let go concurrently; bind again.
                if (await port.tokenIsBound(write.fcmToken)) {
                    return { ok: false, code: 'PUSH_TOKEN_BOUND_TO_OTHER_DEVICE' }
                }
            }
            return { ok: false, code: 'PUSH_TOKEN_BOUND_TO_OTHER_DEVICE' }
        },

        async revokeForLogout(deviceId: string, now: Date): Promise<number> {
            return port.revokeDevice(deviceId, 'logout', now)
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
            const view = await port.view(registrationId)
            if (!view) return { kind: 'skip', reason: 'not_found' }
            if (view.revoked) return { kind: 'skip', reason: 'revoked' }
            if (view.sessionBindingId !== sessionBindingId) return { kind: 'skip', reason: 'stale_session' }
            if (!isEligibleMobilePushRegistrationV1(view, facts)) return { kind: 'skip', reason: 'ineligible' }
            if (!view.hasToken) return { kind: 'await_token' }
            const token = await port.currentToken(registrationId)
            return token ? { kind: 'send', token } : { kind: 'await_token' }
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
