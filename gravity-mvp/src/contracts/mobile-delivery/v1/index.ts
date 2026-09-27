/**
 * Mobile Delivery v1 contracts.
 *
 * The provider-neutral transport port two contexts depend on: Messaging for its
 * inbound-message notifications and Calling for its call alerts. Types only, so
 * neither caller can reach a provider implementation or a credential value.
 */

export type {
    MobilePushMessageV1,
    MobilePushSendOutcomeV1,
    MobilePushTransportProblemV1,
    MobilePushTransportV1,
} from './mobile-notification-transport'
