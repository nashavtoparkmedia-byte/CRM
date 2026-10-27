import { describe, expect, it } from 'vitest'
import type { ContactConversationsEntryV1 } from '../../../contracts/messaging/v1/contact-conversations-query'
import { SendToContactValidationError } from '../../../contracts/messaging/v1/send-to-contact-command'
import { channelDeliveryErrorV1 } from '../public/v1/channel-delivery-runtime'
import {
    createSendToContactHandlerV1,
    sendToContactPermissionRefusalV1,
    type SendToContactMessageRowV1,
    type SendToContactPortsV1,
} from './send-to-contact-handler'
import { prepareSendToContactRequestV1 } from './send-to-contact-request'

const command = {
    contract: 'messaging.SendToContactCommand.v1',
    requestId: 'run-1:step-1',
    contactId: 'contact-1',
    content: 'Здравствуйте',
}
const SHA = prepareSendToContactRequestV1(command).semanticPayloadSha256

function allow(contactId: string, canonicalContactId = 'canonical-1') {
    return {
        contract: 'contacts.ContactCommunicationPermissionResult.v1' as const,
        decision: 'allow' as const,
        retryable: false,
        reason: 'no_restriction' as const,
        requestedContactId: contactId,
        communicationClass: 'message',
        canonicalContactId,
        policyVersion: 0,
    }
}

function deny(reason: string, retryable: boolean) {
    return { ...allow('contact-1'), decision: 'deny' as const, reason: reason as never, retryable, canonicalContactId: null, policyVersion: null }
}

function entry(channels: Array<[string, string[]]>, extra: Record<string, unknown> = {}): ContactConversationsEntryV1 {
    return {
        contactId: 'contact-1',
        status: 'found',
        canonicalContactId: 'canonical-1',
        channels: channels.map(([channel, ids]) => ({
            channel: channel as never,
            primaryConversationId: ids[0],
            conversations: ids.map(conversationId => ({ conversationId, lastActivityAt: null })),
        })),
        latestConversationId: null,
        truncated: false,
        ...extra,
    } as ContactConversationsEntryV1
}

const sentRow = (overrides: Partial<SendToContactMessageRowV1> = {}): SendToContactMessageRowV1 => ({
    id: 'msg-1', channel: 'telegram', direction: 'outbound', status: 'sent', metadata: {}, ...overrides,
})

/**
 * An in-memory world: one intent table, one Message table keyed by
 * clientMessageId, and a call log of every port reached.
 */
function world(options: {
    permission?: unknown
    conversations?: ContactConversationsEntryV1 | Error
    proofs?: Record<string, Error>
    admit?: (input: { clientMessageId: string }, messages: Map<string, SendToContactMessageRowV1>) => Promise<{ replayed: boolean }>
    claimError?: Error
} = {}) {
    const calls: string[] = []
    const intents = new Map<string, string>()
    const messages = new Map<string, SendToContactMessageRowV1>()
    const ports: SendToContactPortsV1 = {
        async claimIntent(requestId, sha) {
            calls.push(`claim:${requestId}`)
            if (options.claimError) throw options.claimError
            if (!intents.has(requestId)) intents.set(requestId, sha)
            return intents.get(requestId)!
        },
        async findAdmittedMessage(clientMessageId) {
            calls.push(`find:${clientMessageId}`)
            return messages.get(clientMessageId) ?? null
        },
        async readContactPermission(contactId) {
            calls.push(`permission:${contactId}`)
            if (options.permission instanceof Error) throw options.permission
            return ('permission' in options ? options.permission : allow(contactId)) as never
        },
        async readContactConversations(contactId) {
            calls.push(`conversations:${contactId}`)
            const answer = options.conversations ?? entry([['telegram', ['t1']]])
            if (answer instanceof Error) throw answer
            return answer
        },
        async proveRoute(candidate) {
            calls.push(`prove:${candidate.conversationId}`)
            const refusal = options.proofs?.[candidate.conversationId]
            if (refusal) throw refusal
            return { chatId: candidate.conversationId, channel: candidate.channel }
        },
        async admit(input) {
            calls.push(`admit:${input.conversationId}:${input.expectedCanonicalContactId}`)
            if (options.admit) return options.admit(input, messages)
            messages.set(input.clientMessageId, sentRow())
            return { replayed: false }
        },
    }
    return { calls, intents, messages, ports, send: createSendToContactHandlerV1(ports) }
}

