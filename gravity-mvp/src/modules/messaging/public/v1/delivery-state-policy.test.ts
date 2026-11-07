import { describe, expect, it } from 'vitest'
import { channelDeliveryErrorV1 } from './channel-delivery-runtime'
import {
    contactPermissionRefusalV1,
    deliveryEvidenceRankV1,
    deliveryStateLabelV1,
    deriveDeliveryStateV1,
    isDeliveryStateV1,
    isPhysicalRetryDueV1,
    isProviderAcceptedEvidenceV1,
    newDeliveryEvidenceRecordV1,
    physicalRetryAnchorMsV1,
    physicalRetryBackoffMsV1,
    provenDeliveryRankV1,
    readChannelDeliveryErrorV1,
    readDeliveryEvidenceV1,
    readTextDeliveryResultV1,
    statusForDeliveryEvidenceV1,
    type DeliveryEvidenceKindV1,
} from './delivery-state-policy'

// S2 — one derivation of what a message's delivery evidence proves, shared by
// the server answers and the conversation view.

const AT = new Date('2026-10-04T10:00:00.000Z')
const evidence = (kind: DeliveryEvidenceKindV1) => ({ delivery: newDeliveryEvidenceRecordV1(kind, 'send', AT) })
const outbound = (status: string, metadata: unknown = {}) => ({ direction: 'outbound', status, metadata })

describe('evidence strength', () => {
    it('orders client action < provider ack = echo = read-back < device receipt < read receipt', () => {
        expect(deliveryEvidenceRankV1('client_action')).toBe(0)
        for (const kind of ['provider_ack', 'provider_echo', 'history_readback'] as const) expect(deliveryEvidenceRankV1(kind)).toBe(1)
        expect(deliveryEvidenceRankV1('device_receipt')).toBe(2)
        expect(deliveryEvidenceRankV1('read_receipt')).toBe(3)
    })

    it('treats anything else as no evidence at all', () => {
        for (const value of [undefined, null, '', 'delivered', 'ui_send_action', 'sent', 1, {}]) {
            expect(deliveryEvidenceRankV1(value)).toBe(-1)
            expect(isProviderAcceptedEvidenceV1(value)).toBe(false)
        }
    })

    it('never lets a client action count as provider acceptance', () => {
        expect(isProviderAcceptedEvidenceV1('client_action')).toBe(false)
        expect(isProviderAcceptedEvidenceV1('provider_ack')).toBe(true)
    })

    it('maps evidence to the status it supports, and no further', () => {
        expect(statusForDeliveryEvidenceV1('client_action')).toBe('sent')
        expect(statusForDeliveryEvidenceV1('provider_ack')).toBe('sent')
        expect(statusForDeliveryEvidenceV1('provider_echo')).toBe('sent')
        expect(statusForDeliveryEvidenceV1('history_readback')).toBe('sent')
        expect(statusForDeliveryEvidenceV1('device_receipt')).toBe('delivered')
        expect(statusForDeliveryEvidenceV1('read_receipt')).toBe('read')
    })
})

