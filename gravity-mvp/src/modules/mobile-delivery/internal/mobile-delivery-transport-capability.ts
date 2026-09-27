import { createHash } from 'node:crypto'
import type { MobilePushTransportProblemV1, MobilePushTransportV1 } from '@/contracts/mobile-delivery/v1'
import { createFcmHttpV1TransportV1 } from './fcm-http-v1-transport'
import { readFcmTransportConfigV1, type FcmTransportConfigV1 } from './mobile-delivery-config'

/**
 * The one place a provider transport is built.
 *
 * Lifted here from Messaging's push runtime so no consuming context handles a
 * configuration value. Callers receive a transport or a named problem; they
 * never see a project id, a client email, a private key or an endpoint.
 *
 * Memoised per configuration, because the FCM adapter caches an OAuth access
 * token and that cache must survive across deliveries. A configuration change
 * rebuilds it, which is what makes a credential rotation take effect without a
 * restart.
 */

export type MobileDeliveryTransportResolutionV1 =
    | { ok: true, transport: MobilePushTransportV1 }
    | { ok: false, problem: MobilePushTransportProblemV1 }

let memoised: { key: string, transport: MobilePushTransportV1 } | null = null

function configurationKey(config: FcmTransportConfigV1): string {
    return createHash('sha256')
        .update([config.projectId, config.clientEmail, config.oauthTokenUrl, config.sendUrl].join('\0'))
        .update(config.privateKey.export({ type: 'pkcs8', format: 'der' }))
        .digest('hex')
}

export function resolveMobileDeliveryTransportV1(): MobileDeliveryTransportResolutionV1 {
    const read = readFcmTransportConfigV1()
    if (!read.ok) return read
    const key = configurationKey(read.config)
    if (memoised?.key !== key) {
        memoised = {
            key,
            transport: createFcmHttpV1TransportV1(read.config, {
                fetch: (...args) => fetch(...args),
                nowMs: () => Date.now(),
            }),
        }
    }
    return { ok: true, transport: memoised.transport }
}
