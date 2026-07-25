'use strict'

const crypto = require('node:crypto')
const http = require('node:http')
const { WebSocket, WebSocketServer } = require('ws')

const {
    AUDIO_CONTRACT,
    FrameProtocolError,
    decodeAudioFrame,
    encodeAudioFrame,
} = require('./protocol')

const DEFAULT_LIMITS = Object.freeze({
    maxSessions: 8,
    maxTotalSessions: 32,
    maxRuntimeMs: 15000,
    maxSessionRuntimeMs: 5000,
    maxRssBytes: 128 * 1024 * 1024,
    maxFramesPerSession: 512,
    maxBytesPerSession: 512 * AUDIO_CONTRACT.bytesPerFrame,
    maxQueueFrames: 8,
    maxOutboundBufferedBytes: 8 * (AUDIO_CONTRACT.bytesPerFrame + 28),
    idleTimeoutMs: 1000,
    reconnectWindowMs: 500,
    metadataTimeoutMs: 500,
})

const CLOSE_CODES = Object.freeze({
    unauthorized: 4401,
    badRequest: 4400,
    timeout: 4408,
    conflict: 4409,
    completed: 4410,
    emergencyStop: 4412,
    backpressure: 4413,
    resourceLimit: 4414,
})

function clampInteger(value, fallback, min, max) {
    if (value == null || value === '') return fallback
    const parsed = Number(value)
    if (!Number.isInteger(parsed)) return fallback
    return Math.max(min, Math.min(max, parsed))
}

function safeTokenEqual(headerValue, token) {
    const expected = Buffer.from(`Bearer ${token}`)
    const actual = Buffer.from(typeof headerValue === 'string' ? headerValue : '')
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected)
}

function safeJsonParse(input) {
    try {
        return JSON.parse(String(input))
    } catch {
        return null
    }
}

function latencySummary(values) {
    if (!values.length) {
        return { averageMs: 0, p95Ms: 0, maxMs: 0 }
    }
    const sorted = [...values].sort((a, b) => a - b)
    const total = sorted.reduce((sum, value) => sum + value, 0)
    const p95Index = Math.min(
        sorted.length - 1,
        Math.max(0, Math.ceil(sorted.length * 0.95) - 1),
    )
    return {
        averageMs: Number((total / sorted.length).toFixed(3)),
        p95Ms: Number(sorted[p95Index].toFixed(3)),
        maxMs: Number(sorted.at(-1).toFixed(3)),
    }
}

function publicSessionSnapshot(session) {
    return {
        sessionId: session.sessionId,
        state: session.state,
        reason: session.reason,
        startedAt: session.startedAt,
        endedAt: session.endedAt,
        durationMs: session.durationMs,
        framesSent: session.metrics.framesSent,
        framesReceived: session.metrics.framesReceived,
        wireFramesReceived: session.metrics.wireFramesReceived,
        bytesSent: session.metrics.bytesSent,
        bytesReceived: session.metrics.bytesReceived,
        duplicates: session.metrics.duplicates,
        missingFrames: session.metrics.missingFrames,
        outOfOrderFrames: session.metrics.outOfOrderFrames,
        rejectedFrames: session.metrics.rejectedFrames,
        checksumMismatches: session.metrics.checksumMismatches,
        queueDepth: session.queue.length,
        queueHighWaterMark: session.metrics.queueHighWaterMark,
        reconnectCount: session.metrics.reconnectCount,
        timeoutCount: session.metrics.timeoutCount,
        droppedOnCleanup: session.metrics.droppedOnCleanup,
        serverProcessingLatency: latencySummary(session.metrics.latencies),
        cleanupResult: session.cleanupResult,
    }
}

