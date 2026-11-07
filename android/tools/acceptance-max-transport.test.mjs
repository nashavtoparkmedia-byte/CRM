// node --test android/tools/acceptance-max-transport.test.mjs
//
// Pins the acceptance MAX stand-in to the S2 delivery contract: it answers a
// send the way the MAX scraper answers a send MAX accepted (a correlated
// provider_ack), and its read-back check accepts exactly the state the CRM
// derives from that - status 'sent' with provider_ack evidence - and refuses a
// false 'delivered', a bare client action, a second physical send and a second
// persisted row.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
    ACCEPTANCE_PROVIDER_MESSAGE_ID,
    acceptedSendAnswer,
    serve,
    verifyPersistedSend,
} from './acceptance-max-transport.mjs'

const expected = {
    target: '000000000005',
    content: 'YOKO acceptance reply 06',
    providerAccountId: 'acceptance-max-provider-0005',
}
const clientMessageId = 'client-message-06'

function sendEntry(overrides = {}) {
    return {
        at: '2026-10-27T10:00:00.000Z',
        method: 'POST',
        path: '/send-message',
        accepted: true,
        reason: null,
        body: { chatId: expected.target, message: expected.content, providerAccountId: expected.providerAccountId, clientMessageId },
        answeredProviderMessageId: ACCEPTANCE_PROVIDER_MESSAGE_ID,
        ...overrides,
    }
}

// What the CRM persists for a send whose adapter result is provider_ack
// (MessageService: S2 evidence -> status, typedMaxDeliveryMetadata).
function providerAcceptedRow(overrides = {}) {
    return {
        id: 'msg-06',
        direction: 'outbound',
        channel: 'max',
        content: expected.content,
        clientMessageId,
        status: 'sent',
        externalId: ACCEPTANCE_PROVIDER_MESSAGE_ID,
        metadata: {
            delivery: { v: 1, evidence: 'provider_ack', evidenceAt: '2026-10-27T10:00:04.000Z', source: 'send' },
            maxDelivery: {
                operation: 'send',
                status: 'provider_accepted',
                deliveryConfirmed: false,
                maxMessageId: ACCEPTANCE_PROVIDER_MESSAGE_ID,
                externalId: ACCEPTANCE_PROVIDER_MESSAGE_ID,
            },
        },
        ...overrides,
    }
}

const inbound = { id: 'msg-in', direction: 'inbound', channel: 'max', content: 'Можно уточнить время смены?', status: 'delivered', metadata: {} }

function check(requests, history) {
    return verifyPersistedSend({ requests, history, chat: 'acc_chat_max_0005', expected })
}

test('the answer is the scraper answer for a send MAX accepted: a provider_ack naming one real-shaped id', () => {
    const answer = acceptedSendAnswer({ target: expected.target, providerAccountId: expected.providerAccountId })
    assert.match(ACCEPTANCE_PROVIDER_MESSAGE_ID, /^d301[0-9a-f]+$/i, 'the CRM MAX adapter accepts only real-shaped ids')
    assert.deepEqual(answer, {
        success: true,
        chatId: expected.target,
        providerAccountId: expected.providerAccountId,
        requestSeq: 30006,
        extraRequestFrames: 0,
        externalId: ACCEPTANCE_PROVIDER_MESSAGE_ID,
        maxMessageId: ACCEPTANCE_PROVIDER_MESSAGE_ID,
        deliveryConfirmed: true,
        deliveryStatus: 'delivered',
        source: 'op64_response',
        proofKind: 'provider_ack',
        deliveryProof: { kind: 'provider_ack', providerMessageId: ACCEPTANCE_PROVIDER_MESSAGE_ID, requestSeq: 30006 },
    })
})

test('the answer never carries a UI action as its proof', () => {
    const answer = acceptedSendAnswer({ target: expected.target, providerAccountId: expected.providerAccountId })
    assert.notEqual(answer.deliveryProof.kind, 'ui_send_action')
    assert.equal(JSON.stringify(answer).includes('ui_send_action'), false)
    assert.equal(answer.deliveryProof.providerMessageId, answer.externalId, 'the proof names the id the answer carries')
})

test('read-back passes for one send persisted as provider acceptance', () => {
    const { failures, summary } = check([sendEntry()], [inbound, providerAcceptedRow()])
    assert.deepEqual(failures, [])
    assert.equal(summary.physical_sends, 1)
    assert.equal(summary.persisted_outbound_rows, 1)
    assert.equal(summary.persisted_status, 'sent')
    assert.equal(summary.persisted_evidence, 'provider_ack')
    assert.equal(summary.persisted_max_delivery_status, 'provider_accepted')
    assert.equal(summary.persisted_client_message_id_matches, true)
    assert.equal(summary.persisted_provider_id_matches, true)
})

