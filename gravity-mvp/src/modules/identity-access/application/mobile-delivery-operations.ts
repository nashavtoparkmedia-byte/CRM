import {
    isMobileDeliveryEnabledV1 as readEnablement,
} from '../internal/mobile-delivery/mobile-delivery-config'
import {
    resolveMobileDeliveryTransportV1 as resolveTransport,
    type MobileDeliveryTransportResolutionV1,
} from '../internal/mobile-delivery/mobile-delivery-transport-capability'

/**
 * Mobile delivery, as the rest of the system is allowed to see it.
 *
 * The application layer is where identity_access's public surface reaches its
 * implementation - the same route resolveMobilePushTargetV1 takes - so the
 * facade re-exports from here rather than importing the internal directly.
 *
 * Neither operation returns, accepts or names a configuration value. A caller
 * learns whether delivery is enabled, and gets either a transport or a named
 * problem.
 */

export function isMobileDeliveryEnabledV1(): boolean {
    return readEnablement()
}

export function resolveMobileDeliveryTransportV1(): MobileDeliveryTransportResolutionV1 {
    return resolveTransport()
}

export type { MobileDeliveryTransportResolutionV1 }
