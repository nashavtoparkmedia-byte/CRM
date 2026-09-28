/**
 * mobile_delivery public surface.
 *
 * Provider-neutral durable delivery of typed mobile notifications to registered
 * devices. Deliberately narrow: two capabilities and the transport port's types.
 *
 * What this surface does NOT expose, and must never expose: the FCM project id,
 * client email, private key, endpoint override, the loopback-override capability
 * or any other environment or credential value. Those stay internal to this
 * context. A consumer learns only whether delivery is enabled, and either gets a
 * transport or a named problem.
 *
 * This is a code boundary, not a bounded context: identity_access owns it, which
 * is why it sits inside that context's public surface. Device identity,
 * eligibility and token state live beside it in the same context, and there is
 * exactly one device registry.
 */

export {
    isMobileDeliveryEnabledV1,
    resolveMobileDeliveryTransportV1,
    type MobileDeliveryTransportResolutionV1,
} from '../../../application/mobile-delivery-operations'
export type {
    MobilePushMessageV1,
    MobilePushSendOutcomeV1,
    MobilePushTransportProblemV1,
    MobilePushTransportV1,
} from '@/contracts/identity-access/v1'
