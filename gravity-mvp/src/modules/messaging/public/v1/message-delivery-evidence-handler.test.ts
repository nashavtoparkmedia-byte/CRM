import { beforeEach, describe, expect, it } from 'vitest'
import { PATCH_MESSAGE_DELIVERY_COMMAND_V2, PATCH_MESSAGE_DELIVERY_RESULT_V2 } from '../../../../contracts/messaging/v1'
import { deriveDeliveryStateV1, newDeliveryEvidenceRecordV1 } from './delivery-state-policy'
import {
    createApplyMessageDeliveryEvidenceHandlerV1,
    type DeliveryEvidenceRowV1,
    type DeliveryEvidenceWriteV1,
    type MessageDeliveryEvidencePortV1,
} from './message-delivery-evidence-handler'

// S2 — the one evidence command (DT §5 C4, tests 13, 16, 18–21).
//
// The port below is a stand-in for the Message table with the two properties
// the command rests on: externalId is unique (a violating write is refused as
// provider_id_taken), and apply is a compare-and-set on the row version.
// Its content lookup deliberately returns every same-text row in the window,
// whatever its state, so the handler's own candidate rule is what is tested.
// Every read and write is counted, so "before any query" is checkable.

const NOW = new Date('2026-10-04T12:00:00.000Z')
const CHAT = 'chat_1'

let rows: DeliveryEvidenceRowV1[]
let calls: { reads: number; writes: number; after: Array<{ messageId: string; promotedFromFailure: boolean }> }
let staleWrites: number
let clock = 0

function clone(row: DeliveryEvidenceRowV1): DeliveryEvidenceRowV1 {
    return { ...row, metadata: JSON.parse(JSON.stringify(row.metadata ?? {})), sentAt: new Date(row.sentAt), updatedAt: new Date(row.updatedAt) }
}

function stored(id: string): DeliveryEvidenceRowV1 {
    const row = rows.find(candidate => candidate.id === id)
    if (!row) throw new Error(`no row ${id}`)
    return row
}

function seed(id: string, overrides: Partial<DeliveryEvidenceRowV1> = {}): DeliveryEvidenceRowV1 {
    const row: DeliveryEvidenceRowV1 = {
        id,
        chatId: CHAT,
        direction: 'outbound',
        channel: 'telegram',
        type: 'text',
        content: 'Привет',
        status: 'sent',
        externalId: null,
        metadata: {},
        sentAt: new Date(NOW.getTime() - 30_000),
        updatedAt: new Date(++clock),
        ...overrides,
    }
    rows.push(row)
    return row
}

const port: MessageDeliveryEvidencePortV1 = {
    async findByProviderId(providerMessageId) {
        calls.reads += 1
        const row = rows.find(candidate => candidate.externalId === providerMessageId)
        return row ? clone(row) : null
    },
    async findUnsettledByContent(input) {
        calls.reads += 1
        return rows
            .filter(row => row.chatId === input.chatId && row.channel === input.channel && row.direction === 'outbound'
                && row.type === 'text' && row.content === input.content && row.externalId === null
                && row.sentAt >= input.sentFrom && row.sentAt <= input.sentTo)
            .sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime())
            .map(clone)
    },
    async apply(row, write: DeliveryEvidenceWriteV1) {
        calls.writes += 1
        if (staleWrites > 0) {
            staleWrites -= 1
            stored(row.id).updatedAt = new Date(++clock)
            return 'stale'
        }
        const current = stored(row.id)
        if (current.updatedAt.getTime() !== row.updatedAt.getTime()) return 'stale'
        if (write.externalId && rows.some(other => other.id !== row.id && other.externalId === write.externalId)) return 'provider_id_taken'
        current.status = write.status
        if (write.externalId) current.externalId = write.externalId
        current.metadata = JSON.parse(JSON.stringify(write.metadata))
        current.updatedAt = new Date(++clock)
        return 'applied'
    },
    async afterApplied(input) {
        calls.after.push({ messageId: input.messageId, promotedFromFailure: input.promotedFromFailure })
    },
    now: () => NOW,
}

const apply = createApplyMessageDeliveryEvidenceHandlerV1(port)

function command(overrides: Record<string, unknown> = {}) {
    return {
        contract: PATCH_MESSAGE_DELIVERY_COMMAND_V2,
        chatId: CHAT,
        channel: 'telegram',
        providerMessageId: 'tg-100',
        evidence: 'provider_echo',
        content: 'Привет',
        providerSentAt: NOW,
        ...overrides,
    }
}

