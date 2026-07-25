'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const http = require('node:http')
const net = require('node:net')
const path = require('node:path')
const { fork } = require('node:child_process')
const { EventEmitter } = require('node:events')
const { WebSocket } = require('ws')

const {
    AUDIO_CONTRACT,
    HEADER_BYTES,
    decodeAudioFrame,
    deterministicPcmFrame,
    encodeAudioFrame,
} = require('./protocol')

const SERVER_PATH = path.join(__dirname, 'server.js')
const TEMP_ROOT = '/var/tmp/yoko-ai-calls-audio-loopback'
const CHILD_MAX_OLD_SPACE_MIB = 64

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
}

async function waitFor(predicate, {
    timeoutMs = 3000,
    intervalMs = 5,
    label = 'condition',
} = {}) {
    const started = Date.now()
    for (;;) {
        const value = await predicate()
        if (value) return value
        if (Date.now() - started >= timeoutMs) {
            throw new Error(`timeout_waiting_for_${label}`)
        }
        await delay(intervalMs)
    }
}

function onceChildMessage(child, predicate, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            cleanup()
            reject(new Error('child_message_timeout'))
        }, timeoutMs)
        const onMessage = message => {
            if (!predicate(message)) return
            cleanup()
            resolve(message)
        }
        const onExit = (code, signal) => {
            cleanup()
            reject(new Error(`child_exited_before_message_${code ?? signal}`))
        }
        const cleanup = () => {
            clearTimeout(timer)
            child.off('message', onMessage)
            child.off('exit', onExit)
        }
        child.on('message', onMessage)
        child.on('exit', onExit)
    })
}

function onceChildExit(child, timeoutMs = 3000) {
    return new Promise((resolve, reject) => {
        if (child.exitCode != null || child.signalCode != null) {
            resolve({ code: child.exitCode, signal: child.signalCode })
            return
        }
        const timer = setTimeout(() => {
            cleanup()
            reject(new Error('child_exit_timeout'))
        }, timeoutMs)
        const onExit = (code, signal) => {
            cleanup()
            resolve({ code, signal })
        }
        const cleanup = () => {
            clearTimeout(timer)
            child.off('exit', onExit)
        }
        child.on('exit', onExit)
    })
}

class LoopbackClient extends EventEmitter {
    constructor(ws, sessionId) {
        super()
        this.ws = ws
        this.sessionId = sessionId
        this.controls = []
        this.frames = []
        this.closeInfo = null
        this.error = null
        this.resumeKey = null
        this.sentPayloads = new Map()

        ws.on('message', (data, isBinary) => {
            try {
                if (isBinary) {
                    const frame = decodeAudioFrame(data)
                    frame.clientReceivedAtMs = Date.now()
                    this.frames.push(frame)
                    this.emit('update')
                    return
                }
                const control = JSON.parse(String(data))
                this.controls.push(control)
                if (control.type === 'ready' && control.resumeKey) {
                    this.resumeKey = control.resumeKey
                }
                this.emit('update')
            } catch (error) {
                this.error = error
                this.emit('update')
            }
        })
        ws.on('close', (code, reason) => {
            this.closeInfo = { code, reason: String(reason) }
            this.emit('update')
        })
        ws.on('error', error => {
            this.error = error
            this.emit('update')
        })
    }

    sendControl(payload) {
        this.ws.send(JSON.stringify(payload))
    }

    sendFrame(sequence, seed, { sentAtMs = Date.now() } = {}) {
        const payload = deterministicPcmFrame(sequence, seed)
        this.sentPayloads.set(sequence, payload)
        this.ws.send(encodeAudioFrame({ sequence, payload, sentAtMs }))
        return payload
    }

    waitForControl(type, count = 1, timeoutMs = 3000) {
        return waitFor(() => {
            if (this.error) throw this.error
            const matches = this.controls.filter(control => control.type === type)
            return matches.length >= count ? matches.at(count - 1) : null
        }, { timeoutMs, label: `control_${type}_${count}` })
    }

    waitForFrames(count, timeoutMs = 3000) {
        return waitFor(() => {
            if (this.error) throw this.error
            return this.frames.length >= count ? this.frames : null
        }, { timeoutMs, label: `frames_${this.sessionId}_${count}` })
    }

    waitForClose(timeoutMs = 3000) {
        return waitFor(() => this.closeInfo, {
            timeoutMs,
            label: `close_${this.sessionId}`,
        })
    }
}