describe('deriveDeliveryStateV1', () => {
    it('has no delivery state for inbound or system rows', () => {
        expect(deriveDeliveryStateV1({ direction: 'inbound', status: 'delivered' })).toBeNull()
        expect(deriveDeliveryStateV1({ direction: 'system', status: 'sent' })).toBeNull()
    })

    it('reads a sent row by its evidence, never by its provider id', () => {
        expect(deriveDeliveryStateV1(outbound('sent'))).toBe('send_requested')
        expect(deriveDeliveryStateV1(outbound('sent', evidence('client_action')))).toBe('send_requested')
        expect(deriveDeliveryStateV1({ ...outbound('sent', evidence('client_action')), externalId: 'client-minted' } as never)).toBe('send_requested')
        for (const kind of ['provider_ack', 'provider_echo', 'history_readback'] as const) {
            expect(deriveDeliveryStateV1(outbound('sent', evidence(kind)))).toBe('provider_accepted')
        }
    })

    it('shows delivered and read rows as they are stored', () => {
        expect(deriveDeliveryStateV1(outbound('delivered', evidence('device_receipt')))).toBe('delivered')
        expect(deriveDeliveryStateV1(outbound('read', evidence('read_receipt')))).toBe('read')
        // A row written before S2 carries no record and is shown as it always was.
        expect(deriveDeliveryStateV1(outbound('delivered'))).toBe('delivered')
    })

    it('splits failures by what the owner proved', () => {
        expect(deriveDeliveryStateV1(outbound('failed', { deliveryOutcome: 'unknown', retryable: false, errorSchemaVersion: 2 }))).toBe('indeterminate')
        expect(deriveDeliveryStateV1(outbound('failed', { deliveryOutcome: 'safe_to_redeliver', retryable: true, errorSchemaVersion: 2 }))).toBe('failed_safe_to_retry')
        expect(deriveDeliveryStateV1(outbound('failed', { deliveryOutcome: 'terminal', retryable: false, errorSchemaVersion: 2 }))).toBe('failed_not_safe_to_retry')
    })

    it('never calls a v1-taxonomy failure safe to retry', () => {
        expect(deriveDeliveryStateV1(outbound('failed', { retryable: true }))).toBe('failed_not_safe_to_retry')
        expect(deriveDeliveryStateV1(outbound('failed', { retryable: true, deliveryOutcome: 'safe_to_redeliver', errorSchemaVersion: 1 }))).toBe('failed_not_safe_to_retry')
        expect(deriveDeliveryStateV1(outbound('failed', { retryable: false, deliveryOutcome: 'safe_to_redeliver', errorSchemaVersion: 2 }))).toBe('failed_not_safe_to_retry')
    })

    it('ignores an evidence record that a failure supersedes', () => {
        expect(deriveDeliveryStateV1(outbound('failed', { ...evidence('provider_ack'), deliveryOutcome: 'unknown' }))).toBe('indeterminate')
    })

    it('labels every state', () => {
        expect(deliveryStateLabelV1('send_requested')).toBe('Ожидает подтверждения')
        expect(deliveryStateLabelV1('provider_accepted')).toBe('Отправлено')
        expect(deliveryStateLabelV1('delivered')).toBe('Доставлено')
        expect(deliveryStateLabelV1('read')).toBe('Прочитано')
        expect(deliveryStateLabelV1('indeterminate')).toBe('Статус доставки неизвестен')
        expect(deliveryStateLabelV1('failed_safe_to_retry')).toBe('Не отправлено')
        expect(deliveryStateLabelV1('failed_not_safe_to_retry')).toBe('Не отправлено')
        expect(isDeliveryStateV1('provider_accepted')).toBe(true)
        expect(isDeliveryStateV1('sent')).toBe(false)
    })
})

describe('recorded evidence', () => {
    it('reads only a well-formed v1 record', () => {
        expect(readDeliveryEvidenceV1(evidence('provider_ack'))).toEqual({ v: 1, evidence: 'provider_ack', evidenceAt: AT.toISOString(), source: 'send' })
        expect(readDeliveryEvidenceV1({ delivery: { v: 2, evidence: 'provider_ack' } })).toBeNull()
        expect(readDeliveryEvidenceV1({ delivery: { v: 1, evidence: 'delivered' } })).toBeNull()
        expect(readDeliveryEvidenceV1({ delivery: 'provider_ack' })).toBeNull()
        expect(readDeliveryEvidenceV1(null)).toBeNull()
        expect(readDeliveryEvidenceV1([])).toBeNull()
    })

    it('ranks what a row proves, a failure proving nothing', () => {
        expect(provenDeliveryRankV1(outbound('sent'))).toBe(-1)
        expect(provenDeliveryRankV1(outbound('sent', evidence('client_action')))).toBe(0)
        expect(provenDeliveryRankV1(outbound('sent', evidence('provider_echo')))).toBe(1)
        expect(provenDeliveryRankV1(outbound('delivered'))).toBe(2)
        expect(provenDeliveryRankV1(outbound('read', evidence('provider_ack')))).toBe(3)
        expect(provenDeliveryRankV1(outbound('failed', evidence('provider_ack')))).toBe(-1)
    })
})

