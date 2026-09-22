/**
 * Mobile Push v1 — identity_access device registration contract.
 *
 * The native shell hands the CRM exactly one thing: its current provider
 * token. Every other fact about the registration — which device, which
 * operator label, which credential, which session, when it expires — is
 * derived by identity_access from the verified mobile session, never taken
 * from the request.
 *
 * Messaging sees registrations only through two narrow views: the eligible
 * set (ids and session bindings, no tokens) for fan-out, and a send-time
 * resolution that returns the current token for exactly one delivery.
 */
export const REGISTER_MOBILE_PUSH_DEVICE_COMMAND_V1 = 'identity_access.RegisterMobilePushDeviceCommand.v1' as const

/** Provider token alphabet and bounds. FCM tokens are ~150–250 chars of this set. */
const PUSH_TOKEN = /^[A-Za-z0-9_:-]{20,512}$/

export interface RegisterMobilePushDeviceBodyV1 {
    token: string
}

export type MobilePushRegistrationFailureCodeV1 =
    | 'MOBILE_SESSION_REQUIRED'
    | 'PUSH_DEVICE_ID_NOT_STABLE'
    | 'PUSH_TOKEN_BOUND_TO_OTHER_DEVICE'

export type MobilePushRegistrationResultV1 =
    | { ok: true, registrationId: string, reclaimedStaleBinding: boolean }
    | { ok: false, code: MobilePushRegistrationFailureCodeV1 }

/** What fan-out may know about a device: an address and the session it belongs to. */
export interface MobilePushEligibleDeviceV1 {
    registrationId: string
    sessionBindingId: string
}

export type MobilePushTargetSkipReasonV1 = 'not_found' | 'revoked' | 'ineligible' | 'stale_session'

/**
 * Send-time resolution of one delivery.
 * - `send`: the registration is eligible and still bound to the snapshotted
 *   session; deliver to this token now.
 * - `skip`: nothing may be sent for this delivery, and retrying cannot change that.
 * - `await_token`: the registration is eligible but the provider rejected its
 *   token; a re-registration from the device will supply the next one.
 */
export type MobilePushTargetResolutionV1 =
    | { kind: 'send', token: string }
    | { kind: 'skip', reason: MobilePushTargetSkipReasonV1 }
    | { kind: 'await_token' }

export class MobilePushRegistrationContractError extends Error {
    readonly code = 'INVALID_MOBILE_PUSH_REGISTRATION'

    constructor(message: string) {
        super(message)
        this.name = 'MobilePushRegistrationContractError'
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isMobilePushTokenV1(value: unknown): value is string {
    return typeof value === 'string' && PUSH_TOKEN.test(value)
}

/**
 * The request body is exactly `{ token }`. Any other field — a device id, an
 * operator, an expiry — is refused rather than ignored, so a client cannot
 * even appear to be choosing its own authority.
 */
export function parseRegisterMobilePushDeviceBodyV1(input: unknown): RegisterMobilePushDeviceBodyV1 {
    if (!isRecord(input)) throw new MobilePushRegistrationContractError('body must be an object')
    const unexpected = Object.keys(input).filter((key) => key !== 'token')
    if (unexpected.length > 0) {
        throw new MobilePushRegistrationContractError(`unsupported field(s): ${unexpected.sort().join(', ')}`)
    }
    if (!isMobilePushTokenV1(input.token)) throw new MobilePushRegistrationContractError('token is invalid')
    return { token: input.token }
}
