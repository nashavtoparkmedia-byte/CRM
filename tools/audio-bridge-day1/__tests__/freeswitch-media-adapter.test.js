'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { once } = require('node:events')
const http = require('node:http')
const net = require('node:net')
const { WebSocket, WebSocketServer } = require('ws')

const {
    REQUIRED_PROBE_HEADER,
    createFreeSwitchMediaAdapter,
} = require('../scripts/freeswitch-media-aj/native-adapter')
const {
    createDevLoopbackRuntime,
} = require('../scripts/dev-loopback/server')
const {
    ADAPTER_LIMITS,
} = require('../scripts/freeswitch-media-aj/runtime')
const {
    AUDIO_CONTRACT,
    deterministicPcmFrame,
    encodeAudioFrame,
} = require('../scripts/dev-loopback/protocol')

const BRIDGE_TOKEN = 'freeswitch-adapter-test-token-'.padEnd(64, '0')

function createInbox(ws) {
    const backlog = []
    const waiters = new Set()
    let closed = null

    const deliver = item => {
        for (const waiter of waiters) {
            if (!waiter.predicate(item)) continue
            waiters.delete(waiter)
            clearTimeout(waiter.timeout)
            waiter.resolve(item)
            return
        }
        backlog.push(item)
    }

    ws.on('message', (data, isBinary) => {
        deliver({
            data: Buffer.from(data),
            isBinary,
        })
    })
    ws.on('close', (code, reason) => {
        closed = { code, reason: String(reason) }
        for (const waiter of waiters) {
            waiters.delete(waiter)
            clearTimeout(waiter.timeout)
            waiter.reject(new Error(
                `websocket_closed:${code}:${String(reason)}`,
            ))
        }
    })
    ws.on('error', () => {
        // Rejections and lifecycle assertions use close/unexpected-response.
    })

    return {
        wait(predicate, timeoutMs = 2000) {
            const index = backlog.findIndex(predicate)
            if (index >= 0) {
                return Promise.resolve(backlog.splice(index, 1)[0])
            }
            if (closed) {
                return Promise.reject(new Error(
                    `websocket_already_closed:${closed.code}:${closed.reason}`,
                ))
            }
            return new Promise((resolve, reject) => {
                const waiter = {
                    predicate,
                    resolve,
                    reject,
                    timeout: null,
                }
                waiter.timeout = setTimeout(() => {
                    waiters.delete(waiter)
                    reject(new Error('websocket_message_timeout'))
                }, timeoutMs)
                waiters.add(waiter)
            })
        },
    }
}

function waitForOpen(ws, timeoutMs = 2000) {
    if (ws.readyState === WebSocket.OPEN) return Promise.resolve()
    return Promise.race([
        once(ws, 'open').then(() => undefined),
        new Promise((_, reject) => {
            setTimeout(
                () => reject(new Error('websocket_open_timeout')),
                timeoutMs,
            )
        }),
    ])
}

