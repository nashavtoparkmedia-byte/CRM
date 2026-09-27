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
 * Device identity, eligibility and token state are NOT owned here - they belong
 * to identity_access, and callers reach them through its own public surface.
 * There is exactly one device registry.
 */

export { isMobileDeliveryEnabledV1 } from '../../internal/mobile-delivery-config'
export {
    resolveMobileDeliveryTransportV1,
    type MobileDeliveryTransportResolutionV1,
} from '../../internal/mobile-delivery-transport-capability'
export type {
    MobilePushMessageV1,
    MobilePushSendOutcomeV1,
    MobilePushTransportProblemV1,
    MobilePushTransportV1,
} from '@/contracts/mobile-delivery/v1'
