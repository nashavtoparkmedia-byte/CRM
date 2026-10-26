import { describe, expect, it } from 'vitest'
import type {
    ContactConversationsEntryV1,
    ContactConversationsFoundV1,
} from '../../../contracts/messaging/v1/contact-conversations-query'
import type { SendToContactChannelV1 } from '../../../contracts/messaging/v1/send-to-contact-command'
import {
    classifySendToContactRouteProofFailureV1,
    discoverSendToContactRouteV1,
    sendToContactRouteCandidatesV1,
    type SendToContactRouteCandidateV1,
    type SendToContactRouteDiscoveryInputV1,
} from './send-to-contact-routing'

type Channel = 'telegram' | 'whatsapp' | 'max' | 'phone' | 'avito'

function found(channels: Array<[Channel, string[]]>, overrides: Partial<ContactConversationsFoundV1> = {}): ContactConversationsFoundV1 {
    return {
        contactId: 'contact-1',
        status: 'found',
        canonicalContactId: 'canonical-1',
        channels: channels.map(([channel, ids]) => ({
            channel,
            primaryConversationId: ids[0],
            conversations: ids.map(conversationId => ({ conversationId, lastActivityAt: null })),
        })),
        latestConversationId: channels[0]?.[1][0] ?? null,
        truncated: false,
        ...overrides,
    }
}

const input: SendToContactRouteDiscoveryInputV1 = { contactId: 'contact-1', expectedCanonicalContactId: 'canonical-1' }

/**
 * Fake ports. `proofs` names what the route proof does for each conversation:
 * 'ok' proves it, an Error is thrown, any other value is returned as the proof.
 */
function ports(entry: ContactConversationsEntryV1 | Error, proofs: Record<string, 'ok' | Error | unknown> = {}) {
    const calls: string[] = []
    return {
        calls,
        ports: {
            async readContactConversations(contactId: string) {
                calls.push(`read:${contactId}`)
                if (entry instanceof Error) throw entry
                return entry
            },
            async proveRoute(candidate: SendToContactRouteCandidateV1) {
                calls.push(`prove:${candidate.conversationId}`)
                const proof = candidate.conversationId in proofs ? proofs[candidate.conversationId] : 'ok'
                if (proof instanceof Error) throw proof
                if (proof === 'ok') return { chatId: candidate.conversationId, channel: candidate.channel }
                return proof as { chatId: string | null; channel: string }
            },
        },
    }
}

const refusedWith = (code: string) => new Error(code)

describe('sendToContactRouteCandidatesV1', () => {
    it('takes every conversation on a sendable channel, in entry order, ignoring phone and avito', () => {
        const entry = found([['phone', ['p1']], ['max', ['m1', 'm2']], ['avito', ['a1']], ['telegram', ['t1']]])
        expect(sendToContactRouteCandidatesV1(entry)).toEqual({
            kind: 'candidates',
            candidates: [
                { conversationId: 'm1', channel: 'max' },
                { conversationId: 'm2', channel: 'max' },
                { conversationId: 't1', channel: 'telegram' },
            ],
        })
    })

    it('narrows to the allowed channels only', () => {
        const entry = found([['max', ['m1']], ['telegram', ['t1']], ['whatsapp', ['w1']]])
        expect(sendToContactRouteCandidatesV1(entry, ['whatsapp', 'telegram'])).toEqual({
            kind: 'candidates',
            candidates: [{ conversationId: 't1', channel: 'telegram' }, { conversationId: 'w1', channel: 'whatsapp' }],
        })
    })

    it('says no_conversation when no sendable conversation exists, whatever the narrowing', () => {
        expect(sendToContactRouteCandidatesV1(found([]))).toEqual({ kind: 'none', detail: 'no_conversation' })
        expect(sendToContactRouteCandidatesV1(found([['phone', ['p1']], ['avito', ['a1']]]), ['telegram']))
            .toEqual({ kind: 'none', detail: 'no_conversation' })
    })

    it('says not_in_allowed_channels when conversations exist only outside the narrowing', () => {
        expect(sendToContactRouteCandidatesV1(found([['max', ['m1']]]), ['telegram', 'whatsapp']))
            .toEqual({ kind: 'none', detail: 'not_in_allowed_channels' })
    })
})