async function waitForCompleted(adapter, channelUuid, timeoutMs = 2000) {
    const startedAt = Date.now()
    while (Date.now() - startedAt < timeoutMs) {
        const completed = adapter.snapshot().completed.find(
            session => session.channel_uuid === channelUuid,
        )
        if (completed) return completed
        await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error(`session_completion_timeout:${channelUuid}`)
}

async function waitForBridgeReady(adapter, channelUuid, timeoutMs = 2000) {
    const startedAt = Date.now()
    while (Date.now() - startedAt < timeoutMs) {
        const active = adapter.snapshot().active.find(
            session => session.channel_uuid === channelUuid,
        )
        if (active?.bridge_ready) return active
        await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error(`bridge_ready_timeout:${channelUuid}`)
}

async function waitForWrappedFrames(
    adapter,
    channelUuid,
    minimumFrames,
    timeoutMs = 2000,
) {
    const startedAt = Date.now()
    while (Date.now() - startedAt < timeoutMs) {
        const active = adapter.snapshot().active.find(
            session => session.channel_uuid === channelUuid,
        )
        if (
            active?.adapter_wrapped_internal_frames >= minimumFrames
        ) {
            return active
        }
        await new Promise(resolve => setTimeout(resolve, 5))
    }
    throw new Error(`wrapped_frames_timeout:${channelUuid}`)
}

async function createStack(t, {
    transformOutboundPayload,
    adapterToken = BRIDGE_TOKEN,
    onSessionAssigned,
    adapterLimits,
} = {}) {
    const bridge = createDevLoopbackRuntime({
        token: BRIDGE_TOKEN,
        limits: {
            idleTimeoutMs: 1500,
            maxSessionRuntimeMs: 3000,
            maxQueueFrames: 8,
        },
        transformOutboundPayload,
    })
    await bridge.listen()
    const bridgeAddress = bridge.httpServer.address()
    const adapter = createFreeSwitchMediaAdapter({
        nativeHost: '127.0.0.1',
        nativePort: 0,
        bridgeUrl:
            `ws://127.0.0.1:${bridgeAddress.port}/dev-audio`,
        bridgeToken: adapterToken,
        limits: {
            bridgeHandshakeTimeoutMs: 1000,
            maxSessionRuntimeMs: 3000,
            ...adapterLimits,
        },
        onSessionAssigned,
    })
    const address = await adapter.listen()
    t.after(async () => {
        await adapter.stop()
        await bridge.stop()
    })
    return { adapter, address, bridge }
}

async function createUnsolicitedBridge(t) {
    const server = http.createServer((_req, res) => {
        res.statusCode = 404
        res.end('not found')
    })
    const wss = new WebSocketServer({
        server,
        path: '/dev-audio',
        perMessageDeflate: false,
    })
    wss.on('connection', (ws, req) => {
        const url = new URL(req.url, 'http://127.0.0.1')
        const sessionId = url.searchParams.get('sessionId')
        ws.send(JSON.stringify({
            type: 'hello',
            sessionId,
            audio: AUDIO_CONTRACT,
        }))
        ws.on('message', (data, isBinary) => {
            if (isBinary) return
            let message
            try {
                message = JSON.parse(String(data))
            } catch {
                return
            }
            if (message.type !== 'metadata') return
            ws.send(JSON.stringify({
                type: 'ready',
                sessionId,
                expectedSequence: 0,
            }))
            ws.send(encodeAudioFrame({
                sequence: 0,
                payload: deterministicPcmFrame(0, 91),
            }), { binary: true })
        })
    })
    await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', () => {
            server.off('error', reject)
            resolve()
        })
    })
    t.after(async () => {
        for (const client of wss.clients) {
            try { client.terminate() } catch {}
        }
        await new Promise(resolve => wss.close(() => resolve()))
        if (server.listening) {
            await new Promise(resolve => server.close(() => resolve()))
        }
    })
    return server.address()
}

function connectNative(address, channelUuid, {
    probeHeader = REQUIRED_PROBE_HEADER,
} = {}) {
    const headers = {}
    if (probeHeader != null) {
        headers['X-Yoko-Dev-Probe'] = probeHeader
    }
    const ws = new WebSocket(
        `ws://${address.host}:${address.port}/${channelUuid}`,
        { headers },
    )
    return { ws, inbox: createInbox(ws) }
}

function waitForRejectedUpgrade(address, channelUuid, probeHeader) {
    return new Promise((resolve, reject) => {
        const headers = {}
        if (probeHeader != null) {
            headers['X-Yoko-Dev-Probe'] = probeHeader
        }
        const ws = new WebSocket(
            `ws://${address.host}:${address.port}/${channelUuid}`,
            { headers },
        )
        const timeout = setTimeout(() => {
            ws.terminate()
            reject(new Error('upgrade_rejection_timeout'))
        }, 2000)
        ws.on('unexpected-response', (_request, response) => {
            clearTimeout(timeout)
            response.resume()
            resolve(response.statusCode)
        })
        ws.on('error', () => {
            // Expected after an HTTP upgrade rejection.
        })
        ws.on('open', () => {
            clearTimeout(timeout)
            ws.terminate()
            reject(new Error('upgrade_unexpectedly_accepted'))
        })
    })
}