describe('sendToContactV1 sequencing', () => {
    it('claims, looks for a replay, reads P1, discovers one route and admits exactly once, in that order', async () => {
        const w = world()
        expect(await w.send(command)).toEqual({
            contract: 'messaging.SendToContactResult.v1',
            outcome: 'admitted',
            requestId: 'run-1:step-1',
            replayed: false,
            messageId: 'msg-1',
            channel: 'telegram',
            deliveryState: 'send_requested',
        })
        expect(w.calls).toEqual([
            'claim:run-1:step-1',
            'find:stc:run-1:step-1',
            'permission:contact-1',
            'conversations:contact-1',
            'prove:t1',
            'admit:t1:canonical-1',
            'find:stc:run-1:step-1',
        ])
        expect(w.intents.get('run-1:step-1')).toBe(SHA)
    })

    it('throws on a malformed or unsupported command before claiming anything', async () => {
        const w = world()
        for (const input of [{ ...command, content: ' ' }, { ...command, contract: 'messaging.SendToContactCommand.v2' }, { ...command, chatId: 'x' }]) {
            await expect(w.send(input)).rejects.toBeInstanceOf(SendToContactValidationError)
        }
        expect(w.calls).toEqual([])
    })

    it('replays an admitted intent from its Message alone: no permission, route or send', async () => {
        const w = world()
        await w.send(command)
        w.messages.set('stc:run-1:step-1', sentRow({ status: 'delivered' }))
        w.calls.length = 0
        expect(await w.send(command)).toMatchObject({ outcome: 'admitted', replayed: true, deliveryState: 'delivered' })
        expect(w.calls).toEqual(['claim:run-1:step-1', 'find:stc:run-1:step-1'])
    })

    it('answers a changed payload under a claimed requestId with idempotency_conflict and nothing else, forever', async () => {
        const w = world()
        await w.send(command)
        for (const changed of [{ content: 'другой текст' }, { contactId: 'contact-2' }, { allowedChannels: ['telegram'] }]) {
            w.calls.length = 0
            expect(await w.send({ ...command, ...changed })).toEqual({
                contract: 'messaging.SendToContactResult.v1', outcome: 'idempotency_conflict', requestId: 'run-1:step-1',
            })
            expect(w.calls).toEqual(['claim:run-1:step-1'])
        }
    })

    it('binds the requestId even when the first request is refused before any Message', async () => {
        const refusals = [
            world({ permission: deny('restricted_all', false) }),
            world({ conversations: entry([]) }),
            world({ conversations: entry([['telegram', ['t1']], ['whatsapp', ['w1']]]) }),
            world({ conversations: entry([['telegram', ['t1']]], { truncated: true }) }),
        ]
        for (const w of refusals) {
            expect((await w.send(command)).outcome).toBe('refused')
            expect(w.messages.size).toBe(0)
            expect((await w.send({ ...command, content: 'changed' })).outcome).toBe('idempotency_conflict')
            // The same payload is simply evaluated again.
            w.calls.length = 0
            expect((await w.send(command)).outcome).toBe('refused')
            expect(w.calls).toContain('permission:contact-1')
        }
    })

    it('reports a concurrent duplicate of the same intent as a replay of the one Message', async () => {
        const w = world({
            admit: async (input, messages) => {
                messages.set(input.clientMessageId, sentRow({ id: 'msg-winner' }))
                return { replayed: true }
            },
        })
        expect(await w.send(command)).toMatchObject({ outcome: 'admitted', replayed: true, messageId: 'msg-winner' })
    })

    it('passes the request narrowing to discovery and never widens it', async () => {
        const w = world({ conversations: entry([['telegram', ['t1']], ['whatsapp', ['w1']]]) })
        expect(await w.send({ ...command, allowedChannels: ['whatsapp'] })).toMatchObject({ outcome: 'admitted' })
        expect(w.calls).toContain('admit:w1:canonical-1')
        expect(w.calls).not.toContain('prove:t1')
    })
})