function state(id: string) {
    return deriveDeliveryStateV1(stored(id))
}

beforeEach(() => {
    rows = []
    calls = { reads: 0, writes: 0, after: [] }
    staleWrites = 0
})

describe('input', () => {
    it('rejects an empty or blank provider id before any query is built (DT 21)', async () => {
        await expect(apply(command({ providerMessageId: '' }))).rejects.toThrow('providerMessageId is required')
        await expect(apply(command({ providerMessageId: '   ' }))).rejects.toThrow('providerMessageId is required')
        await expect(apply(command({ providerMessageId: undefined }))).rejects.toThrow('providerMessageId is required')
        expect(calls.reads + calls.writes).toBe(0)
    })

    it('never takes a client action, a UI action or a status as evidence', async () => {
        for (const evidence of ['client_action', 'ui_send_action', 'delivered', 'sent', undefined]) {
            await expect(apply(command({ evidence }))).rejects.toThrow('evidence is invalid')
        }
        expect(calls.reads + calls.writes).toBe(0)
    })

    it('refuses the v1 contract, unknown fields and malformed values', async () => {
        await expect(apply(command({ contract: 'messaging.PatchMessageDeliveryCommand.v1' }))).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTRACT_VERSION' })
        await expect(apply(command({ status: 'delivered' }))).rejects.toThrow('unsupported field')
        await expect(apply(command({ channel: 'avito' }))).rejects.toThrow('channel is invalid')
        await expect(apply(command({ providerSentAt: '2026-10-04' }))).rejects.toThrow('providerSentAt must be a valid Date')
        expect(calls.reads + calls.writes).toBe(0)
    })

    it('refuses a signal the provider does not have, before any query', async () => {
        seed('m1', { externalId: 'tg-100', metadata: { delivery: newDeliveryEvidenceRecordV1('provider_ack', 'send', NOW) } })
        await expect(apply(command({ evidence: 'device_receipt' }))).resolves.toEqual({
            contract: PATCH_MESSAGE_DELIVERY_RESULT_V2, outcome: 'refused', messageId: null, matchedBy: null, reason: 'provider_unsupported',
        })
        expect(calls.reads + calls.writes).toBe(0)
        expect(state('m1')).toBe('provider_accepted')
    })
})