function sendMalformedUpgrade(address, channelUuid) {
    return new Promise((resolve, reject) => {
        const socket = net.createConnection({
            host: address.host,
            port: address.port,
        })
        const chunks = []
        const timeout = setTimeout(() => {
            socket.destroy()
            reject(new Error('malformed_upgrade_timeout'))
        }, 2000)
        socket.on('connect', () => {
            socket.write(
                `GET /${channelUuid} HTTP/1.1\r\n`
                + `Host: ${address.host}:${address.port}\r\n`
                + 'Connection: Upgrade\r\n'
                + 'Upgrade: websocket\r\n'
                + `X-Yoko-Dev-Probe: ${REQUIRED_PROBE_HEADER}\r\n`
                + '\r\n',
            )
        })
        socket.on('data', chunk => chunks.push(Buffer.from(chunk)))
        socket.on('close', () => {
            clearTimeout(timeout)
            resolve(Buffer.concat(chunks).toString('ascii'))
        })
        socket.on('error', error => {
            clearTimeout(timeout)
            reject(error)
        })
    })
}

async function waitForRawAudio(inbox) {
    const item = await inbox.wait(message => {
        if (message.isBinary) return false
        try {
            return JSON.parse(String(message.data)).type === 'rawAudio'
        } catch {
            return false
        }
    })
    return JSON.parse(String(item.data))
}

test('factory rejects public listeners, public bridge targets, and unsafe limits', () => {
    const base = {
        nativeHost: '127.0.0.1',
        bridgeUrl: 'ws://127.0.0.1:3030/dev-audio',
        bridgeToken: BRIDGE_TOKEN,
    }
    assert.throws(
        () => createFreeSwitchMediaAdapter({
            ...base,
            nativeHost: '0.0.0.0',
        }),
        /native_adapter_bind_must_be_loopback_or_rfc1918/,
    )
    assert.throws(
        () => createFreeSwitchMediaAdapter({
            ...base,
            nativeHost: '8.8.8.8',
        }),
        /native_adapter_bind_must_be_loopback_or_rfc1918/,
    )
    assert.throws(
        () => createFreeSwitchMediaAdapter({
            ...base,
            bridgeUrl: 'ws://8.8.8.8/dev-audio',
        }),
        /native_adapter_bridge_must_be_loopback_or_rfc1918/,
    )
    assert.throws(
        () => createFreeSwitchMediaAdapter({
            ...base,
            bridgeToken: 'short',
        }),
        /native_adapter_bridge_token_required/,
    )
    assert.throws(
        () => createFreeSwitchMediaAdapter({
            ...base,
            bridgeToken: `${'a'.repeat(32)}\n`,
        }),
        /native_adapter_bridge_token_required/,
    )
    assert.throws(
        () => createFreeSwitchMediaAdapter({
            ...base,
            limits: { maxSessions: 3 },
        }),
        /native_adapter_max_sessions_invalid/,
    )
    assert.throws(
        () => createFreeSwitchMediaAdapter({
            ...base,
            limits: { maxCarryBytes: 640 },
        }),
        /native_adapter_limit_unknown:maxCarryBytes/,
    )
    const recognized = createFreeSwitchMediaAdapter({
        ...base,
        limits: ADAPTER_LIMITS,
    })
    assert.equal(recognized.effectiveLimits.idleTimeoutMs, 1750)
    assert.equal(recognized.snapshot().limits.maxNativeMessageBytes, 2560)
    assert.deepEqual(recognized.snapshot().limits, ADAPTER_LIMITS)
    assert.deepEqual(
        Object.keys(recognized.snapshot().limits).sort(),
        [
            'bridgeHandshakeTimeoutMs',
            'idleTimeoutMs',
            'maxArmedSlots',
            'maxBridgeBufferedBytes',
            'maxFramesPerSession',
            'maxNativeBufferedBytes',
            'maxNativeMessageBytes',
            'maxQueueFrames',
            'maxSessionRuntimeMs',
            'maxSessions',
        ].sort(),
    )
    assert.doesNotThrow(
        () => createFreeSwitchMediaAdapter({
            ...base,
            nativeHost: '172.20.0.1',
        }),
    )
})