function websocketUrl(port, {
    sessionId,
    resumeFrom = 0,
    resumeKey,
    reconnect = false,
    idleTimeoutMs,
    reconnectWindowMs,
    processingDelayMs,
    maxQueueFrames,
} = {}) {
    const params = new URLSearchParams({
        sessionId,
        resumeFrom: String(resumeFrom),
        reconnect: reconnect ? '1' : '0',
    })
    if (resumeKey) params.set('resumeKey', resumeKey)
    if (idleTimeoutMs != null) params.set('idleTimeoutMs', String(idleTimeoutMs))
    if (reconnectWindowMs != null) {
        params.set('reconnectWindowMs', String(reconnectWindowMs))
    }
    if (processingDelayMs != null) {
        params.set('processingDelayMs', String(processingDelayMs))
    }
    if (maxQueueFrames != null) params.set('maxQueueFrames', String(maxQueueFrames))
    return `ws://127.0.0.1:${port}/dev-audio?${params}`
}

async function openClient({ port, token, ...options }) {
    const ws = new WebSocket(websocketUrl(port, options), {
        headers: { Authorization: `Bearer ${token}` },
        perMessageDeflate: false,
    })
    const client = new LoopbackClient(ws, options.sessionId)
    await new Promise((resolve, reject) => {
        ws.once('open', resolve)
        ws.once('error', reject)
    })
    await client.waitForControl('hello')
    client.sendControl({
        type: 'metadata',
        sessionId: options.sessionId,
        audio: {
            codec: AUDIO_CONTRACT.codec,
            sampleRate: AUDIO_CONTRACT.sampleRate,
            channels: AUDIO_CONTRACT.channels,
            bytesPerFrame: AUDIO_CONTRACT.bytesPerFrame,
            frameDurationMs: AUDIO_CONTRACT.frameDurationMs,
        },
    })
    await client.waitForControl('ready')
    return client
}

async function openRejectedClient({ port, token, ...options }) {
    const ws = new WebSocket(websocketUrl(port, options), {
        headers: { Authorization: `Bearer ${token}` },
        perMessageDeflate: false,
    })
    const client = new LoopbackClient(ws, options.sessionId)
    await client.waitForClose()
    return client
}

function getJson({ port, token, pathname }) {
    return new Promise((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1',
            port,
            path: pathname,
            method: 'GET',
            headers: token ? { Authorization: `Bearer ${token}` } : {},
        }, res => {
            const chunks = []
            res.on('data', chunk => chunks.push(chunk))
            res.on('end', () => {
                const body = Buffer.concat(chunks).toString('utf8')
                if (res.statusCode !== 200) {
                    reject(new Error(`http_${res.statusCode}_${pathname}`))
                    return
                }
                try {
                    resolve(JSON.parse(body))
                } catch {
                    reject(new Error(`invalid_json_${pathname}`))
                }
            })
        })
        req.on('error', reject)
        req.end()
    })
}

async function waitForCompleted({ port, token, sessionId, timeoutMs = 3000 }) {
    return waitFor(async () => {
        const metrics = await getJson({ port, token, pathname: '/metrics' })
        return metrics.sessions.find(session => session.sessionId === sessionId) ?? false
    }, { timeoutMs, intervalMs: 10, label: `completed_${sessionId}` })
}

async function waitForActive({
    port,
    token,
    sessionId,
    predicate = () => true,
    timeoutMs = 3000,
}) {
    return waitFor(async () => {
        const metrics = await getJson({ port, token, pathname: '/metrics' })
        const session = metrics.active.find(item => item.sessionId === sessionId)
        return session && predicate(session) ? session : false
    }, { timeoutMs, intervalMs: 5, label: `active_${sessionId}` })
}

async function gracefulEnd(client) {
    client.sendControl({ type: 'graceful_end' })
    await client.waitForClose()
}

function assertExactEchoes(client, expectedRecords) {
    assert.equal(client.frames.length, expectedRecords.length)
    assert.deepEqual(
        client.frames.map(frame => frame.sequence),
        expectedRecords.map(record => record.sequence),
    )
    for (let index = 0; index < expectedRecords.length; index += 1) {
        const expected = expectedRecords[index]
        const actual = client.frames[index]
        assert.equal(actual.payloadLength, AUDIO_CONTRACT.bytesPerFrame)
        assert.ok(actual.payload.equals(expected.payload), `payload mismatch seq=${expected.sequence}`)
    }
}

function collectExpected(client, sequences) {
    return sequences.map(sequence => ({
        sequence,
        payload: client.sentPayloads.get(sequence),
    }))
}

