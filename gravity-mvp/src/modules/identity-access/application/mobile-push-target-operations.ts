import type { MobilePushTargetResolutionV1 } from '../../../contracts/identity-access/v1'
import { createMobilePushRegistrationHandlerV1 } from '../public/v1/mobile-push-registration-handler'
import { prismaMobileDeviceRegistrationPortV1 } from '../public/v1/prisma-mobile-device-registration-adapter'
import { currentMobilePushEligibilityFactsV1 } from './mobile-push-registration-operations'

/**
 * Mobile Push v1 — send-time resolution of one delivery: the only operation
 * that returns a device's provider token.
 *
 * It is a reviewed runtime provider capability. Its single public facade is
 * public/v1/mobile-push-target-capability.ts and its single consumer is
 * Messaging's push runtime, which uses the token as the address of exactly one
 * FCM request. It resolves against the session binding the delivery was fanned
 * out under, so a rotated token is honoured and a stale session is refused.
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