describe('classifySendToContactRouteProofFailureV1', () => {
    it('maps the route proof\'s closed refusal set', () => {
        const table: Array<[string, unknown]> = [
            ['CONTACT_CONVERSATION_IDENTITY_REQUIRED', { detail: 'identity_binding_mismatch' }],
            ['CONTACT_CONVERSATION_IDENTITY_BINDING_MISMATCH', { detail: 'identity_binding_mismatch' }],
            ['CONTACT_CONVERSATION_NOT_PRIVATE', { detail: 'conversation_not_private' }],
            ['CONTACT_CONVERSATION_TRANSPORT_UNBOUND', { detail: 'transport_unbound' }],
            ['CONTACT_CONVERSATION_TRANSPORT_MISMATCH', { detail: 'transport_mismatch' }],
            ['CONTACT_CONVERSATION_PROVIDER_TRANSPORT_MISMATCH', { detail: 'transport_mismatch' }],
            ['MAX_BOT_DELIVERY_TRANSPORT_UNAVAILABLE', { detail: 'transport_unbound' }],
            ['CONTACT_CONVERSATION_IDENTITY_NOT_SENDABLE:identity_unreachable', { detail: 'identity_not_sendable', identityStatus: 'identity_unreachable' }],
            ['CONTACT_CONVERSATION_IDENTITY_NOT_SENDABLE:no_identity', { detail: 'identity_not_sendable', identityStatus: 'no_identity' }],
            ['CONTACT_CONVERSATION_IDENTITY_NOT_SENDABLE:', { detail: 'identity_not_sendable' }],
            ['CONTACT_CONVERSATION_IDENTITY_NOT_SENDABLE:Bad Status!', { detail: 'identity_not_sendable' }],
        ]
        for (const [code, expected] of table) expect(classifySendToContactRouteProofFailureV1(refusedWith(code))).toEqual(expected)
    })

    it('proves nothing for any other failure (fail closed)', () => {
        for (const error of [
            refusedWith('OUTBOUND_CONVERSATION_IDENTITY_CAPABILITY_NOT_REGISTERED'),
            refusedWith('connect ECONNREFUSED'),
            refusedWith('constructor'),
            refusedWith('toString'),
            refusedWith('contact_conversation_not_private'),
            refusedWith(' CONTACT_CONVERSATION_NOT_PRIVATE'),
            'CONTACT_CONVERSATION_NOT_PRIVATE',
            { message: 'CONTACT_CONVERSATION_NOT_PRIVATE' },
            null,
            undefined,
        ]) expect(classifySendToContactRouteProofFailureV1(error)).toBeNull()
    })
})

