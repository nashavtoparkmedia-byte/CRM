'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { once } = require('node:events')
const { WebSocket } = require('ws')

const {
    createDevLoopbackRuntime,
} = require('../scripts/dev-loopback/server')
const {
    AUDIO_CONTRACT,
    decodeAudioFrame,
    deterministicPcmFrame,
    encodeAudioFrame,
} = require('../scripts/dev-loopback/protocol')

const TOKEN = 'transform-test-token-'.padEnd(64, '0')

function waitForMessage(ws, predicate, timeoutMs = 2000) {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            cleanup()
            reject(new Error('timed_out_waiting_for_websocket_message'))
        }, timeoutMs)

        const onMessage = (data, isBinary) => {
            let value = data
            if (!isBinary) {
                try {
                    value = JSON.parse(String(data))
                } catch {
                    return
                }
            }
            if (!predicate(value, isBinary)) return
            cleanup()
            resolve(value)
        }
        const onError = error => {
            cleanup()
            reject(error)
        }
        const onClose = (code, reason) => {
            cleanup()
            reject(new Error(
                `websocket_closed_before_message:${code}:${String(reason)}`,
            ))
        }
        const cleanup = () => {
            clearTimeout(timeout)
            ws.off('message', onMessage)
            ws.off('error', onError)
            ws.off('close', onClose)
        }

        ws.on('message', onMessage)
        ws.once('error', onError)
        ws.once('close', onClose)
    })
}

async function connectSession(runtime, sessionId) {
    const address = runtime.httpServer.address()
    const ws = new WebSocket(
        `ws://127.0.0.1:${address.port}/dev-audio?sessionId=${sessionId}`,
        { headers: { authorization: `Bearer ${TOKEN}` } },
    )

    const hello = await waitForMessage(
        ws,
        (message, isBinary) => !isBinary && message.type === 'hello',
    )
    assert.equal(hello.sessionId, sessionId)

    const readyPromise = waitForMessage(
        ws,
        (message, isBinary) => !isBinary && message.type === 'ready',
    )
    ws.send(JSON.stringify({
        type: 'metadata',
        sessionId,
        audio: AUDIO_CONTRACT,
    }))
    await readyPromise
    return ws
}

async function closeClient(ws) {
    if (ws.readyState === WebSocket.CLOSED) return
    const closePromise = once(ws, 'close')
    ws.close(1000, 'test_complete')
    await closePromise
}

test('default outbound transform preserves the existing identity loopback', async t => {
    const runtime = createDevLoopbackRuntime({ token: TOKEN })
    t.after(() => runtime.stop())
    await runtime.listen()

    const ws = await connectSession(runtime, 'identity-default')
    const payload = deterministicPcmFrame(0, 17)
    const sentAtMs = Date.now()
    const outboundPromise = waitForMessage(ws, (_message, isBinary) => isBinary)

    ws.send(encodeAudioFrame({
        sequence: 0,
        payload,
        sentAtMs,
        flags: 9,
    }))

    const outbound = decodeAudioFrame(await outboundPromise)
    assert.equal(outbound.sequence, 0)
    assert.equal(outbound.sentAtMs, sentAtMs)
    assert.equal(outbound.flags, 9)
    assert.deepEqual(outbound.payload, payload)
    await closeClient(ws)
})

test('custom outbound transform receives immutable routing context and replaces only PCM payload', async t => {
    const calls = []
    const replacement = deterministicPcmFrame(0, 29)
    const runtime = createDevLoopbackRuntime({
        token: TOKEN,
        transformOutboundPayload(payload, context) {
            calls.push({
                context,
                input: Buffer.from(payload),
                contextFrozen: Object.isFrozen(context),
            })
            payload.fill(0)
            return Buffer.from(replacement)
        },
    })
    t.after(() => runtime.stop())
    await runtime.listen()

    const ws = await connectSession(runtime, 'deterministic-return')
    const input = deterministicPcmFrame(0, 41)
    const originalInput = Buffer.from(input)
    const sentAtMs = Date.now()
    const outboundPromise = waitForMessage(ws, (_message, isBinary) => isBinary)

    ws.send(encodeAudioFrame({
        sequence: 0,
        payload: input,
        sentAtMs,
        flags: 13,
    }))

    const outbound = decodeAudioFrame(await outboundPromise)
    assert.deepEqual(outbound.payload, replacement)
    assert.equal(outbound.sequence, 0)
    assert.equal(outbound.sentAtMs, sentAtMs)
    assert.equal(outbound.flags, 13)
    assert.deepEqual(input, originalInput)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].contextFrozen, true)
    assert.deepEqual(calls[0].context, {
        sessionId: 'deterministic-return',
        sequence: 0,
        sentAtMs,
        flags: 13,
    })
    assert.deepEqual(calls[0].input, originalInput)
    await closeClient(ws)
})

test('invalid or throwing outbound transforms fail the session without escaping drainQueue', async t => {
    const cases = [
        {
            sessionId: 'transform-throws',
            expectedReason: 'outbound_transform_failed',
            transformOutboundPayload() {
                throw new Error('sensitive-internal-detail')
            },
        },
        {
            sessionId: 'transform-invalid',
            expectedReason: 'outbound_transform_invalid',
            transformOutboundPayload() {
                return Buffer.alloc(AUDIO_CONTRACT.bytesPerFrame - 1)
            },
        },
    ]

    for (const item of cases) {
        const runtime = createDevLoopbackRuntime({
            token: TOKEN,
            transformOutboundPayload: item.transformOutboundPayload,
        })
        t.after(() => runtime.stop())
        await runtime.listen()

        const ws = await connectSession(runtime, item.sessionId)
        const closePromise = once(ws, 'close')
        ws.send(encodeAudioFrame({
            sequence: 0,
            payload: deterministicPcmFrame(0, 7),
        }))
        await closePromise

        const session = runtime.completedSessions.get(item.sessionId)
        assert.ok(session)
        assert.equal(session.state, 'failed')
        assert.equal(session.reason, item.expectedReason)
        assert.equal(session.metrics.framesReceived, 1)
        assert.equal(session.metrics.framesSent, 0)
        assert.equal(session.metrics.rejectedFrames, 1)
        assert.equal(session.cleanupResult, 'released')
    }
})

test('non-function outbound transform is rejected before binding a listener', () => {
    assert.throws(
        () => createDevLoopbackRuntime({
            token: TOKEN,
            transformOutboundPayload: 'not-a-function',
        }),
        /dev_loopback_transform_must_be_function/,
    )
})