describe('sendToContactV1 refusals', () => {
    const refusalOf = async (w: ReturnType<typeof world>) => {
        const result = await w.send(command)
        expect(result.outcome).toBe('refused')
        expect(w.messages.size).toBe(0)
        const { contract: _contract, outcome: _outcome, requestId: _requestId, ...rest } = result as Record<string, unknown>
        return rest
    }

    it('maps every Contacts permission answer at P1, and stops there', async () => {
        const table: Array<[unknown, Record<string, unknown>]> = [
            [deny('restricted_all', false), { reason: 'contact_restricted', retryable: false }],
            [deny('restricted_message', false), { reason: 'contact_restricted', retryable: false }],
            [deny('contact_unknown', false), { reason: 'contact_unknown', retryable: false }],
            [deny('contact_archived', false), { reason: 'contact_archived', retryable: false }],
            [deny('unsupported_communication_class', false), { reason: 'permission_unavailable', retryable: false }],
            [deny('policy_unavailable', true), { reason: 'permission_unavailable', retryable: true }],
            [deny('lineage_unsafe', true), { reason: 'permission_unavailable', retryable: true }],
            [{ ...allow('contact-1'), canonicalContactId: null }, { reason: 'permission_unavailable', retryable: true }],
            [null, { reason: 'permission_unavailable', retryable: true }],
            [new Error('store down'), { reason: 'permission_unavailable', retryable: true }],
        ]
        for (const [permission, expected] of table) {
            const w = world({ permission })
            expect(await refusalOf(w)).toEqual(expected)
            expect(w.calls.some(call => call.startsWith('conversations:') || call.startsWith('admit:'))).toBe(false)
        }
    })

    it('reports route refusals exactly as discovery decided them, before any send', async () => {
        expect(await refusalOf(world({ conversations: entry([]) }))).toEqual({ reason: 'route_unavailable', retryable: false, detail: 'no_conversation' })
        expect(await refusalOf(world({ conversations: entry([['telegram', ['t1']], ['max', ['m1']]]) })))
            .toEqual({ reason: 'route_ambiguous', retryable: false, candidateChannels: ['max', 'telegram'] })
        expect(await refusalOf(world({ conversations: entry([['telegram', ['t1']]], { canonicalContactId: 'canonical-2' }) })))
            .toEqual({ reason: 'route_evidence_incomplete', retryable: true, detail: 'lineage_moved' })
        expect(await refusalOf(world({ proofs: { t1: new Error('CONTACT_CONVERSATION_IDENTITY_NOT_SENDABLE:identity_unreachable') } })))
            .toEqual({ reason: 'route_unavailable', retryable: false, detail: 'identity_not_sendable', identityStatus: 'identity_unreachable' })
    })

    it('maps an engine refusal before admission (P2 flipped, lineage moved, route changed, failure)', async () => {
        const failing = (error: Error) => world({ admit: async () => { throw error } })
        expect(await refusalOf(failing(channelDeliveryErrorV1('MESSAGING_CONTACT_PERMISSION_REFUSED:restricted_message', 'terminal', 'MESSAGING_CONTACT_PERMISSION_REFUSED'))))
            .toEqual({ reason: 'contact_restricted', retryable: false })
        expect(await refusalOf(failing(channelDeliveryErrorV1('MESSAGING_CONTACT_PERMISSION_REFUSED:contact_archived', 'terminal', 'MESSAGING_CONTACT_PERMISSION_REFUSED'))))
            .toEqual({ reason: 'contact_archived', retryable: false })
        expect(await refusalOf(failing(channelDeliveryErrorV1('MESSAGING_CONTACT_PERMISSION_NOT_DISPATCHED:policy_unavailable', 'safe_to_redeliver', 'MESSAGING_CONTACT_PERMISSION_NOT_DISPATCHED'))))
            .toEqual({ reason: 'permission_unavailable', retryable: true })
        expect(await refusalOf(failing(new Error('MESSAGING_SEND_TO_CONTACT_LINEAGE_MOVED'))))
            .toEqual({ reason: 'route_evidence_incomplete', retryable: true, detail: 'lineage_moved' })
        expect(await refusalOf(failing(new Error('CONTACT_CONVERSATION_TRANSPORT_UNBOUND'))))
            .toEqual({ reason: 'route_unavailable', retryable: false, detail: 'transport_unbound' })
        expect(await refusalOf(failing(new Error('database is down'))))
            .toEqual({ reason: 'messaging_unavailable', retryable: true })
    })

    it('answers with the Message whenever one exists, even if the engine threw after admitting it', async () => {
        const w = world({
            admit: async (input, messages) => {
                messages.set(input.clientMessageId, sentRow({ status: 'failed', metadata: { deliveryOutcome: 'unknown' } }))
                throw new Error('settle write failed')
            },
        })
        expect(await w.send(command)).toMatchObject({ outcome: 'admitted', replayed: false, deliveryState: 'indeterminate', failureClass: 'outcome_unknown' })
    })

    it('refuses as unavailable when the identity store cannot be claimed, and reaches nothing else', async () => {
        const w = world({ claimError: new Error('connection refused') })
        expect(await w.send(command)).toEqual({
            contract: 'messaging.SendToContactResult.v1', outcome: 'refused', requestId: 'run-1:step-1', reason: 'messaging_unavailable', retryable: true,
        })
        expect(w.calls).toEqual(['claim:run-1:step-1'])
    })
})