test('one armed native session normalizes arbitrary chunks across two real WebSocket hops', async t => {
    const assigned = []
    const stack = await createStack(t, {
        transformOutboundPayload: payload => Buffer.from(payload),
        onSessionAssigned(assignment) {
            assigned.push(assignment)
        },
    })
    const channelUuid = '61a4335f-1679-4f29-9687-452ddf13da9b'
    const armed = stack.adapter.arm({
        id: 'chunk-normalization',
        sourceHz: 440,
        returnHz: 440,
        maxQueueFrames: 4,
    })
    assert.equal(armed.channel_uuid, null)
    assert.equal(armed.queue_position, 1)
    assert.equal(stack.adapter.snapshot().pendingSlots, 1)

    const native = connectNative(stack.address, channelUuid)
    await waitForOpen(native.ws)
    const rawAudio = await waitForRawAudio(native.inbox)
    assert.deepEqual(rawAudio, {
        type: 'rawAudio',
        data: { sampleRate: 8000 },
    })

    const first = deterministicPcmFrame(0, 11)
    const second = deterministicPcmFrame(1, 11)
    const combined = Buffer.concat([first, second])
    native.ws.send(combined.subarray(0, 73), { binary: true })
    native.ws.send(combined.subarray(73, 521), { binary: true })
    native.ws.send(combined.subarray(521), { binary: true })

    const returnedFirst = await native.inbox.wait(item => item.isBinary)
    const returnedSecond = await native.inbox.wait(item => item.isBinary)
    assert.deepEqual(returnedFirst.data, first)
    assert.deepEqual(returnedSecond.data, second)
    assert.equal(assigned.length, 1)
    assert.equal(assigned[0].session.channel_uuid, channelUuid)
    assert.equal(assigned[0].profile.return_hz, 440)
    assert.equal(assigned[0].profile.returnHz, 440)

    const closePromise = once(native.ws, 'close')
    native.ws.close(1000, 'test_complete')
    await closePromise
    const completed = await waitForCompleted(stack.adapter, channelUuid)
    assert.equal(completed.state, 'ended')
    assert.equal(completed.reason, 'native_disconnect')
    assert.equal(completed.adapter_accepted_native_frames, 2)
    assert.equal(completed.adapter_wrapped_internal_frames, 2)
    assert.equal(completed.adapter_accepted_return_frames, 2)
    assert.equal(completed.adapter_emitted_native_frames, 2)
    assert.equal(completed.native_bytes_received, 640)
    assert.equal(completed.internal_bytes_sent, 696)
    assert.equal(completed.internal_bytes_received, 696)
    assert.equal(completed.native_bytes_sent, 640)
    assert.equal(completed.carry_bytes, 0)
    assert.equal(completed.cleanup_result, 'released')
    assert.ok(completed.latency.max_ms >= 0)
    assert.equal(completed.source_tone_amplitudes.samples, 320)
    assert.equal(completed.return_tone_amplitudes.samples, 320)
    assert.equal(stack.adapter.snapshot().pendingSlots, 0)
})

test('fixed probe header and FIFO one-time slot reject unauthorized and duplicate upgrades', async t => {
    const stack = await createStack(t)
    const channelUuid = '8022db74-f075-4d52-a572-ce22c42f68d0'
    stack.adapter.arm({
        id: 'one-shot-slot',
    })

    assert.match(
        await sendMalformedUpgrade(stack.address, channelUuid),
        /^HTTP\/1\.1 400 /,
    )
    assert.equal(stack.adapter.snapshot().pendingSlots, 1)
    assert.equal(
        await waitForRejectedUpgrade(
            stack.address,
            channelUuid,
            'wrong-capability',
        ),
        403,
    )
    assert.equal(stack.adapter.snapshot().pendingSlots, 1)

    const native = connectNative(stack.address, channelUuid)
    await waitForOpen(native.ws)
    await waitForRawAudio(native.inbox)
    assert.equal(stack.adapter.snapshot().pendingSlots, 0)
    assert.equal(
        await waitForRejectedUpgrade(
            stack.address,
            channelUuid,
            REQUIRED_PROBE_HEADER,
        ),
        409,
    )
    stack.adapter.arm({ id: 'next-fifo-slot' })
    assert.equal(stack.adapter.snapshot().pendingSlots, 1)
    assert.equal(
        await waitForRejectedUpgrade(
            stack.address,
            channelUuid,
            REQUIRED_PROBE_HEADER,
        ),
        409,
    )
    assert.equal(stack.adapter.snapshot().pendingSlots, 1)

    const closePromise = once(native.ws, 'close')
    native.ws.close(1000, 'test_complete')
    await closePromise
    const runtime = stack.adapter.snapshot().runtime
    assert.equal(runtime.authFailures, 1)
    assert.equal(runtime.duplicateConnections, 2)
})