describe('matching', () => {
    it('correlates by the exact provider id first, and climbs ack → device → read (DT 13)', async () => {
        seed('m1', { channel: 'whatsapp', externalId: 'wa-client-minted', metadata: { delivery: newDeliveryEvidenceRecordV1('client_action', 'send', NOW) } })
        const wa = (evidence: string) => command({ channel: 'whatsapp', providerMessageId: 'wa-client-minted', evidence, content: undefined })

        expect(state('m1')).toBe('send_requested')
        await expect(apply(wa('provider_ack'))).resolves.toMatchObject({ outcome: 'applied', messageId: 'm1', matchedBy: 'provider_id' })
        expect(state('m1')).toBe('provider_accepted')
        await expect(apply(wa('device_receipt'))).resolves.toMatchObject({ outcome: 'applied', messageId: 'm1' })
        expect(state('m1')).toBe('delivered')
        await expect(apply(wa('read_receipt'))).resolves.toMatchObject({ outcome: 'applied', messageId: 'm1' })
        expect(state('m1')).toBe('read')
        expect(stored('m1').externalId).toBe('wa-client-minted')
    })

    it('touches no row for an ack whose id no row holds', async () => {
        seed('m1', { channel: 'whatsapp', externalId: 'wa-1' })
        await expect(apply(command({ channel: 'whatsapp', providerMessageId: 'wa-unknown', evidence: 'provider_ack', content: undefined })))
            .resolves.toMatchObject({ outcome: 'no_match', messageId: null })
        expect(calls.writes).toBe(0)
    })

    it('gives two echoes of a twice-sent text to the two rows, oldest first, and a third to nobody (DT 18)', async () => {
        seed('older', { sentAt: new Date(NOW.getTime() - 60_000) })
        seed('newer', { sentAt: new Date(NOW.getTime() - 20_000) })

        await expect(apply(command({ providerMessageId: 'tg-1' }))).resolves.toMatchObject({ outcome: 'applied', messageId: 'older', matchedBy: 'unresolved_content' })
        await expect(apply(command({ providerMessageId: 'tg-2' }))).resolves.toMatchObject({ outcome: 'applied', messageId: 'newer', matchedBy: 'unresolved_content' })
        await expect(apply(command({ providerMessageId: 'tg-3' }))).resolves.toMatchObject({ outcome: 'no_match' })
        expect(stored('older').externalId).toBe('tg-1')
        expect(stored('newer').externalId).toBe('tg-2')
    })

    it('never gives an echo to a failure proven safe to retry or refused (DT 19)', async () => {
        seed('safe', { status: 'failed', metadata: { deliveryOutcome: 'safe_to_redeliver', retryable: true, errorSchemaVersion: 2 } })
        seed('terminal', { status: 'failed', metadata: { deliveryOutcome: 'terminal', retryable: false, errorSchemaVersion: 2 } })
        await expect(apply(command())).resolves.toMatchObject({ outcome: 'no_match' })
        expect(calls.writes).toBe(0)
        expect(state('safe')).toBe('failed_safe_to_retry')
        expect(state('terminal')).toBe('failed_not_safe_to_retry')
    })

    it('promotes the same row for an echo 20 s or 140 s late (DT 20)', async () => {
        const sentAt = new Date(NOW.getTime() - 140_000)
        seed('late140', { sentAt, status: 'failed', metadata: { deliveryOutcome: 'unknown', retryable: false, errorSchemaVersion: 2 } })
        seed('late20', { content: 'Второе', sentAt: new Date(NOW.getTime() - 20_000) })
        await expect(apply(command({ providerMessageId: 'tg-140' }))).resolves.toMatchObject({ outcome: 'applied', messageId: 'late140' })
        await expect(apply(command({ providerMessageId: 'tg-20', content: 'Второе' }))).resolves.toMatchObject({ outcome: 'applied', messageId: 'late20' })
        expect(rows).toHaveLength(2)
    })

    it('still matches when the provider clock reads a second behind the CRM row', async () => {
        seed('m1', { sentAt: new Date(NOW.getTime() + 900) })
        await expect(apply(command())).resolves.toMatchObject({ outcome: 'applied', messageId: 'm1' })
    })

    it('ignores stale evidence: a read-back of an older message with the same text', async () => {
        seed('fresh', { sentAt: NOW })
        await expect(apply(command({ evidence: 'history_readback', providerSentAt: new Date(NOW.getTime() - 3_600_000) })))
            .resolves.toMatchObject({ outcome: 'no_match' })
        await expect(apply(command({ evidence: 'history_readback', providerSentAt: new Date(NOW.getTime() + 11 * 60_000) })))
            .resolves.toMatchObject({ outcome: 'no_match' })
        expect(state('fresh')).toBe('send_requested')
    })

    it('never gives evidence to a row that holds another provider id', async () => {
        seed('m1', { externalId: 'tg-old', metadata: { delivery: newDeliveryEvidenceRecordV1('client_action', 'send', NOW) } })
        await expect(apply(command({ providerMessageId: 'tg-new' }))).resolves.toMatchObject({ outcome: 'no_match' })
        expect(stored('m1').externalId).toBe('tg-old')
    })

    it('matches content only within the same conversation, channel and kind of message', async () => {
        seed('other-chat', { chatId: 'chat_2' })
        seed('other-channel', { channel: 'max' })
        seed('inbound', { direction: 'inbound' })
        seed('image', { type: 'image' })
        await expect(apply(command())).resolves.toMatchObject({ outcome: 'no_match' })
        expect(calls.writes).toBe(0)
    })
})

describe('provider-id collision', () => {
    it('refuses an id another conversation, direction or channel holds, and writes nothing', async () => {
        seed('elsewhere', { chatId: 'chat_2', externalId: 'tg-100', metadata: { delivery: newDeliveryEvidenceRecordV1('provider_ack', 'send', NOW) } })
        seed('candidate')
        await expect(apply(command())).resolves.toMatchObject({ outcome: 'refused', reason: 'provider_id_collision', messageId: null })

        rows = []
        seed('inbound', { direction: 'inbound', externalId: 'tg-100', status: 'delivered' })
        await expect(apply(command())).resolves.toMatchObject({ outcome: 'refused', reason: 'provider_id_collision' })

        rows = []
        seed('max-row', { channel: 'max', externalId: 'tg-100' })
        await expect(apply(command())).resolves.toMatchObject({ outcome: 'refused', reason: 'provider_id_collision' })
        expect(calls.writes).toBe(0)
    })

    it('refuses when another row takes the id between the lookup and the write', async () => {
        seed('candidate')
        const taken = port.apply
        port.apply = async (row, write) => {
            seed('racer', { chatId: 'chat_2', externalId: write.externalId ?? null })
            port.apply = taken
            return taken(row, write)
        }
        await expect(apply(command())).resolves.toMatchObject({ outcome: 'refused', reason: 'provider_id_collision', messageId: 'candidate' })
        expect(state('candidate')).toBe('send_requested')
    })
})