describe('typed adapter results and failures', () => {
    it('reads a legacy result as no typed result', () => {
        expect(readTextDeliveryResultV1({ externalId: 'wa-1' })).toBeNull()
        expect(readTextDeliveryResultV1({ outcome: 'delivered', externalId: 'max-1', resolvedChatId: null })).toBeNull()
        expect(readTextDeliveryResultV1(undefined)).toBeNull()
        expect(readTextDeliveryResultV1({ evidence: 'delivered', providerMessageId: 'x' })).toBeNull()
    })

    it('reads provider acceptance only with the provider id of this message', () => {
        expect(readTextDeliveryResultV1({ evidence: 'provider_ack', providerMessageId: 'tg-1' })).toEqual({ evidence: 'provider_ack', providerMessageId: 'tg-1' })
        expect(readTextDeliveryResultV1({ evidence: 'provider_ack', providerMessageId: '' })).toEqual({ evidence: 'client_action', providerMessageId: null })
        expect(readTextDeliveryResultV1({ evidence: 'provider_echo', providerMessageId: null })).toEqual({ evidence: 'client_action', providerMessageId: null })
        expect(readTextDeliveryResultV1({ evidence: 'client_action', providerMessageId: 'client-minted', resolvedChatId: 'max-9' }))
            .toEqual({ evidence: 'client_action', providerMessageId: 'client-minted', resolvedChatId: 'max-9' })
    })

    it('reads only a typed failure, and only its two provable outcomes', () => {
        expect(readChannelDeliveryErrorV1(channelDeliveryErrorV1('not connected', 'safe_to_redeliver', 'TELEGRAM_NOT_CONNECTED')))
            .toEqual({ outcome: 'safe_to_redeliver', code: 'TELEGRAM_NOT_CONNECTED' })
        expect(readChannelDeliveryErrorV1(channelDeliveryErrorV1('peer refused', 'terminal'))).toEqual({ outcome: 'terminal', code: null })
        expect(readChannelDeliveryErrorV1(new Error('timeout'))).toBeNull()
        expect(readChannelDeliveryErrorV1(Object.assign(new Error('x'), { name: 'ChannelDeliveryErrorV1', deliveryOutcome: 'unknown' }))).toBeNull()
        expect(readChannelDeliveryErrorV1({ name: 'ChannelDeliveryErrorV1', deliveryOutcome: 'terminal' })).toBeNull()
    })
})

