import { createHash } from 'node:crypto'
import { operationalLogV1 as opsLog } from '@/infrastructure/operations/operational-log'
import {
    listPushEligibleMobileDevicesV1,
    markMobilePushTokenRejectedV1,
    resolveMobilePushTargetV1,
    revokeMobilePushSenderMismatchV1,
} from '@/modules/identity-access/public/v1'
import { createFcmHttpV1TransportV1, type MobilePushTransportV1 } from './fcm-http-v1-transport'
import { createMobilePushDispatchV1 } from './mobile-push-dispatch'
import { isMobilePushEnabledV1, readFcmTransportConfigV1, type FcmTransportConfigV1 } from './mobile-push-config'
import { prismaMobilePushFanOutStoreV1 } from './push-fan-out-prisma-adapter'

/**
 * Production wiring for Mobile Push v1. The transport is memoised per
 * configuration so its access-token cache survives across deliveries, and is
 * rebuilt if the configuration changes.
 */

let memoisedTransport: { key: string, transport: MobilePushTransportV1 } | null = null

function configurationKey(config: FcmTransportConfigV1): string {
    return createHash('sha256')
        .update([config.projectId, config.clientEmail, config.oauthTokenUrl, config.sendUrl].join('\0'))
        .update(config.privateKey.export({ type: 'pkcs8', format: 'der' }))
        .digest('hex')
}

function currentTransport(): ReturnType<Parameters<typeof createMobilePushDispatchV1>[0]['transport']> {
    const read = readFcmTransportConfigV1()
    if (!read.ok) return read
    const key = configurationKey(read.config)
    if (memoisedTransport?.key !== key) {
        memoisedTransport = {
            key,
            transport: createFcmHttpV1TransportV1(read.config, { fetch: (...args) => fetch(...args), nowMs: () => Date.now() }),
        }
    }
    return { ok: true, transport: memoisedTransport.transport }
}

export const mobilePushDispatchV1 = createMobilePushDispatchV1({
    isEnabled: () => isMobilePushEnabledV1(),
    now: () => new Date(),
    findChat: (chatId) => prismaMobilePushFanOutStoreV1.findChatForNotification(chatId),
    listEligibleDevices: () => listPushEligibleMobileDevicesV1(),
    appendDeliveryEvents: (events) => prismaMobilePushFanOutStoreV1.appendDeliveryEvents(events),
    resolveTarget: (registrationId, sessionBindingId) => resolveMobilePushTargetV1(registrationId, sessionBindingId),
    markTokenRejected: (registrationId, rejectedToken) => markMobilePushTokenRejectedV1(registrationId, rejectedToken),
    revokeSenderMismatch: (registrationId, rejectedToken) => revokeMobilePushSenderMismatchV1(registrationId, rejectedToken),
    transport: currentTransport,
    log: (level, event, context) => opsLog(level, event, { operation: 'mobile_push', ...context }),
})