const refusals = [
    ['a false delivered status', providerAcceptedRow({ status: 'delivered' }), /persisted status delivered/],
    ['a false read status', providerAcceptedRow({ status: 'read' }), /persisted status read/],
    ['a bare client action as evidence', providerAcceptedRow({ metadata: { ...providerAcceptedRow().metadata, delivery: { v: 1, evidence: 'client_action', evidenceAt: 'x', source: 'send' } } }), /expected provider_ack/],
    ['no evidence record at all', providerAcceptedRow({ metadata: { maxDelivery: providerAcceptedRow().metadata.maxDelivery } }), /expected provider_ack/],
    ['MAX metadata that says send_requested', providerAcceptedRow({ metadata: { ...providerAcceptedRow().metadata, maxDelivery: { ...providerAcceptedRow().metadata.maxDelivery, status: 'send_requested' } } }), /expected provider_accepted/],
    ['MAX metadata that claims a confirmed delivery', providerAcceptedRow({ metadata: { ...providerAcceptedRow().metadata, maxDelivery: { ...providerAcceptedRow().metadata.maxDelivery, status: 'delivered', deliveryConfirmed: true } } }), /expected provider_accepted/],
    ['another provider id', providerAcceptedRow({ externalId: 'd301a0fe14acce5e07' }), /persisted provider id/],
    ['no provider id', providerAcceptedRow({ externalId: null }), /persisted provider id/],
    ['another clientMessageId', providerAcceptedRow({ clientMessageId: 'client-message-other' }), /persisted clientMessageId/],
    ['another channel', providerAcceptedRow({ channel: 'telegram' }), /persisted channel/],
]
for (const [label, row, message] of refusals) {
    test(`read-back refuses ${label}`, () => {
        const { failures } = check([sendEntry()], [inbound, row])
        assert.ok(failures.some((failure) => message.test(failure)), `expected ${message} in ${JSON.stringify(failures)}`)
    })
}

test('read-back refuses a second physical send, even when both were accepted', () => {
    const { failures, summary } = check([sendEntry(), sendEntry({ at: '2026-10-27T10:00:05.000Z' })], [inbound, providerAcceptedRow()])
    assert.equal(summary.physical_sends, 2)
    assert.ok(failures.some((failure) => /2 physical send\(s\), expected exactly 1/.test(failure)))
})

test('read-back refuses a second persisted row for the one send', () => {
    const { failures } = check([sendEntry()], [inbound, providerAcceptedRow(), providerAcceptedRow({ id: 'msg-06b' })])
    assert.ok(failures.some((failure) => /2 outbound Message row\(s\)/.test(failure)))
    assert.ok(failures.some((failure) => /2 Message row\(s\) with the sent text/.test(failure)))
})

test('read-back refuses a refused send and a request on another route', () => {
    const refused = sendEntry({ accepted: false, reason: 'unexpected content', answeredProviderMessageId: null })
    const stray = { at: 'x', method: 'GET', path: '/elsewhere', accepted: false, reason: 'unknown route' }
    const { failures } = check([refused, stray], [inbound, providerAcceptedRow()])
    assert.ok(failures.some((failure) => /request\(s\) on other routes/.test(failure)))
    assert.ok(failures.some((failure) => /refused 1 send/.test(failure)))
})

test('the served stand answers one valid send with the provider_ack and refuses anything else', async () => {
    const server = await serve({ port: 0, expected, delayMs: 0 })
    try {
        const base = `http://127.0.0.1:${server.address().port}`
        const post = (body) => fetch(`${base}/send-message`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

        const ok = await post({ chatId: expected.target, message: expected.content, providerAccountId: expected.providerAccountId, clientMessageId })
        assert.equal(ok.status, 200)
        assert.deepEqual(await ok.json(), acceptedSendAnswer({ target: expected.target, providerAccountId: expected.providerAccountId }))

        const wrong = await post({ chatId: expected.target, message: 'something else', providerAccountId: expected.providerAccountId, clientMessageId })
        assert.equal(wrong.status, 422)
        assert.equal((await wrong.json()).success, false)

        const { requests } = await (await fetch(`${base}/__acceptance/requests`)).json()
        assert.equal(requests.length, 2)
        assert.equal(requests[0].accepted, true)
        assert.equal(requests[0].answeredProviderMessageId, ACCEPTANCE_PROVIDER_MESSAGE_ID)
        assert.equal(requests[0].body.clientMessageId, clientMessageId)
        assert.equal(requests[1].accepted, false)
        assert.equal(requests[1].answeredProviderMessageId, null)
    } finally {
        await new Promise((resolve) => server.close(resolve))
    }
})