describe('discoverSendToContactRouteV1', () => {
    it('selects the one provable conversation and hands on no proof, target or transport', async () => {
        const { ports: p, calls } = ports(found([['telegram', ['t1']], ['phone', ['p1']]]))
        const selection = await discoverSendToContactRouteV1(input, p)
        expect(selection).toEqual({ kind: 'selected', conversationId: 't1', channel: 'telegram' })
        expect(calls).toEqual(['read:contact-1', 'prove:t1'])
    })

    it('selects the only provable route among refused ones', async () => {
        const { ports: p } = ports(found([['max', ['m1']], ['telegram', ['t1']], ['whatsapp', ['w1']]]), {
            m1: refusedWith('CONTACT_CONVERSATION_TRANSPORT_UNBOUND'),
            w1: refusedWith('CONTACT_CONVERSATION_IDENTITY_NOT_SENDABLE:identity_conflicted'),
        })
        expect(await discoverSendToContactRouteV1(input, p)).toEqual({ kind: 'selected', conversationId: 't1', channel: 'telegram' })
    })

    it('refuses two provable routes as ambiguous and stops proving at the second', async () => {
        const { ports: p, calls } = ports(found([['whatsapp', ['w1']], ['telegram', ['t1']], ['max', ['m1']]]))
        expect(await discoverSendToContactRouteV1(input, p)).toEqual({
            kind: 'refused',
            refusal: { reason: 'route_ambiguous', retryable: false, candidateChannels: ['telegram', 'whatsapp'] },
        })
        expect(calls).toEqual(['read:contact-1', 'prove:w1', 'prove:t1'])
    })

    it('refuses two provable conversations on one channel: no transport is chosen silently', async () => {
        const { ports: p } = ports(found([['telegram', ['t1', 't2']]]))
        expect(await discoverSendToContactRouteV1(input, p)).toEqual({
            kind: 'refused',
            refusal: { reason: 'route_ambiguous', retryable: false, candidateChannels: ['telegram'] },
        })
    })

    it('lets the narrowing resolve an ambiguity', async () => {
        const entry = found([['whatsapp', ['w1']], ['telegram', ['t1']]])
        const { ports: p } = ports(entry)
        expect(await discoverSendToContactRouteV1({ ...input, allowedChannels: ['telegram'] }, p))
            .toEqual({ kind: 'selected', conversationId: 't1', channel: 'telegram' })
    })

    it('never selects one proven route while another candidate proved nothing', async () => {
        for (const order of [['t1', 'w1'], ['w1', 't1']]) {
            const channels: Array<[Channel, string[]]> = order.map(id => [id === 't1' ? 'telegram' : 'whatsapp', [id]])
            const { ports: p } = ports(found(channels), { w1: refusedWith('socket hang up') })
            expect(await discoverSendToContactRouteV1(input, p)).toEqual({
                kind: 'refused',
                refusal: { reason: 'route_evidence_incomplete', retryable: true, detail: 'route_proof_unavailable' },
            })
        }
    })

    it('still reports ambiguity when two routes are proven, whatever else is unknown', async () => {
        const { ports: p } = ports(found([['max', ['m1']], ['telegram', ['t1']], ['whatsapp', ['w1']]]), {
            m1: refusedWith('OUTBOUND_CONVERSATION_IDENTITY_CAPABILITY_NOT_REGISTERED'),
        })
        expect(await discoverSendToContactRouteV1(input, p)).toMatchObject({ refusal: { reason: 'route_ambiguous' } })
    })

    it('treats a proof of another conversation or channel as no proof', async () => {
        for (const proof of [
            { chatId: 'other', channel: 'telegram' },
            { chatId: null, channel: 'telegram' },
            { chatId: 't1', channel: 'whatsapp' },
            null,
            undefined,
        ]) {
            const { ports: p } = ports(found([['telegram', ['t1']]]), { t1: proof })
            expect(await discoverSendToContactRouteV1(input, p)).toEqual({
                kind: 'refused',
                refusal: { reason: 'route_evidence_incomplete', retryable: true, detail: 'route_proof_unavailable' },
            })
        }
    })

    it('reports the single shared refusal of every candidate', async () => {
        const { ports: p } = ports(found([['max', ['m1']], ['whatsapp', ['w1']]]), {
            m1: refusedWith('CONTACT_CONVERSATION_TRANSPORT_UNBOUND'),
            w1: refusedWith('MAX_BOT_DELIVERY_TRANSPORT_UNAVAILABLE'),
        })
        expect(await discoverSendToContactRouteV1(input, p)).toEqual({
            kind: 'refused',
            refusal: { reason: 'route_unavailable', retryable: false, detail: 'transport_unbound' },
        })
    })

    it('carries the identity status only when every candidate reports the same one', async () => {
        const same = ports(found([['telegram', ['t1', 't2']]]), {
            t1: refusedWith('CONTACT_CONVERSATION_IDENTITY_NOT_SENDABLE:identity_unreachable'),
            t2: refusedWith('CONTACT_CONVERSATION_IDENTITY_NOT_SENDABLE:identity_unreachable'),
        })
        expect(await discoverSendToContactRouteV1(input, same.ports)).toEqual({
            kind: 'refused',
            refusal: { reason: 'route_unavailable', retryable: false, detail: 'identity_not_sendable', identityStatus: 'identity_unreachable' },
        })
        const mixed = ports(found([['telegram', ['t1', 't2']]]), {
            t1: refusedWith('CONTACT_CONVERSATION_IDENTITY_NOT_SENDABLE:identity_unreachable'),
            t2: refusedWith('CONTACT_CONVERSATION_IDENTITY_NOT_SENDABLE:identity_conflicted'),
        })
        expect(await discoverSendToContactRouteV1(input, mixed.ports)).toEqual({
            kind: 'refused',
            refusal: { reason: 'route_unavailable', retryable: false, detail: 'identity_not_sendable' },
        })
    })

    it('reports no_sendable_route when candidates are refused for different reasons', async () => {
        const { ports: p } = ports(found([['telegram', ['t1']], ['max', ['m1']]]), {
            t1: refusedWith('CONTACT_CONVERSATION_NOT_PRIVATE'),
            m1: refusedWith('CONTACT_CONVERSATION_TRANSPORT_UNBOUND'),
        })
        expect(await discoverSendToContactRouteV1(input, p)).toEqual({
            kind: 'refused',
            refusal: { reason: 'route_unavailable', retryable: false, detail: 'no_sendable_route' },
        })
    })

    it('refuses without proving when there is no candidate', async () => {
        const none = ports(found([['phone', ['p1']]]))
        expect(await discoverSendToContactRouteV1(input, none.ports)).toEqual({
            kind: 'refused',
            refusal: { reason: 'route_unavailable', retryable: false, detail: 'no_conversation' },
        })
        expect(none.calls).toEqual(['read:contact-1'])
        const narrowed = ports(found([['max', ['m1']]]))
        expect(await discoverSendToContactRouteV1({ ...input, allowedChannels: ['telegram'] }, narrowed.ports)).toEqual({
            kind: 'refused',
            refusal: { reason: 'route_unavailable', retryable: false, detail: 'not_in_allowed_channels' },
        })
        expect(narrowed.calls).toEqual(['read:contact-1'])
    })

    it('fails closed on a truncated entry, even when it shows exactly one route', async () => {
        const { ports: p, calls } = ports(found([['telegram', ['t1']]], { truncated: true }))
        expect(await discoverSendToContactRouteV1(input, p)).toEqual({
            kind: 'refused',
            refusal: { reason: 'route_evidence_incomplete', retryable: true, detail: 'truncated' },
        })
        expect(calls).toEqual(['read:contact-1'])
    })

    it('calls the lineage moved when the conversations belong to another canonical Contact or none', async () => {
        const moved = { kind: 'refused', refusal: { reason: 'route_evidence_incomplete', retryable: true, detail: 'lineage_moved' } }
        expect(await discoverSendToContactRouteV1(input, ports(found([['telegram', ['t1']]], { canonicalContactId: 'canonical-2' })).ports)).toEqual(moved)
        expect(await discoverSendToContactRouteV1(input, ports({ contactId: 'contact-1', status: 'not_found' }).ports)).toEqual(moved)
    })

    it('treats an unreadable or mismatched conversations answer as unavailable', async () => {
        const unavailable = { kind: 'refused', refusal: { reason: 'route_evidence_incomplete', retryable: true, detail: 'conversations_unavailable' } }
        expect(await discoverSendToContactRouteV1(input, ports(new Error('CONTACT_CONVERSATIONS_UNAVAILABLE')).ports)).toEqual(unavailable)
        expect(await discoverSendToContactRouteV1(input, ports(found([['telegram', ['t1']]], { contactId: 'contact-2' })).ports)).toEqual(unavailable)
    })

    it('is deterministic: the same evidence gives the same answer and the same proof order', async () => {
        const entry = found([['whatsapp', ['w1', 'w2']], ['telegram', ['t1']]])
        const proofs = { w1: refusedWith('CONTACT_CONVERSATION_NOT_PRIVATE') }
        const first = ports(entry, proofs)
        const second = ports(entry, proofs)
        expect(await discoverSendToContactRouteV1(input, first.ports)).toEqual(await discoverSendToContactRouteV1(input, second.ports))
        expect(first.calls).toEqual(second.calls)
        expect(first.calls).toEqual(['read:contact-1', 'prove:w1', 'prove:w2', 'prove:t1'])
    })

    it('performs no write and no send: its only effects are the two injected reads', async () => {
        const { ports: p, calls } = ports(found([['telegram', ['t1']], ['whatsapp', ['w1']]]), {
            w1: refusedWith('CONTACT_CONVERSATION_NOT_PRIVATE'),
        })
        const allowedChannels: SendToContactChannelV1[] = ['whatsapp', 'telegram']
        await discoverSendToContactRouteV1({ ...input, allowedChannels }, p)
        expect(calls.every(call => call.startsWith('read:') || call.startsWith('prove:'))).toBe(true)
        expect(allowedChannels).toEqual(['whatsapp', 'telegram'])
        expect(Object.keys(p).sort()).toEqual(['proveRoute', 'readContactConversations'])
    })
})