describe('the admitted Message, described', () => {
    const describeRow = async (row: SendToContactMessageRowV1) => {
        const w = world({ admit: async (input, messages) => { messages.set(input.clientMessageId, row); return { replayed: false } } })
        return w.send(command)
    }

    it('derives delivery state and failure class from the row as it is now', async () => {
        const failed = (metadata: Record<string, unknown>) => sentRow({ status: 'failed', metadata })
        const table: Array<[SendToContactMessageRowV1, Record<string, unknown>]> = [
            [sentRow({ status: 'delivered' }), { deliveryState: 'delivered' }],
            [sentRow({ status: 'read' }), { deliveryState: 'read' }],
            [sentRow({ metadata: { delivery: { v: 1, evidence: 'provider_ack', evidenceAt: '2026-10-27T00:00:00.000Z', source: 'send' } } }), { deliveryState: 'provider_accepted' }],
            [failed({ retryable: true, deliveryOutcome: 'safe_to_redeliver', errorSchemaVersion: 2 }), { deliveryState: 'failed_safe_to_retry', failureClass: 'not_dispatched' }],
            [failed({ retryable: false, deliveryOutcome: 'terminal', errorSchemaVersion: 2, errorCode: 'TELEGRAM_PEER_BLOCKED' }), { deliveryState: 'failed_not_safe_to_retry', failureClass: 'provider_refused' }],
            [failed({ retryable: false, deliveryOutcome: 'terminal', errorSchemaVersion: 2, errorCode: 'MESSAGING_CONTACT_PERMISSION_REFUSED' }), { deliveryState: 'failed_not_safe_to_retry', failureClass: 'permission_refused' }],
            [failed({ retryable: false, deliveryOutcome: 'terminal', errorSchemaVersion: 2, errorCode: 'UNKNOWN', error: 'Telegram delivery failed: MESSAGING_CONTACT_PERMISSION_REFUSED:restricted_all' }), { deliveryState: 'failed_not_safe_to_retry', failureClass: 'permission_refused' }],
            [failed({ deliveryOutcome: 'unknown' }), { deliveryState: 'indeterminate', failureClass: 'outcome_unknown' }],
        ]
        for (const [row, expected] of table) {
            const result = await describeRow(row) as Record<string, unknown>
            expect(result).toMatchObject({ outcome: 'admitted', ...expected })
            if (!('failureClass' in expected)) expect('failureClass' in result).toBe(false)
        }
    })

    it('never describes a row it cannot read as a sendable channel send', async () => {
        for (const row of [sentRow({ channel: 'phone' }), sentRow({ channel: null }), sentRow({ direction: 'inbound' })]) {
            expect(await describeRow(row)).toMatchObject({ outcome: 'refused', reason: 'messaging_unavailable', retryable: true })
        }
    })
})

describe('sendToContactPermissionRefusalV1', () => {
    it('leaves which denials stand to Contacts', () => {
        expect(sendToContactPermissionRefusalV1('restricted_all', true)).toEqual({ reason: 'permission_unavailable', retryable: true })
        expect(sendToContactPermissionRefusalV1('something_new', false)).toEqual({ reason: 'permission_unavailable', retryable: false })
    })
})