function latencySummary(values) {
    if (values.length === 0) {
        return { samples: 0, averageMs: 0, p95Ms: 0, maxMs: 0 }
    }
    const sorted = [...values].sort((a, b) => a - b)
    const total = sorted.reduce((sum, value) => sum + value, 0)
    const p95Index = Math.min(
        sorted.length - 1,
        Math.max(0, Math.ceil(sorted.length * 0.95) - 1),
    )
    return {
        samples: sorted.length,
        averageMs: Number((total / sorted.length).toFixed(3)),
        p95Ms: sorted[p95Index],
        maxMs: sorted.at(-1),
    }
}

function clientLatencyValues(clients) {
    return clients.flatMap(client => client.frames.map(frame => (
        Math.max(0, frame.clientReceivedAtMs - frame.sentAtMs)
    )))
}

function scenarioSummary(id, label, sessions, {
    clients = [],
    ...extra
} = {}) {
    const totalFramesSent = sessions.reduce((sum, session) => sum + session.framesSent, 0)
    return {
        id,
        label,
        status: 'PASS',
        framesSent: totalFramesSent,
        framesReceived: sessions.reduce(
            (sum, session) => sum + session.framesReceived,
            0,
        ),
        bytesSent: sessions.reduce((sum, session) => sum + session.bytesSent, 0),
        bytesReceived: sessions.reduce((sum, session) => sum + session.bytesReceived, 0),
        missing: sessions.reduce((sum, session) => sum + session.missingFrames, 0),
        duplicates: sessions.reduce((sum, session) => sum + session.duplicates, 0),
        rejected: sessions.reduce((sum, session) => sum + session.rejectedFrames, 0),
        outOfOrder: sessions.reduce(
            (sum, session) => sum + session.outOfOrderFrames,
            0,
        ),
        queueHighWaterMark: Math.max(
            0,
            ...sessions.map(session => session.queueHighWaterMark),
        ),
        reconnects: sessions.reduce(
            (sum, session) => sum + session.reconnectCount,
            0,
        ),
        timeouts: sessions.reduce(
            (sum, session) => sum + session.timeoutCount,
            0,
        ),
        droppedOnCleanup: sessions.reduce(
            (sum, session) => sum + session.droppedOnCleanup,
            0,
        ),
        latency: latencySummary(clientLatencyValues(clients)),
        cleanup: sessions.every(session => session.cleanupResult === 'released')
            ? 'released'
            : 'failed',
        sessionMetrics: sessions,
        ...extra,
    }
}

function aggregateScenarioMetrics(scenarios, clients) {
    const sessions = scenarios.flatMap(scenario => scenario.sessionMetrics)
    return {
        scope: 'A-J only; authentication preflight excluded',
        scenarios: scenarios.length,
        sessions: sessions.length,
        framesSent: sessions.reduce((sum, session) => sum + session.framesSent, 0),
        framesReceived: sessions.reduce(
            (sum, session) => sum + session.framesReceived,
            0,
        ),
        wireFramesReceived: sessions.reduce(
            (sum, session) => sum + session.wireFramesReceived,
            0,
        ),
        bytesSent: sessions.reduce((sum, session) => sum + session.bytesSent, 0),
        bytesReceived: sessions.reduce(
            (sum, session) => sum + session.bytesReceived,
            0,
        ),
        duplicates: sessions.reduce((sum, session) => sum + session.duplicates, 0),
        missingFrames: sessions.reduce(
            (sum, session) => sum + session.missingFrames,
            0,
        ),
        outOfOrderFrames: sessions.reduce(
            (sum, session) => sum + session.outOfOrderFrames,
            0,
        ),
        rejectedFrames: sessions.reduce(
            (sum, session) => sum + session.rejectedFrames,
            0,
        ),
        checksumMismatches: sessions.reduce(
            (sum, session) => sum + session.checksumMismatches,
            0,
        ),
        queueHighWaterMark: Math.max(
            0,
            ...sessions.map(session => session.queueHighWaterMark),
        ),
        reconnects: sessions.reduce(
            (sum, session) => sum + session.reconnectCount,
            0,
        ),
        timeouts: sessions.reduce(
            (sum, session) => sum + session.timeoutCount,
            0,
        ),
        droppedOnCleanup: sessions.reduce(
            (sum, session) => sum + session.droppedOnCleanup,
            0,
        ),
        latency: latencySummary(clientLatencyValues(clients)),
    }
}

async function assertPortReleased(port) {
    return new Promise((resolve, reject) => {
        const socket = net.connect({ host: '127.0.0.1', port })
        const timer = setTimeout(() => {
            socket.destroy()
            reject(new Error('port_release_check_timeout'))
        }, 1000)
        socket.once('connect', () => {
            clearTimeout(timer)
            socket.destroy()
            reject(new Error('dev_loopback_port_still_listening'))
        })
        socket.once('error', error => {
            clearTimeout(timer)
            if (error.code === 'ECONNREFUSED') {
                resolve(true)
                return
            }
            reject(error)
        })
    })
}