test('malformed native controls and unsupported sample formats fail closed', async t => {
    const stack = await createStack(t)
    const malformedUuid = '28e99017-87b4-4587-a03f-c8cc56325b95'
    const formatUuid = 'fffe4b43-f06d-4bf6-a561-06394ba51f1d'

    stack.adapter.arm({
        id: 'malformed-control',
    })
    const malformed = connectNative(stack.address, malformedUuid)
    await waitForOpen(malformed.ws)
    await waitForRawAudio(malformed.inbox)
    malformed.ws.send('{not-json')
    const malformedResult = await waitForCompleted(
        stack.adapter,
        malformedUuid,
    )
    assert.equal(malformedResult.state, 'failed')
    assert.equal(malformedResult.reason, 'malformed_native_control')
    assert.equal(malformedResult.malformed_native_controls, 1)

    stack.adapter.arm({
        id: 'unsupported-format',
    })
    const unsupported = connectNative(stack.address, formatUuid)
    await waitForOpen(unsupported.ws)
    await waitForRawAudio(unsupported.inbox)
    unsupported.ws.send(JSON.stringify({
        type: 'rawAudio',
        data: {
            sampleRate: 16000,
            channels: 1,
            codec: 'pcm_s16le',
        },
    }))
    const formatResult = await waitForCompleted(stack.adapter, formatUuid)
    assert.equal(formatResult.state, 'failed')
    assert.equal(formatResult.reason, 'unsupported_sample_format')
    assert.equal(formatResult.unsupported_sample_formats, 1)
})

test('oversized native WebSocket message is a protocol failure, not a clean hangup', async t => {
    const stack = await createStack(t)
    const channelUuid = 'b50d698f-b188-42cc-8d5e-70fc295e6ec0'
    stack.adapter.arm({ id: 'oversized-native-message' })
    const native = connectNative(stack.address, channelUuid)
    await waitForOpen(native.ws)
    await waitForRawAudio(native.inbox)

    native.ws.send(
        Buffer.alloc(
            stack.adapter.effectiveLimits.maxNativeMessageBytes + 1,
        ),
        { binary: true },
    )
    const completed = await waitForCompleted(stack.adapter, channelUuid)
    assert.equal(completed.state, 'failed')
    assert.equal(completed.reason, 'native_protocol_error')
    assert.ok(completed.rejected_frames >= 1)
    assert.equal(completed.adapter_accepted_native_frames, 0)
    assert.equal(completed.cleanup_result, 'released')
})

test('CRC-valid unsolicited Bridge return fails closed before native emission', async t => {
    const bridgeAddress = await createUnsolicitedBridge(t)
    const adapter = createFreeSwitchMediaAdapter({
        nativeHost: '127.0.0.1',
        nativePort: 0,
        bridgeUrl:
            `ws://127.0.0.1:${bridgeAddress.port}/dev-audio`,
        bridgeToken: BRIDGE_TOKEN,
        limits: {
            bridgeHandshakeTimeoutMs: 1000,
            idleTimeoutMs: 1000,
            maxSessionRuntimeMs: 3000,
        },
    })
    const address = await adapter.listen()
    t.after(() => adapter.stop())
    const channelUuid = '7abc5d1c-e1d8-4f75-a55f-a21a2f63bb32'
    adapter.arm({ id: 'unsolicited-return' })
    const native = connectNative(address, channelUuid)
    await waitForOpen(native.ws)
    await waitForRawAudio(native.inbox)

    const completed = await waitForCompleted(adapter, channelUuid)
    assert.equal(completed.state, 'failed')
    assert.equal(completed.reason, 'bridge_return_unsolicited')
    assert.equal(completed.rejected_frames, 1)
    assert.equal(completed.adapter_accepted_return_frames, 0)
    assert.equal(completed.adapter_emitted_native_frames, 0)
    assert.equal(completed.internal_bytes_received, 348)
    assert.equal(completed.cleanup_result, 'released')
})