function aggregateSnapshots(snapshots) {
    const latencyValues = []
    const aggregate = {
        sessions: snapshots.length,
        framesSent: 0,
        framesReceived: 0,
        wireFramesReceived: 0,
        bytesSent: 0,
        bytesReceived: 0,
        duplicates: 0,
        missingFrames: 0,
        outOfOrderFrames: 0,
        rejectedFrames: 0,
        checksumMismatches: 0,
        queueHighWaterMark: 0,
        reconnects: 0,
        timeouts: 0,
        droppedOnCleanup: 0,
    }
    for (const snapshot of snapshots) {
        aggregate.framesSent += snapshot.framesSent
        aggregate.framesReceived += snapshot.framesReceived
        aggregate.wireFramesReceived += snapshot.wireFramesReceived
        aggregate.bytesSent += snapshot.bytesSent
        aggregate.bytesReceived += snapshot.bytesReceived
        aggregate.duplicates += snapshot.duplicates
        aggregate.missingFrames += snapshot.missingFrames
        aggregate.outOfOrderFrames += snapshot.outOfOrderFrames
        aggregate.rejectedFrames += snapshot.rejectedFrames
        aggregate.checksumMismatches += snapshot.checksumMismatches
        aggregate.queueHighWaterMark = Math.max(
            aggregate.queueHighWaterMark,
            snapshot.queueHighWaterMark,
        )
        aggregate.reconnects += snapshot.reconnectCount
        aggregate.timeouts += snapshot.timeoutCount
        aggregate.droppedOnCleanup += snapshot.droppedOnCleanup
    }
    for (const snapshot of snapshots) {
        const source = snapshot._latencies
        if (Array.isArray(source)) latencyValues.push(...source)
    }
    aggregate.serverProcessingLatency = latencySummary(latencyValues)
    return aggregate
}

function createSession(sessionId, options, connection) {
    const now = new Date()
    return {
        sessionId,
        state: 'connecting',
        reason: null,
        startedAt: now.toISOString(),
        startedEpochMs: now.getTime(),
        endedAt: null,
        durationMs: 0,
        expectedSequence: 0,
        resumeKey: crypto.randomBytes(16).toString('hex'),
        connection,
        connectionId: crypto.randomUUID(),
        connected: false,
        finished: false,
        allowReconnect: options.allowReconnect,
        options,
        queue: [],
        pendingGaps: new Set(),
        processing: false,
        endRequested: false,
        idleTimer: null,
        metadataTimer: null,
        runtimeTimer: null,
        reconnectTimer: null,
        cleanupResult: 'pending',
        metrics: {
            framesSent: 0,
            framesReceived: 0,
            wireFramesReceived: 0,
            bytesSent: 0,
            bytesReceived: 0,
            duplicates: 0,
            missingFrames: 0,
            outOfOrderFrames: 0,
            rejectedFrames: 0,
            checksumMismatches: 0,
            queueHighWaterMark: 0,
            reconnectCount: 0,
            timeoutCount: 0,
            droppedOnCleanup: 0,
            latencies: [],
        },
    }
}

