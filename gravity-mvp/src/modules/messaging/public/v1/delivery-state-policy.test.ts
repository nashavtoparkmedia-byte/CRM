import { describe, expect, it } from 'vitest'
import { channelDeliveryErrorV1 } from './channel-delivery-runtime'
import {
    deliveryEvidenceRankV1,
    deliveryStateLabelV1,
    deriveDeliveryStateV1,
    isDeliveryStateV1,
    isProviderAcceptedEvidenceV1,
    newDeliveryEvidenceRecordV1,
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