describe('when a physical redelivery is due', () => {
    const T0 = Date.parse('2026-10-26T12:00:00.000Z')
    const at = (ms: number) => new Date(ms).toISOString()

    it('backs off min(2^attempt x 30 s, 10 min) before physical attempt `attempt`', () => {
        expect([1, 2, 3, 4, 5, 6, 40].map(physicalRetryBackoffMsV1)).toEqual([60000, 120000, 240000, 480000, 600000, 600000, 600000])
    })

    it('anchors on lastFailedAt; absent is 0 and unreadable is NaN', () => {
        expect(physicalRetryAnchorMsV1(at(T0))).toBe(T0)
        for (const absent of [undefined, null, '', 0, false]) expect(physicalRetryAnchorMsV1(absent)).toBe(0)
        for (const unreadable of ['not a date', '2026-13-01T00:00:00.000Z', {}]) expect(physicalRetryAnchorMsV1(unreadable)).toBeNaN()
    })

    it('is due exactly from anchor + backoff of the next attempt', () => {
        for (const retryAttempt of [undefined, 0, 1, 2, 3]) {
            const backoff = physicalRetryBackoffMsV1((retryAttempt ?? 0) + 1)
            const metadata = { retryAttempt, lastFailedAt: at(T0) }
            expect(isPhysicalRetryDueV1(metadata, T0 + backoff - 1)).toBe(false)
            expect(isPhysicalRetryDueV1(metadata, T0 + backoff)).toBe(true)
            expect(isPhysicalRetryDueV1(metadata, T0 + backoff + 1)).toBe(true)
        }
    })

    it('treats a missing or unreadable anchor as due, as retrySend always has', () => {
        for (const lastFailedAt of [undefined, null, '', 'garbage', '2026-02-30Tbad']) {
            expect(isPhysicalRetryDueV1({ retryAttempt: 2, lastFailedAt }, T0)).toBe(true)
        }
        for (const metadata of [undefined, null, 'x', [], {}]) expect(isPhysicalRetryDueV1(metadata, T0)).toBe(true)
    })

    it('is not due while the anchor lies in the future', () => {
        expect(isPhysicalRetryDueV1({ retryAttempt: 0, lastFailedAt: at(T0 + 1) }, T0)).toBe(false)
    })

    it('equals the rule retrySend applied before it was shared', () => {
        const legacyDue = (meta: any, now: number) => {
            const attempt = (meta.retryAttempt || 0) + 1
            const backoffMs = Math.min(Math.pow(2, attempt) * 30000, 10 * 60 * 1000)
            const lastFailed = meta.lastFailedAt ? new Date(meta.lastFailedAt).getTime() : 0
            return !(now - lastFailed < backoffMs)
        }
        const anchors = [undefined, null, '', 'garbage', at(T0), at(T0 - 59999), at(T0 - 60000), at(T0 - 600000), at(T0 + 5000), T0 - 120000]
        for (const retryAttempt of [undefined, null, 0, 1, 2, 3, 4, 9]) {
            for (const lastFailedAt of anchors) {
                const meta = { retryAttempt, lastFailedAt }
                expect(isPhysicalRetryDueV1(meta, T0)).toBe(legacyDue(meta, T0))
            }
        }
    })
})

describe('contactPermissionRefusalV1', () => {
    it('names the gate\'s two refusals and nothing else', () => {
        expect(contactPermissionRefusalV1(channelDeliveryErrorV1('MESSAGING_CONTACT_PERMISSION_REFUSED:restricted_message', 'terminal', 'MESSAGING_CONTACT_PERMISSION_REFUSED')))
            .toEqual({ code: 'CONTACT_COMMUNICATION_RESTRICTED', retryable: false, label: 'Связь с этим контактом ограничена: сообщение не отправлено' })
        expect(contactPermissionRefusalV1(channelDeliveryErrorV1('MESSAGING_CONTACT_PERMISSION_REFUSED:contact_unknown', 'terminal', 'MESSAGING_CONTACT_PERMISSION_REFUSED')))
            .toMatchObject({ code: 'CONTACT_COMMUNICATION_RESTRICTED', label: 'Контакт недоступен для связи: сообщение не отправлено' })
        expect(contactPermissionRefusalV1(channelDeliveryErrorV1('MESSAGING_CONTACT_PERMISSION_NOT_DISPATCHED:policy_unavailable', 'safe_to_redeliver', 'MESSAGING_CONTACT_PERMISSION_NOT_DISPATCHED')))
            .toMatchObject({ code: 'CONTACT_COMMUNICATION_PERMISSION_UNAVAILABLE', retryable: true })
        for (const other of [
            new Error('MESSAGING_CONTACT_PERMISSION_REFUSED:restricted_all'),
            channelDeliveryErrorV1('TELEGRAM_PEER_BLOCKED', 'terminal', 'TELEGRAM_PEER_BLOCKED'),
            null,
            'MESSAGING_CONTACT_PERMISSION_REFUSED',
        ]) expect(contactPermissionRefusalV1(other)).toBeNull()
    })
})