function createDevLoopbackRuntime({
    host = '127.0.0.1',
    port = 0,
    token,
    limits = {},
    transformOutboundPayload = payload => payload,
} = {}) {
    if (host !== '127.0.0.1') {
        throw new Error('dev_loopback_must_bind_ipv4_loopback')
    }
    if (typeof token !== 'string' || token.length < 32) {
        throw new Error('dev_loopback_token_required')
    }
    if (typeof transformOutboundPayload !== 'function') {
        throw new Error('dev_loopback_transform_must_be_function')
    }

    const effectiveLimits = Object.freeze({ ...DEFAULT_LIMITS, ...limits })
    const activeSessions = new Map()
    const completedSessions = new Map()
    const runtimeStartedAt = new Date().toISOString()
    const runtimeCounters = {
        authFailures: 0,
        sessionConflicts: 0,
        invalidSessionIds: 0,
    }
    let stopping = false
    let stopPromise = null

    const sendControl = (ws, payload) => {
        if (ws?.readyState !== WebSocket.OPEN) return false
        try {
            ws.send(JSON.stringify(payload))
            return true
        } catch {
            return false
        }
    }

    const clearSessionTimers = session => {
        for (const field of ['idleTimer', 'metadataTimer', 'runtimeTimer', 'reconnectTimer']) {
            if (session[field]) clearTimeout(session[field])
            session[field] = null
        }
    }

    const completeSession = (session, reason, {
        state = 'ended',
        closeCode = 1000,
        closeReason = reason,
        closeConnection = true,
    } = {}) => {
        if (!session || session.finished) return
        session.finished = true
        session.state = state
        session.reason = reason
        session.endedAt = new Date().toISOString()
        session.durationMs = Date.now() - session.startedEpochMs
        session.metrics.droppedOnCleanup += session.queue.length
        session.queue.length = 0
        clearSessionTimers(session)
        session.cleanupResult = 'released'
        activeSessions.delete(session.sessionId)
        completedSessions.set(session.sessionId, session)

        const ws = session.connection
        session.connection = null
        session.connected = false
        if (closeConnection && ws?.readyState === WebSocket.OPEN) {
            try {
                ws.close(closeCode, String(closeReason).slice(0, 100))
            } catch {
                try { ws.terminate() } catch {}
            }
        }
        console.log(
            `[dev-loopback] session=${session.sessionId} state=${state} reason=${reason} ` +
            `rx=${session.metrics.framesReceived} tx=${session.metrics.framesSent}`,
        )
    }

    const resetIdleTimer = session => {
        if (session.idleTimer) clearTimeout(session.idleTimer)
        session.idleTimer = setTimeout(() => {
            session.metrics.timeoutCount += 1
            sendControl(session.connection, { type: 'timeout', stage: 'audio_idle' })
            completeSession(session, 'timeout', {
                state: 'failed',
                closeCode: CLOSE_CODES.timeout,
            })
        }, session.options.idleTimeoutMs)
        session.idleTimer.unref()
    }

    const drainQueue = async session => {
        if (session.processing || session.finished) return
        session.processing = true
        try {
            while (!session.finished && session.queue.length > 0) {
                const item = session.queue[0]
                if (session.options.processingDelayMs > 0) {
                    await new Promise(resolve => {
                        setTimeout(resolve, session.options.processingDelayMs)
                    })
                }
                if (session.finished) break
                const ws = session.connection
                if (!ws || ws.readyState !== WebSocket.OPEN || !session.connected) break
                if (ws.bufferedAmount > effectiveLimits.maxOutboundBufferedBytes) {
                    session.metrics.rejectedFrames += 1
                    completeSession(session, 'outbound_backpressure', {
                        state: 'failed',
                        closeCode: CLOSE_CODES.backpressure,
                    })
                    break
                }

                let outboundPayload
                try {
                    outboundPayload = transformOutboundPayload(
                        Buffer.from(item.payload),
                        Object.freeze({
                            sessionId: session.sessionId,
                            sequence: item.sequence,
                            sentAtMs: item.sentAtMs,
                            flags: item.flags,
                        }),
                    )
                } catch {
                    session.metrics.rejectedFrames += 1
                    completeSession(session, 'outbound_transform_failed', {
                        state: 'failed',
                        closeCode: CLOSE_CODES.badRequest,
                    })
                    break
                }
                if (
                    !Buffer.isBuffer(outboundPayload)
                    || outboundPayload.length !== AUDIO_CONTRACT.bytesPerFrame
                ) {
                    session.metrics.rejectedFrames += 1
                    completeSession(session, 'outbound_transform_invalid', {
                        state: 'failed',
                        closeCode: CLOSE_CODES.badRequest,
                    })
                    break
                }

                session.queue.shift()
                const outbound = encodeAudioFrame({
                    sequence: item.sequence,
                    payload: outboundPayload,
                    sentAtMs: item.sentAtMs,
                    flags: item.flags,
                })
                try {
                    ws.send(outbound, { binary: true })
                } catch {
                    session.queue.unshift(item)
                    break
                }
                session.metrics.framesSent += 1
                session.metrics.bytesSent += outboundPayload.length
                session.metrics.latencies.push(Math.max(0, Date.now() - item.sentAtMs))
            }
        } finally {
            session.processing = false
            if (!session.finished && session.endRequested && session.queue.length === 0) {
                sendControl(session.connection, { type: 'ended', reason: 'completed' })
                completeSession(session, 'completed')
            }
        }
    }

    const acceptAudioFrame = (session, data) => {
        session.metrics.wireFramesReceived += 1
        let frame
        try {
            frame = decodeAudioFrame(data)
        } catch (error) {
            const code = error instanceof FrameProtocolError
                ? error.code
                : 'malformed_envelope'
            session.metrics.rejectedFrames += 1
            if (code === 'checksum_mismatch') session.metrics.checksumMismatches += 1
            sendControl(session.connection, { type: 'frame_rejected', code })
            return
        }

        if (frame.sequence < session.expectedSequence) {
            session.metrics.duplicates += 1
            sendControl(session.connection, {
                type: 'duplicate',
                sequence: frame.sequence,
                expected: session.expectedSequence,
            })
            return
        }
        if (frame.sequence > session.expectedSequence) {
            const boundedGapEnd = Math.min(
                frame.sequence,
                effectiveLimits.maxFramesPerSession,
            )
            for (
                let missing = session.expectedSequence;
                missing < boundedGapEnd;
                missing += 1
            ) {
                session.pendingGaps.add(missing)
            }
            session.metrics.missingFrames = session.pendingGaps.size
            session.metrics.outOfOrderFrames += 1
            session.metrics.rejectedFrames += 1
            sendControl(session.connection, {
                type: 'out_of_order',
                sequence: frame.sequence,
                expected: session.expectedSequence,
            })
            return
        }
        if (
            session.metrics.framesReceived >= effectiveLimits.maxFramesPerSession
            || session.metrics.bytesReceived + frame.payloadLength > effectiveLimits.maxBytesPerSession
        ) {
            session.metrics.rejectedFrames += 1
            completeSession(session, 'resource_limit', {
                state: 'failed',
                closeCode: CLOSE_CODES.resourceLimit,
            })
            return
        }
        if (session.queue.length >= session.options.maxQueueFrames) {
            session.metrics.rejectedFrames += 1
            completeSession(session, 'queue_backpressure', {
                state: 'failed',
                closeCode: CLOSE_CODES.backpressure,
            })
            return
        }

        session.pendingGaps.delete(frame.sequence)
        session.metrics.missingFrames = session.pendingGaps.size
        session.expectedSequence += 1
        session.metrics.framesReceived += 1
        session.metrics.bytesReceived += frame.payloadLength
        session.queue.push(frame)
        session.metrics.queueHighWaterMark = Math.max(
            session.metrics.queueHighWaterMark,
            session.queue.length,
        )
        resetIdleTimer(session)
        void drainQueue(session)
    }

    const validateMetadata = (message, session) => {
        if (message?.type !== 'metadata' || message.sessionId !== session.sessionId) {
            return false
        }
        const audio = message.audio
        return audio?.codec === AUDIO_CONTRACT.codec
            && audio.sampleRate === AUDIO_CONTRACT.sampleRate
            && audio.channels === AUDIO_CONTRACT.channels
            && audio.bytesPerFrame === AUDIO_CONTRACT.bytesPerFrame
            && audio.frameDurationMs === AUDIO_CONTRACT.frameDurationMs
    }

    const attachConnection = (session, ws, isReconnect) => {
        session.connection = ws
        session.connectionId = crypto.randomUUID()
        session.connected = false
        session.state = 'connecting'
        if (isReconnect) session.metrics.reconnectCount += 1
        const connectionId = session.connectionId

        sendControl(ws, {
            type: 'hello',
            sessionId: session.sessionId,
            reconnect: isReconnect,
            expectedSequence: session.expectedSequence,
            audio: AUDIO_CONTRACT,
        })

        session.metadataTimer = setTimeout(() => {
            if (session.finished || session.connectionId !== connectionId) return
            session.metrics.rejectedFrames += 1
            completeSession(session, 'metadata_timeout', {
                state: 'failed',
                closeCode: CLOSE_CODES.timeout,
            })
        }, effectiveLimits.metadataTimeoutMs)
        session.metadataTimer.unref()

        ws.on('message', (data, isBinary) => {
            if (
                session.finished
                || session.connection !== ws
                || session.connectionId !== connectionId
            ) return

            if (isBinary) {
                if (!session.connected) {
                    session.metrics.rejectedFrames += 1
                    sendControl(ws, { type: 'frame_rejected', code: 'metadata_required' })
                    return
                }
                acceptAudioFrame(session, data)
                return
            }

            const message = safeJsonParse(data)
            if (!message) {
                session.metrics.rejectedFrames += 1
                sendControl(ws, { type: 'control_rejected', code: 'invalid_json' })
                return
            }
            if (!session.connected) {
                if (!validateMetadata(message, session)) {
                    session.metrics.rejectedFrames += 1
                    completeSession(session, 'metadata_invalid', {
                        state: 'failed',
                        closeCode: CLOSE_CODES.badRequest,
                    })
                    return
                }
                if (session.metadataTimer) clearTimeout(session.metadataTimer)
                session.metadataTimer = null
                session.connected = true
                session.state = 'active'
                resetIdleTimer(session)
                sendControl(ws, {
                    type: 'ready',
                    sessionId: session.sessionId,
                    expectedSequence: session.expectedSequence,
                    resumeKey: session.resumeKey,
                })
                void drainQueue(session)
                return
            }

            resetIdleTimer(session)
            if (message.type === 'graceful_end') {
                session.endRequested = true
                if (!session.processing && session.queue.length === 0) {
                    sendControl(ws, { type: 'ended', reason: 'completed' })
                    completeSession(session, 'completed')
                }
                return
            }
            if (message.type === 'emergency_stop') {
                if (message.sessionId && message.sessionId !== session.sessionId) {
                    session.metrics.rejectedFrames += 1
                    sendControl(ws, {
                        type: 'control_rejected',
                        code: 'session_mismatch',
                    })
                    return
                }
                sendControl(ws, { type: 'ended', reason: 'emergency_stop' })
                completeSession(session, 'emergency_stop', {
                    state: 'ended',
                    closeCode: CLOSE_CODES.emergencyStop,
                })
                return
            }
            session.metrics.rejectedFrames += 1
            sendControl(ws, { type: 'control_rejected', code: 'unsupported_control' })
        })

        ws.on('close', code => {
            if (
                session.finished
                || session.connection !== ws
                || session.connectionId !== connectionId
            ) return
            if (session.idleTimer) clearTimeout(session.idleTimer)
            if (session.metadataTimer) clearTimeout(session.metadataTimer)
            session.idleTimer = null
            session.metadataTimer = null
            session.connection = null
            session.connected = false

            if (session.allowReconnect && code !== 1000) {
                session.state = 'reconnecting'
                session.reconnectTimer = setTimeout(() => {
                    session.metrics.timeoutCount += 1
                    completeSession(session, 'reconnect_timeout', {
                        state: 'failed',
                        closeConnection: false,
                    })
                }, session.options.reconnectWindowMs)
                session.reconnectTimer.unref()
                return
            }
            completeSession(session, 'client_disconnect', {
                state: 'ended',
                closeConnection: false,
            })
        })

        ws.on('error', () => {
            // The close handler owns lifecycle cleanup. Errors are deliberately
            // not logged with request data or headers.
        })
    }

    const httpServer = http.createServer((req, res) => {
        if (req.method === 'GET' && req.url === '/health') {
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({
                status: stopping ? 'stopping' : 'ok',
                activeSessions: activeSessions.size,
                completedSessions: completedSessions.size,
            }))
            return
        }
        if (req.method === 'GET' && req.url === '/metrics') {
            if (!safeTokenEqual(req.headers.authorization, token)) {
                res.statusCode = 401
                res.end('unauthorized')
                return
            }
            const completed = [...completedSessions.values()].map(session => {
                const snapshot = publicSessionSnapshot(session)
                return { ...snapshot, _latencies: [...session.metrics.latencies] }
            })
            const active = [...activeSessions.values()].map(publicSessionSnapshot)
            const aggregate = aggregateSnapshots(completed)
            for (const snapshot of completed) delete snapshot._latencies
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({
                runtime: {
                    pid: process.pid,
                    host,
                    port: httpServer.address()?.port ?? null,
                    startedAt: runtimeStartedAt,
                    rssBytes: process.memoryUsage().rss,
                    activeSessions: activeSessions.size,
                    completedSessions: completedSessions.size,
                    ...runtimeCounters,
                },
                audio: AUDIO_CONTRACT,
                limits: effectiveLimits,
                aggregate,
                active,
                sessions: completed,
            }))
            return
        }
        res.statusCode = 404
        res.end('not found')
    })

    const wss = new WebSocketServer({
        server: httpServer,
        path: '/dev-audio',
        maxPayload: AUDIO_CONTRACT.bytesPerFrame + 4096,
    })

    wss.on('connection', (ws, req) => {
        if (stopping) {
            ws.close(1012, 'runtime_stopping')
            return
        }
        if (!safeTokenEqual(req.headers.authorization, token)) {
            runtimeCounters.authFailures += 1
            ws.close(CLOSE_CODES.unauthorized, 'unauthorized')
            return
        }

        const url = new URL(req.url, `http://${host}`)
        const sessionId = url.searchParams.get('sessionId') ?? ''
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(sessionId)) {
            runtimeCounters.invalidSessionIds += 1
            ws.close(CLOSE_CODES.badRequest, 'invalid_session_id')
            return
        }
        if (completedSessions.has(sessionId)) {
            ws.close(CLOSE_CODES.completed, 'session_completed')
            return
        }

        const existing = activeSessions.get(sessionId)
        const resumeFrom = clampInteger(
            url.searchParams.get('resumeFrom'),
            0,
            0,
            effectiveLimits.maxFramesPerSession,
        )
        if (existing) {
            if (existing.connection || existing.state !== 'reconnecting') {
                runtimeCounters.sessionConflicts += 1
                ws.close(CLOSE_CODES.conflict, 'session_already_connected')
                return
            }
            if (resumeFrom !== existing.expectedSequence) {
                runtimeCounters.sessionConflicts += 1
                ws.close(CLOSE_CODES.conflict, 'resume_sequence_mismatch')
                return
            }
            if (url.searchParams.get('resumeKey') !== existing.resumeKey) {
                runtimeCounters.sessionConflicts += 1
                ws.close(CLOSE_CODES.conflict, 'resume_key_mismatch')
                return
            }
            if (existing.reconnectTimer) clearTimeout(existing.reconnectTimer)
            existing.reconnectTimer = null
            attachConnection(existing, ws, true)
            return
        }
        if (activeSessions.size >= effectiveLimits.maxSessions) {
            ws.close(CLOSE_CODES.resourceLimit, 'max_sessions')
            return
        }
        if (
            activeSessions.size + completedSessions.size
            >= effectiveLimits.maxTotalSessions
        ) {
            ws.close(CLOSE_CODES.resourceLimit, 'max_total_sessions')
            return
        }
        if (resumeFrom !== 0) {
            ws.close(CLOSE_CODES.conflict, 'unknown_resume_session')
            return
        }

        const options = {
            allowReconnect: url.searchParams.get('reconnect') === '1',
            idleTimeoutMs: clampInteger(
                url.searchParams.get('idleTimeoutMs'),
                effectiveLimits.idleTimeoutMs,
                50,
                effectiveLimits.idleTimeoutMs,
            ),
            reconnectWindowMs: clampInteger(
                url.searchParams.get('reconnectWindowMs'),
                effectiveLimits.reconnectWindowMs,
                50,
                effectiveLimits.reconnectWindowMs,
            ),
            processingDelayMs: clampInteger(
                url.searchParams.get('processingDelayMs'),
                0,
                0,
                50,
            ),
            maxQueueFrames: clampInteger(
                url.searchParams.get('maxQueueFrames'),
                effectiveLimits.maxQueueFrames,
                1,
                effectiveLimits.maxQueueFrames,
            ),
        }
        const session = createSession(sessionId, options, ws)
        activeSessions.set(sessionId, session)
        session.runtimeTimer = setTimeout(() => {
            session.metrics.timeoutCount += 1
            sendControl(session.connection, { type: 'timeout', stage: 'max_runtime' })
            completeSession(session, 'max_runtime', {
                state: 'failed',
                closeCode: CLOSE_CODES.timeout,
            })
        }, effectiveLimits.maxSessionRuntimeMs)
        session.runtimeTimer.unref()
        attachConnection(session, ws, false)
    })

    const listen = () => new Promise((resolve, reject) => {
        httpServer.once('error', reject)
        httpServer.listen(port, host, () => {
            httpServer.off('error', reject)
            const address = httpServer.address()
            resolve({
                pid: process.pid,
                host,
                port: address.port,
                startedAt: runtimeStartedAt,
            })
        })
    })

    const stop = () => {
        if (stopPromise) return stopPromise
        stopPromise = (async () => {
            stopping = true
            for (const session of [...activeSessions.values()]) {
                completeSession(session, 'runtime_shutdown', {
                    state: 'ended',
                    closeConnection: false,
                })
                try { session.connection?.terminate() } catch {}
            }
            for (const client of wss.clients) {
                try { client.terminate() } catch {}
            }
            await new Promise(resolve => wss.close(() => resolve()))
            await new Promise(resolve => httpServer.close(() => resolve()))
        })()
        return stopPromise
    }

    return {
        activeSessions,
        completedSessions,
        effectiveLimits,
        httpServer,
        listen,
        stop,
        wss,
    }
}