test('bridge auth failure is contained and does not expose the process-local token', async t => {
    const stack = await createStack(t, {
        adapterToken: 'wrong-adapter-bridge-token-'.padEnd(64, 'x'),
    })
    const channelUuid = '34805e56-4a52-47a2-ac67-c9e8fdc82857'
    stack.adapter.arm({
        id: 'auth-failure',
    })
    const native = connectNative(stack.address, channelUuid)
    await waitForOpen(native.ws)
    await waitForRawAudio(native.inbox)

    const completed = await waitForCompleted(stack.adapter, channelUuid)
    assert.equal(completed.state, 'failed')
    assert.equal(completed.reason, 'bridge_auth_failure')
    assert.equal(completed.bridge_auth_failures, 1)
    const serialized = JSON.stringify(stack.adapter.snapshot())
    assert.equal(serialized.includes(BRIDGE_TOKEN), false)
    assert.equal(serialized.includes('wrong-adapter-bridge-token'), false)
})

test('bounded media idle timeout releases a silent active session', async t => {
    const stack = await createStack(t, {
        adapterLimits: { idleTimeoutMs: 100 },
    })
    const channelUuid = 'd87ba265-eef7-4bf0-93f4-d12ab0856e10'
    stack.adapter.arm({ id: 'media-idle-timeout' })
    const native = connectNative(stack.address, channelUuid)
    await waitForOpen(native.ws)
    await waitForRawAudio(native.inbox)
    await waitForBridgeReady(stack.adapter, channelUuid)

    const completed = await waitForCompleted(stack.adapter, channelUuid)
    assert.equal(completed.state, 'failed')
    assert.equal(completed.reason, 'media_idle_timeout')
    assert.equal(completed.idle_timeouts, 1)
    assert.equal(completed.cleanup_result, 'released')
    assert.equal(stack.adapter.effectiveLimits.idleTimeoutMs, 100)
    assert.equal(stack.adapter.snapshot().limits.idleTimeoutMs, 100)
})

test('upstream queue backpressure is explicit, bounded, and released', async t => {
    const stack = await createStack(t)
    const channelUuid = 'a35724f6-9d5b-42d3-b1c4-d9f839697290'
    stack.adapter.arm({
        id: 'bridge-backpressure',
        processingDelayMs: 50,
        maxQueueFrames: 1,
        suppressNativeReturn: true,
    })
    const native = connectNative(stack.address, channelUuid)
    await waitForOpen(native.ws)
    await waitForRawAudio(native.inbox)
    await waitForBridgeReady(stack.adapter, channelUuid)

    native.ws.send(Buffer.concat([
        deterministicPcmFrame(0, 51),
        deterministicPcmFrame(1, 51),
    ]), { binary: true })

    const completed = await waitForCompleted(stack.adapter, channelUuid)
    assert.equal(completed.state, 'failed')
    assert.equal(completed.reason, 'bridge_queue_backpressure')
    assert.equal(completed.bridge_close_code, 4413)
    assert.equal(completed.backpressure_failures, 1)
    assert.equal(completed.adapter_wrapped_internal_frames, 2)
    assert.equal(completed.in_flight_return_frames_at_cleanup, 2)
    assert.equal(completed.unresolved_missing_frames, 2)
    assert.ok(completed.rejected_frames >= 1)
    assert.ok(completed.cleanup_dropped_frames >= 2)
    assert.equal(completed.cleanup_result, 'released')
    assert.equal(stack.adapter.snapshot().active.length, 0)
})