async function ensureChildStopped(child) {
    if (child.exitCode != null || child.signalCode != null) {
        return { code: child.exitCode, signal: child.signalCode }
    }

    let exitPromise = onceChildExit(child, 1000).catch(() => null)
    try { child.send({ type: 'shutdown' }) } catch {}
    let result = await exitPromise
    if (result) return result

    exitPromise = onceChildExit(child, 1000).catch(() => null)
    try { child.kill('SIGTERM') } catch {}
    result = await exitPromise
    if (result) return result

    exitPromise = onceChildExit(child, 1000).catch(() => null)
    try { child.kill('SIGKILL') } catch {}
    result = await exitPromise
    if (result) return result

    throw new Error('dev_loopback_child_could_not_be_stopped')
}

async function runLoopbackSuite({ quiet = false } = {}) {
    fs.mkdirSync(TEMP_ROOT, { recursive: true })
    const runtimeDir = fs.mkdtempSync(path.join(TEMP_ROOT, 'run-'))
    const child = fork(SERVER_PATH, [], {
        cwd: path.dirname(SERVER_PATH),
        execArgv: [`--max-old-space-size=${CHILD_MAX_OLD_SPACE_MIB}`],
        env: {
            NODE_ENV: 'test',
            DEV_LOOPBACK_HOST: '127.0.0.1',
            DEV_LOOPBACK_PORT: '0',
            DEV_LOOPBACK_TMP_DIR: runtimeDir,
        },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
    const childStdout = []
    const childStderr = []
    child.stdout.on('data', chunk => childStdout.push(String(chunk)))
    child.stderr.on('data', chunk => childStderr.push(String(chunk)))

    let authToken = null
    let ready = null
    let finalMetrics = null
    let stopped = null
    let exit = null
    const scenarios = []
    const scenarioClients = []
    const startedByHarnessAt = new Date().toISOString()

    try {
        ready = await onceChildMessage(child, message => message?.type === 'ready')
        authToken = ready.authToken
        assert.equal(typeof authToken, 'string')
        assert.ok(authToken.length >= 64)
        delete ready.authToken

        const port = ready.port

        // Authentication and session-token isolation preflight.
        const authRejected = await openRejectedClient({
            port,
            token: crypto.randomBytes(32).toString('hex'),
            sessionId: 'AUTH-wrong-token',
        })
        assert.equal(authRejected.closeInfo.code, 4401)

        const isolation = await openClient({
            port,
            token: authToken,
            sessionId: 'AUTH-session-isolation',
            reconnect: true,
            reconnectWindowMs: 500,
        })
        isolation.sendFrame(0, 91)
        await isolation.waitForFrames(1)
        const activeConflict = await openRejectedClient({
            port,
            token: authToken,
            sessionId: 'AUTH-session-isolation',
            resumeFrom: 1,
            resumeKey: isolation.resumeKey,
            reconnect: true,
        })
        assert.equal(activeConflict.closeInfo.code, 4409)
        const isolationResumeKey = isolation.resumeKey
        isolation.ws.close(4001, 'isolation_reconnect')
        await isolation.waitForClose()
        await delay(20)
        const wrongResume = await openRejectedClient({
            port,
            token: authToken,
            sessionId: 'AUTH-session-isolation',
            resumeFrom: 1,
            resumeKey: crypto.randomBytes(16).toString('hex'),
            reconnect: true,
        })
        assert.equal(wrongResume.closeInfo.code, 4409)
        const isolationReconnected = await openClient({
            port,
            token: authToken,
            sessionId: 'AUTH-session-isolation',
            resumeFrom: 1,
            resumeKey: isolationResumeKey,
            reconnect: true,
        })
        await gracefulEnd(isolationReconnected)
        const isolationMetrics = await waitForCompleted({
            port,
            token: authToken,
            sessionId: 'AUTH-session-isolation',
        })
        assert.equal(isolationMetrics.reconnectCount, 1)

        // A — paced, normal, bidirectional real-time stream.
        const a = await openClient({
            port,
            token: authToken,
            sessionId: 'A-normal-streaming',
        })
        for (let sequence = 0; sequence < 50; sequence += 1) {
            a.sendFrame(sequence, 1)
            await delay(AUDIO_CONTRACT.frameDurationMs)
        }
        await a.waitForFrames(50)
        assertExactEchoes(a, collectExpected(a, [...Array(50).keys()]))
        await gracefulEnd(a)
        const aMetrics = await waitForCompleted({
            port,
            token: authToken,
            sessionId: 'A-normal-streaming',
        })
        assert.equal(aMetrics.framesReceived, 50)
        assert.equal(aMetrics.framesSent, 50)
        assert.equal(aMetrics.missingFrames, 0)
        assert.equal(aMetrics.duplicates, 0)
        assert.equal(aMetrics.checksumMismatches, 0)
        scenarioClients.push(a)
        scenarios.push(scenarioSummary(
            'A',
            'normal bidirectional streaming',
            [aMetrics],
            { clients: [a] },
        ))

        // B — client disconnects while frames are still queued.
        const b = await openClient({
            port,
            token: authToken,
            sessionId: 'B-controlled-disconnect',
            processingDelayMs: 10,
        })
        for (let sequence = 0; sequence < 8; sequence += 1) {
            b.sendFrame(sequence, 2)
            await delay(2)
        }
        const bActive = await waitForActive({
            port,
            token: authToken,
            sessionId: 'B-controlled-disconnect',
            predicate: session => (
                session.framesReceived === 8
                && session.queueDepth > 0
                && session.framesSent < session.framesReceived
            ),
        })
        assert.ok(bActive.queueDepth > 0)
        b.ws.close(1000, 'controlled_disconnect')
        await b.waitForClose()
        const bMetrics = await waitForCompleted({
            port,
            token: authToken,
            sessionId: 'B-controlled-disconnect',
        })
        assert.equal(bMetrics.reason, 'client_disconnect')
        assert.equal(bMetrics.cleanupResult, 'released')
        assert.ok(bMetrics.droppedOnCleanup > 0)
        assert.equal(
            bMetrics.framesReceived,
            bMetrics.framesSent + bMetrics.droppedOnCleanup,
        )
        scenarioClients.push(b)
        scenarios.push(scenarioSummary(
            'B',
            'controlled client disconnect',
            [bMetrics],
            { clients: [b] },
        ))

        // C — disconnect/reconnect with exact sequence continuation.
        const c1 = await openClient({
            port,
            token: authToken,
            sessionId: 'C-reconnect',
            reconnect: true,
            reconnectWindowMs: 500,
            processingDelayMs: 20,
        })
        for (let sequence = 0; sequence < 6; sequence += 1) c1.sendFrame(sequence, 3)
        const cActive = await waitForActive({
            port,
            token: authToken,
            sessionId: 'C-reconnect',
            predicate: session => (
                session.framesReceived === 6
                && session.queueDepth >= 2
            ),
        })
        assert.ok(cActive.queueDepth >= 2)
        const cResumeKey = c1.resumeKey
        c1.ws.close(4001, 'planned_reconnect')
        await c1.waitForClose()
        const cFirstConnectionFrames = c1.frames.length
        assert.ok(cFirstConnectionFrames < 6)
        await delay(20)
        const c2 = await openClient({
            port,
            token: authToken,
            sessionId: 'C-reconnect',
            resumeFrom: 6,
            resumeKey: cResumeKey,
            reconnect: true,
            reconnectWindowMs: 500,
        })
        const queuedAfterReconnect = 6 - cFirstConnectionFrames
        await c2.waitForFrames(queuedAfterReconnect)
        assert.deepEqual(
            [...c1.frames, ...c2.frames].map(frame => frame.sequence),
            [...Array(6).keys()],
        )
        for (let sequence = 6; sequence < 40; sequence += 1) {
            c2.sendFrame(sequence, 3)
            await delay(AUDIO_CONTRACT.frameDurationMs)
        }
        await c2.waitForFrames(queuedAfterReconnect + 34)
        const cCombinedFrames = [...c1.frames, ...c2.frames]
        assert.equal(cCombinedFrames.length, 40)
        assert.deepEqual(
            cCombinedFrames.map(frame => frame.sequence),
            [...Array(40).keys()],
        )
        for (const frame of cCombinedFrames) {
            const expectedPayload = frame.sequence < 6
                ? c1.sentPayloads.get(frame.sequence)
                : c2.sentPayloads.get(frame.sequence)
            assert.ok(frame.payload.equals(expectedPayload))
        }
        await gracefulEnd(c2)
        const cMetrics = await waitForCompleted({
            port,
            token: authToken,
            sessionId: 'C-reconnect',
        })
        assert.equal(cMetrics.reconnectCount, 1)
        assert.equal(cMetrics.framesReceived, 40)
        assert.equal(cMetrics.framesSent, 40)
        assert.equal(cMetrics.duplicates, 0)
        assert.equal(cMetrics.missingFrames, 0)
        scenarioClients.push(c1, c2)
        scenarios.push(scenarioSummary(
            'C',
            'reconnect continuity including accepted queued frames',
            [cMetrics],
            { clients: [c1, c2] },
        ))

        // D — idle timeout after a valid handshake.
        const d = await openClient({
            port,
            token: authToken,
            sessionId: 'D-timeout',
            idleTimeoutMs: 80,
        })
        await d.waitForClose()
        const dMetrics = await waitForCompleted({
            port,
            token: authToken,
            sessionId: 'D-timeout',
        })
        assert.equal(dMetrics.reason, 'timeout')
        assert.equal(dMetrics.timeoutCount, 1)
        scenarioClients.push(d)
        scenarios.push(scenarioSummary(
            'D',
            'idle timeout',
            [dMetrics],
            { clients: [d] },
        ))

        // E — bounded queue, controlled failure on overflow.
        const e = await openClient({
            port,
            token: authToken,
            sessionId: 'E-backpressure',
            processingDelayMs: 30,
            maxQueueFrames: 3,
        })
        for (let sequence = 0; sequence < 12; sequence += 1) e.sendFrame(sequence, 5)
        await e.waitForClose()
        const eMetrics = await waitForCompleted({
            port,
            token: authToken,
            sessionId: 'E-backpressure',
        })
        assert.equal(eMetrics.reason, 'queue_backpressure')
        assert.equal(eMetrics.state, 'failed')
        assert.ok(eMetrics.queueHighWaterMark <= 3)
        assert.ok(eMetrics.rejectedFrames >= 1)
        assert.ok(eMetrics.droppedOnCleanup > 0)
        assert.equal(
            eMetrics.framesReceived,
            eMetrics.framesSent + eMetrics.droppedOnCleanup,
        )
        scenarioClients.push(e)
        scenarios.push(scenarioSummary('E', 'bounded backpressure failure', [eMetrics], {
            clients: [e],
            strategy: 'bounded queue + controlled session failure',
        }))

        // F — malformed size/checksum/envelope are rejected; valid frame survives.
        const f = await openClient({
            port,
            token: authToken,
            sessionId: 'F-malformed-frame',
        })
        f.ws.send(Buffer.alloc(4))
        const checksumBad = encodeAudioFrame({
            sequence: 0,
            payload: deterministicPcmFrame(0, 6),
        })
        checksumBad[checksumBad.length - 1] ^= 0xff
        f.ws.send(checksumBad)
        const lengthBad = encodeAudioFrame({
            sequence: 0,
            payload: deterministicPcmFrame(0, 6),
        })
        lengthBad.writeUInt32LE(AUDIO_CONTRACT.bytesPerFrame - 1, 12)
        f.ws.send(lengthBad)
        await f.waitForControl('frame_rejected', 3)
        f.sendFrame(0, 6)
        await f.waitForFrames(1)
        assertExactEchoes(f, collectExpected(f, [0]))
        await gracefulEnd(f)
        const fMetrics = await waitForCompleted({
            port,
            token: authToken,
            sessionId: 'F-malformed-frame',
        })
        assert.equal(fMetrics.rejectedFrames, 3)
        assert.equal(fMetrics.checksumMismatches, 1)
        scenarioClients.push(f)
        scenarios.push(scenarioSummary(
            'F',
            'malformed frame rejection',
            [fMetrics],
            { clients: [f] },
        ))

        // G — duplicate is detected and never replayed.
        const g = await openClient({
            port,
            token: authToken,
            sessionId: 'G-duplicate-frame',
        })
        g.sendFrame(0, 7)
        await g.waitForFrames(1)
        g.sendFrame(0, 7)
        await g.waitForControl('duplicate')
        g.sendFrame(1, 7)
        await g.waitForFrames(2)
        assertExactEchoes(g, collectExpected(g, [0, 1]))
        await gracefulEnd(g)
        const gMetrics = await waitForCompleted({
            port,
            token: authToken,
            sessionId: 'G-duplicate-frame',
        })
        assert.equal(gMetrics.duplicates, 1)
        assert.equal(gMetrics.framesSent, 2)
        scenarioClients.push(g)
        scenarios.push(scenarioSummary(
            'G',
            'duplicate rejection',
            [gMetrics],
            { clients: [g] },
        ))

        // H — out-of-order frame is rejected; retry restores contiguous stream.
        const h = await openClient({
            port,
            token: authToken,
            sessionId: 'H-out-of-order',
        })
        h.sendFrame(1, 8)
        await h.waitForControl('out_of_order')
        const hGapMetrics = await waitForActive({
            port,
            token: authToken,
            sessionId: 'H-out-of-order',
            predicate: session => session.missingFrames === 1,
        })
        assert.equal(hGapMetrics.missingFrames, 1)
        h.sendFrame(0, 8)
        h.sendFrame(1, 8)
        h.sendFrame(2, 8)
        await h.waitForFrames(3)
        assertExactEchoes(h, collectExpected(h, [0, 1, 2]))
        await gracefulEnd(h)
        const hMetrics = await waitForCompleted({
            port,
            token: authToken,
            sessionId: 'H-out-of-order',
        })
        assert.equal(hMetrics.outOfOrderFrames, 1)
        assert.equal(hMetrics.missingFrames, 0)
        scenarioClients.push(h)
        scenarios.push(scenarioSummary(
            'H',
            'out-of-order reject, measured gap, and retry',
            [hMetrics],
            { clients: [h] },
        ))

        // I — targeted emergency stop cannot affect a different session.
        const iTarget = await openClient({
            port,
            token: authToken,
            sessionId: 'I-emergency-target',
        })
        const iPeer = await openClient({
            port,
            token: authToken,
            sessionId: 'I-emergency-peer',
        })
        iTarget.sendFrame(0, 9)
        iPeer.sendFrame(0, 10)
        await iTarget.waitForFrames(1)
        await iPeer.waitForFrames(1)
        iTarget.sendControl({
            type: 'emergency_stop',
            sessionId: 'I-emergency-peer',
        })
        const mismatch = await iTarget.waitForControl('control_rejected')
        assert.equal(mismatch.code, 'session_mismatch')
        iTarget.sendControl({
            type: 'emergency_stop',
            sessionId: 'I-emergency-target',
        })
        await iTarget.waitForClose()
        iPeer.sendFrame(1, 10)
        await iPeer.waitForFrames(2)
        assertExactEchoes(iPeer, collectExpected(iPeer, [0, 1]))
        await gracefulEnd(iPeer)
        const iTargetMetrics = await waitForCompleted({
            port,
            token: authToken,
            sessionId: 'I-emergency-target',
        })
        const iPeerMetrics = await waitForCompleted({
            port,
            token: authToken,
            sessionId: 'I-emergency-peer',
        })
        assert.equal(iTargetMetrics.reason, 'emergency_stop')
        assert.equal(iPeerMetrics.reason, 'completed')
        scenarioClients.push(iTarget, iPeer)
        scenarios.push(scenarioSummary(
            'I',
            'session-scoped emergency stop',
            [iTargetMetrics, iPeerMetrics],
            { clients: [iTarget, iPeer] },
        ))

        // J — parallel interleaved sessions retain independent payloads.
        const jA = await openClient({
            port,
            token: authToken,
            sessionId: 'J-parallel-a',
        })
        const jB = await openClient({
            port,
            token: authToken,
            sessionId: 'J-parallel-b',
        })
        for (let sequence = 0; sequence < 16; sequence += 1) {
            jA.sendFrame(sequence, 11)
            jB.sendFrame(sequence, 12)
        }
        await jA.waitForFrames(16)
        await jB.waitForFrames(16)
        assertExactEchoes(jA, collectExpected(jA, [...Array(16).keys()]))
        assertExactEchoes(jB, collectExpected(jB, [...Array(16).keys()]))
        assert.ok(!jA.frames[0].payload.equals(jB.frames[0].payload))
        await gracefulEnd(jA)
        jB.sendFrame(16, 12)
        await jB.waitForFrames(17)
        assertExactEchoes(jB, collectExpected(jB, [...Array(17).keys()]))
        await gracefulEnd(jB)
        const jAMetrics = await waitForCompleted({
            port,
            token: authToken,
            sessionId: 'J-parallel-a',
        })
        const jBMetrics = await waitForCompleted({
            port,
            token: authToken,
            sessionId: 'J-parallel-b',
        })
        assert.equal(jAMetrics.framesSent, 16)
        assert.equal(jBMetrics.framesSent, 17)
        scenarioClients.push(jA, jB)
        scenarios.push(scenarioSummary(
            'J',
            'parallel session isolation',
            [jAMetrics, jBMetrics],
            { clients: [jA, jB] },
        ))

        finalMetrics = await getJson({
            port,
            token: authToken,
            pathname: '/metrics',
        })
        assert.equal(finalMetrics.runtime.activeSessions, 0)
        assert.ok(finalMetrics.runtime.rssBytes <= finalMetrics.limits.maxRssBytes)
        assert.ok(ready.rssBytes <= finalMetrics.limits.maxRssBytes)
        assert.ok(finalMetrics.runtime.authFailures >= 1)
        assert.ok(finalMetrics.runtime.sessionConflicts >= 2)
        assert.equal(scenarios.length, 10)
        assert.ok(scenarios.every(scenario => scenario.status === 'PASS'))
        assert.ok(scenarios.every(scenario => scenario.cleanup === 'released'))
        assert.equal(aMetrics.missingFrames, 0)
        assert.equal(aMetrics.duplicates, 0)
        assert.equal(aMetrics.checksumMismatches, 0)
        const scenarioAggregate = aggregateScenarioMetrics(
            scenarios,
            scenarioClients,
        )
        assert.equal(
            scenarioAggregate.latency.samples,
            scenarioAggregate.framesSent,
        )
        const securityPreflightSession = finalMetrics.sessions.find(
            session => session.sessionId === 'AUTH-session-isolation',
        )
        assert.ok(securityPreflightSession)

        const stopPromise = onceChildMessage(
            child,
            message => message?.type === 'stopped',
        )
        const exitPromise = onceChildExit(child)
        child.send({ type: 'shutdown' })
        stopped = await stopPromise
        exit = await exitPromise
        assert.equal(exit.code, 0)
        assert.ok(stopped.rssBytes <= finalMetrics.limits.maxRssBytes)
        await assertPortReleased(port)

        let pidGone = false
        try {
            process.kill(ready.pid, 0)
        } catch (error) {
            if (error.code === 'ESRCH') pidGone = true
        }
        assert.equal(pidGone, true)

        const stdout = childStdout.join('')
        const stderr = childStderr.join('')
        assert.equal(stdout.includes(authToken), false)
        assert.equal(stderr.includes(authToken), false)
        assert.equal(fs.readdirSync(runtimeDir).length, 0)
        fs.rmSync(runtimeDir, { recursive: true, force: true })
        assert.equal(fs.existsSync(runtimeDir), false)

        const report = {
            schema: 'YOKO_DEV_AUDIO_LOOPBACK_V1',
            status: 'REAL-TIME AUDIO LOOPBACK PASS',
            devRuntime: {
                bindAddress: ready.host,
                port,
                processId: ready.pid,
                authMode: 'ephemeral in-process bearer + session-scoped resume key',
                productionSecretsUsed: false,
                productionBridgeTrafficUsed: false,
                startTime: ready.startedAt,
                stopTime: stopped.stoppedAt,
                portReleased: true,
                orphanProcessCount: 0,
                runtimeDirectoryRemoved: true,
                rssBytesAtStart: ready.rssBytes,
                rssBytesAtMetrics: finalMetrics.runtime.rssBytes,
                rssBytesAtStop: stopped.rssBytes,
                maxOldSpaceMiB: CHILD_MAX_OLD_SPACE_MIB,
                maxRssBytes: finalMetrics.limits.maxRssBytes,
            },
            audioContract: AUDIO_CONTRACT,
            envelopeBytes: HEADER_BYTES,
            scenarios,
            aggregateMetrics: scenarioAggregate,
            runtimeTotals: {
                scope: 'all completed DEV sessions including authentication preflight',
                ...finalMetrics.aggregate,
            },
            securityPreflightSession,
            securityEvidence: {
                authFailures: finalMetrics.runtime.authFailures,
                sessionConflicts: finalMetrics.runtime.sessionConflicts,
                tokenPersisted: false,
                tokenLogged: false,
            },
            limits: finalMetrics.limits,
            harness: {
                startedAt: startedByHarnessAt,
                completedAt: new Date().toISOString(),
                childExitCode: exit.code,
                temporaryAudioBytes: 0,
            },
        }
        authToken = null
        if (!quiet) {
            console.log('YOKO_DEV_AUDIO_LOOPBACK_V1')
            console.log(JSON.stringify(report, null, 2))
        }
        return report
    } catch (error) {
        const stdoutTail = childStdout.join('').slice(-4000)
        const stderrTail = childStderr.join('').slice(-4000)
        error.message = `${error.message}\nchild stdout:\n${stdoutTail}\nchild stderr:\n${stderrTail}`
        throw error
    } finally {
        try {
            await ensureChildStopped(child)
            if (ready?.port) await assertPortReleased(ready.port)
        } finally {
            if (fs.existsSync(runtimeDir)) {
                fs.rmSync(runtimeDir, { recursive: true, force: true })
            }
            authToken = null
        }
    }
}

if (require.main === module) {
    runLoopbackSuite().catch(error => {
        console.error(`DEV_LOOPBACK_FAILED: ${error.message}`)
        process.exitCode = 1
    })
}

module.exports = {
    LoopbackClient,
    assertExactEchoes,
    openClient,
    runLoopbackSuite,
    scenarioSummary,
}