async function startStandalone() {
    if (!process.send) {
        throw new Error('dev_loopback_ipc_required')
    }
    const authToken = crypto.randomBytes(32).toString('hex')
    const runtime = createDevLoopbackRuntime({
        host: process.env.DEV_LOOPBACK_HOST ?? '127.0.0.1',
        port: Number(process.env.DEV_LOOPBACK_PORT ?? 0),
        token: authToken,
    })
    const ready = await runtime.listen()
    console.log(`[dev-loopback] listening on ${ready.host}:${ready.port} pid=${ready.pid}`)
    process.send({
        type: 'ready',
        ...ready,
        authToken,
        rssBytes: process.memoryUsage().rss,
    })

    let stopping = false
    let runtimeWatchdog = null
    let memoryWatchdog = null
    const shutdown = async signal => {
        if (stopping) return
        stopping = true
        if (runtimeWatchdog) clearTimeout(runtimeWatchdog)
        if (memoryWatchdog) clearInterval(memoryWatchdog)
        const stopTime = new Date().toISOString()
        await runtime.stop()
        if (process.send) {
            process.send({
                type: 'stopped',
                signal,
                stoppedAt: stopTime,
                rssBytes: process.memoryUsage().rss,
            })
        }
        setImmediate(() => process.exit(0))
    }
    process.on('message', message => {
        if (message?.type === 'shutdown') void shutdown('ipc')
    })
    process.on('SIGINT', () => void shutdown('SIGINT'))
    process.on('SIGTERM', () => void shutdown('SIGTERM'))
    runtimeWatchdog = setTimeout(
        () => void shutdown('max_runtime'),
        runtime.effectiveLimits.maxRuntimeMs,
    )
    runtimeWatchdog.unref()
    memoryWatchdog = setInterval(() => {
        if (process.memoryUsage().rss > runtime.effectiveLimits.maxRssBytes) {
            void shutdown('rss_limit')
        }
    }, 50)
    memoryWatchdog.unref()
}

if (require.main === module) {
    startStandalone().catch(error => {
        console.error(`[dev-loopback] fatal: ${error.message}`)
        process.exitCode = 1
    })
}

module.exports = {
    CLOSE_CODES,
    DEFAULT_LIMITS,
    aggregateSnapshots,
    createDevLoopbackRuntime,
    latencySummary,
    publicSessionSnapshot,
}
