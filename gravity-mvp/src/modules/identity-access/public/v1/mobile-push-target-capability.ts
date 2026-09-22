import type { MobilePushTargetResolutionV1 } from '../../../../contracts/identity-access/v1'
import { currentMobilePushEligibilityFactsV1 } from '../../application/mobile-push-registration-operations'
import { createMobilePushRegistrationHandlerV1 } from './mobile-push-registration-handler'
import { prismaMobileDeviceRegistrationPortV1 } from './prisma-mobile-device-registration-adapter'

/**
 * Mobile Push v1 — the ONE identity_access capability that hands a device's
 * provider token to another context.
 *
 * It is a reviewed runtime provider capability: its only consumer is
 * Messaging's push runtime, which uses the token as the address of exactly one
 * FCM request and never stores, logs or returns it. It resolves a delivery at
 * send time against the session binding the delivery was fanned out under, so
 * a rotated token is honoured and a stale session is refused.
 */

const registrations = createMobilePushRegistrationHandlerV1(prismaMobileDeviceRegistrationPortV1)

export async function resolveMobilePushTargetV1(
    registrationId: string,
    sessionBindingId: string,
): Promise<MobilePushTargetResolutionV1> {
    const facts = currentMobilePushEligibilityFactsV1(new Date())
    if (!facts) return { kind: 'skip', reason: 'ineligible' }
    const resolution = await registrations.resolveTarget(registrationId, sessionBindingId, facts)
    if (resolution.kind === 'send') return { kind: 'send', token: resolution.token }
    if (resolution.kind === 'skip') return { kind: 'skip', reason: resolution.reason }
    return { kind: 'await_token' }
}