describe('monotonic application', () => {
    it('promotes an indeterminate row once, clearing its failure (late evidence after indeterminate)', async () => {
        seed('m1', {
            status: 'failed',
            metadata: {
                quotedMsgId: 'q1',
                error: 'MESSAGING_SEND_OUTCOME_UNKNOWN: timeout',
                errorCode: 'TIMEOUT',
                errorSchemaVersion: 2,
                retryable: false,
                deliveryOutcome: 'unknown',
                lastFailedAt: NOW.toISOString(),
                retryAttempt: 0,
                maxRetries: 3,
            },
        })
        expect(state('m1')).toBe('indeterminate')

        await expect(apply(command())).resolves.toMatchObject({ outcome: 'applied', messageId: 'm1' })

        const row = stored('m1')
        expect(row.status).toBe('sent')
        expect(row.externalId).toBe('tg-100')
        expect(row.metadata).toEqual({
            quotedMsgId: 'q1',
            retryAttempt: 0,
            maxRetries: 3,
            delivery: { v: 1, evidence: 'provider_echo', evidenceAt: NOW.toISOString(), source: 'echo' },
        })
        expect(state('m1')).toBe('provider_accepted')
        expect(calls.after).toEqual([{ messageId: 'm1', promotedFromFailure: true }])
    })

    it('applies a duplicate once: the repeat is unchanged and runs nothing again (idempotent reapplication)', async () => {
        seed('m1')
        await expect(apply(command())).resolves.toMatchObject({ outcome: 'applied' })
        const settled = clone(stored('m1'))
        await expect(apply(command())).resolves.toMatchObject({ outcome: 'unchanged', messageId: 'm1', matchedBy: 'provider_id' })
        await expect(apply(command({ evidence: 'provider_ack' }))).resolves.toMatchObject({ outcome: 'unchanged' })
        expect(stored('m1')).toEqual(settled)
        expect(calls.after).toHaveLength(1)
    })

    it('never demotes: a late device receipt after read, an ack after delivered (DT 16, out of order)', async () => {
        seed('m1', { channel: 'whatsapp', externalId: 'wa-1', status: 'read', metadata: { delivery: newDeliveryEvidenceRecordV1('read_receipt', 'ack', NOW) } })
        seed('m2', { channel: 'whatsapp', externalId: 'wa-2', status: 'delivered' })
        const wa = (providerMessageId: string, evidence: string) => command({ channel: 'whatsapp', providerMessageId, evidence, content: undefined })

        await expect(apply(wa('wa-1', 'device_receipt'))).resolves.toMatchObject({ outcome: 'unchanged' })
        await expect(apply(wa('wa-1', 'provider_ack'))).resolves.toMatchObject({ outcome: 'unchanged' })
        await expect(apply(wa('wa-2', 'provider_echo'))).resolves.toMatchObject({ outcome: 'unchanged' })
        expect(state('m1')).toBe('read')
        expect(state('m2')).toBe('delivered')
        expect(calls.writes).toBe(0)
    })

    it('never claims more than the evidence supports (impossible promotion)', async () => {
        seed('m1')
        await apply(command({ evidence: 'provider_ack' }))
        expect(stored('m1').status).toBe('sent')
        expect(state('m1')).toBe('provider_accepted')
    })

    it('revokes an in-flight retry lease, so that attempt cannot write over the proof', async () => {
        seed('m1', { metadata: { retryLeaseId: 'lease-1', retryStartedAt: NOW.toISOString(), retryAttempt: 1 } })
        await apply(command())
        expect(stored('m1').metadata).not.toHaveProperty('retryLeaseId')
        expect(stored('m1').metadata).toMatchObject({ retryAttempt: 1, delivery: { evidence: 'provider_echo' } })
    })

    it('resolves again from the start when the row changed under it', async () => {
        seed('m1')
        staleWrites = 1
        await expect(apply(command())).resolves.toMatchObject({ outcome: 'applied', messageId: 'm1' })
        expect(calls.writes).toBe(2)
    })

    it('gives up after bounded contention without writing', async () => {
        seed('m1')
        staleWrites = 10
        await expect(apply(command())).resolves.toMatchObject({ outcome: 'refused', reason: 'contention' })
        expect(calls.writes).toBe(3)
        expect(state('m1')).toBe('send_requested')
    })
})