test('return arriving while native socket is CLOSING is a cleanup drop, not backpressure', async t => {
    const stack = await createStack(t)
    const channelUuid = '97092a63-c9b4-4874-89a1-8d3ac32d2297'
    stack.adapter.arm({
        id: 'native-closing-return',
        processingDelayMs: 50,
        maxQueueFrames: 4,
    })
    const native = connectNative(stack.address, channelUuid)
    await waitForOpen(native.ws)
    await waitForRawAudio(native.inbox)
    await waitForBridgeReady(stack.adapter, channelUuid)

    native.ws._socket.pause()
    native.ws.send(deterministicPcmFrame(0, 63), { binary: true })
    await waitForWrappedFrames(stack.adapter, channelUuid, 1)
    const internal = stack.adapter.activeSessions.get(channelUuid)
    internal.nativeWs.close(1000, 'simulated_freeswitch_teardown')
    assert.equal(internal.nativeWs.readyState, WebSocket.CLOSING)

    const completed = await waitForCompleted(stack.adapter, channelUuid)
    native.ws._socket.resume()
    native.ws.terminate()
    assert.equal(completed.state, 'ended')
    assert.equal(completed.reason, 'native_disconnect')
    assert.equal(completed.adapter_accepted_return_frames, 1)
    assert.equal(completed.adapter_emitted_native_frames, 0)
    assert.equal(completed.rejected_frames, 0)
    assert.equal(completed.backpressure_failures, 0)
    assert.ok(completed.cleanup_dropped_frames >= 1)
    assert.equal(completed.cleanup_result, 'released')
})

test('emergencyStop and disconnectBridge target exactly one of two active sessions', async t => {
    const stack = await createStack(t, {
        transformOutboundPayload: payload => Buffer.from(payload),
        adapterLimits: { maxSessions: 2, maxArmedSlots: 2 },
    })
    const firstUuid = '55b30ce2-03a2-4806-b7c8-c872d11397bc'
    const secondUuid = '5d8f6e92-602c-4db8-ad83-e1af339538db'
    stack.adapter.arm({
        id: 'isolation-first',
    })
    stack.adapter.arm({
        id: 'isolation-second',
    })

    const first = connectNative(stack.address, firstUuid)
    await waitForOpen(first.ws)
    await waitForRawAudio(first.inbox)
    const second = connectNative(stack.address, secondUuid)
    await waitForOpen(second.ws)
    await waitForRawAudio(second.inbox)
    const assigned = stack.adapter.snapshot().active
    assert.equal(
        assigned.find(
            session => session.channel_uuid === firstUuid,
        ).profile_id,
        'isolation-first',
    )
    assert.equal(
        assigned.find(
            session => session.channel_uuid === secondUuid,
        ).profile_id,
        'isolation-second',
    )

    const firstFrame = deterministicPcmFrame(0, 31)
    const secondFrame = deterministicPcmFrame(0, 47)
    first.ws.send(firstFrame, { binary: true })
    second.ws.send(secondFrame, { binary: true })
    assert.deepEqual(
        (await first.inbox.wait(item => item.isBinary)).data,
        firstFrame,
    )
    assert.deepEqual(
        (await second.inbox.wait(item => item.isBinary)).data,
        secondFrame,
    )

    assert.equal(stack.adapter.emergencyStop(firstUuid), true)
    const firstResult = await waitForCompleted(stack.adapter, firstUuid)
    assert.equal(firstResult.reason, 'emergency_stop')
    assert.equal(
        stack.adapter.snapshot().active.some(
            session => session.channel_uuid === secondUuid,
        ),
        true,
    )

    const peerFollowup = deterministicPcmFrame(1, 47)
    second.ws.send(peerFollowup, { binary: true })
    assert.deepEqual(
        (await second.inbox.wait(item => item.isBinary)).data,
        peerFollowup,
    )
    assert.equal(stack.adapter.disconnectBridge(secondUuid), true)
    const secondResult = await waitForCompleted(stack.adapter, secondUuid)
    assert.equal(secondResult.reason, 'bridge_disconnect_requested')
    assert.equal(secondResult.adapter_emitted_native_frames, 2)
    assert.equal(stack.adapter.snapshot().active.length, 0)
})

test('adapter and Bridge stop calls return and await one cached promise', async t => {
    const stack = await createStack(t)
    const adapterFirst = stack.adapter.stop()
    const adapterSecond = stack.adapter.stop()
    assert.strictEqual(adapterSecond, adapterFirst)
    await Promise.all([adapterFirst, adapterSecond])

    const bridgeFirst = stack.bridge.stop()
    const bridgeSecond = stack.bridge.stop()
    assert.strictEqual(bridgeSecond, bridgeFirst)
    await Promise.all([bridgeFirst, bridgeSecond])
})
