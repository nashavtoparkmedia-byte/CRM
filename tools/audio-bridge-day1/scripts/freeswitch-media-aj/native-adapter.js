'use strict'

const http = require('node:http')
const net = require('node:net')
const { WebSocket, WebSocketServer } = require('ws')

const {
    AUDIO_CONTRACT,
    FrameProtocolError,
    decodeAudioFrame,
    encodeAudioFrame,
} = require('../dev-loopback/protocol')

const REQUIRED_PROBE_HEADER = 'capability-v1'
const CANONICAL_UUID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

const DEFAULT_LIMITS = Object.freeze({
    maxSessions: 2,
    maxArmedSlots: 2,
    maxFramesPerSession: 6000,
    maxQueueFrames: 8,
    maxNativeMessageBytes: 32 * AUDIO_CONTRACT.bytesPerFrame,
    maxBridgeBufferedBytes: 8 * (AUDIO_CONTRACT.bytesPerFrame + 28),
    maxNativeBufferedBytes: 8 * AUDIO_CONTRACT.bytesPerFrame,
    bridgeHandshakeTimeoutMs: 1000,
    idleTimeoutMs: 1750,
    maxSessionRuntimeMs: 120000,
})

const CLOSE_CODES = Object.freeze({
    badRequest: 4400,
    unauthorized: 4401,
    conflict: 4409,
    emergencyStop: 4412,
    backpressure: 4413,
    resourceLimit: 4414,
    upstreamFailure: 4500,
    timeout: 4408,
})
const CLOSE_GRACE_MS = 250

function isCanonicalUuid(value) {
    return typeof value === 'string' && CANONICAL_UUID_PATTERN.test(value)
}

function isPrivateIpv4(host) {
    if (!net.isIPv4(host)) return false
    const octets = host.split('.').map(Number)
    return octets[0] === 10
        || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
        || (octets[0] === 192 && octets[1] === 168)
}

function assertSafeBindHost(host) {
    if (host === '127.0.0.1' || isPrivateIpv4(host)) return
    throw new Error('native_adapter_bind_must_be_loopback_or_rfc1918')
}

function parseBridgeUrl(value) {
    let parsed
    try {
        parsed = new URL(value)
    } catch {
        throw new Error('native_adapter_bridge_url_invalid')
    }
    if (
        parsed.protocol !== 'ws:'
        || parsed.username
        || parsed.password
        || parsed.pathname !== '/dev-audio'
        || parsed.search
        || parsed.hash
    ) {
        throw new Error('native_adapter_bridge_url_invalid')
    }
    if (
        parsed.hostname !== '127.0.0.1'
        && !isPrivateIpv4(parsed.hostname)
    ) {
        throw new Error('native_adapter_bridge_must_be_loopback_or_rfc1918')
    }
    return parsed
}

function boundedInteger(value, fallback, min, max, code) {
    if (value == null) return fallback
    if (!Number.isInteger(value) || value < min || value > max) {
        throw new Error(code)
    }
    return value
}

function safeJsonParse(input) {
    try {
        return JSON.parse(String(input))
    } catch {
        return null
    }
}

function latencySummary(values) {
    if (values.length === 0) {
        return { average_ms: 0, p95_ms: 0, max_ms: 0 }
    }
    const sorted = [...values].sort((a, b) => a - b)
    const total = sorted.reduce((sum, value) => sum + value, 0)
    const p95Index = Math.min(
        sorted.length - 1,
        Math.max(0, Math.ceil(sorted.length * 0.95) - 1),
    )
    return {
        average_ms: Number((total / sorted.length).toFixed(3)),
        p95_ms: Number(sorted[p95Index].toFixed(3)),
        max_ms: Number(sorted.at(-1).toFixed(3)),
    }
}

function createSignalAccumulator(targetHz) {
    return {
        targetHz,
        sampleCount: 0,
        squareSum: 0,
        peak: 0,
        sineSum: 0,
        cosineSum: 0,
    }
}

function updateSignalAccumulator(accumulator, pcm) {
    for (let offset = 0; offset < pcm.length; offset += 2) {
        const sample = pcm.readInt16LE(offset)
        const absolute = Math.abs(sample)
        accumulator.squareSum += sample * sample
        accumulator.peak = Math.max(accumulator.peak, absolute)
        if (accumulator.targetHz != null) {
            const angle = (
                2
                * Math.PI
                * accumulator.targetHz
                * accumulator.sampleCount
            ) / AUDIO_CONTRACT.sampleRate
            accumulator.sineSum += sample * Math.sin(angle)
            accumulator.cosineSum += sample * Math.cos(angle)
        }
        accumulator.sampleCount += 1
    }
}

function signalSnapshot(accumulator) {
    const count = accumulator.sampleCount
    const estimatedAmplitude = (
        count > 0 && accumulator.targetHz != null
    )
        ? (2 * Math.hypot(
            accumulator.sineSum,
            accumulator.cosineSum,
        )) / count
        : 0
    return {
        target_hz: accumulator.targetHz,
        estimated_amplitude: Number(estimatedAmplitude.toFixed(3)),
        rms: count > 0
            ? Number(Math.sqrt(accumulator.squareSum / count).toFixed(3))
            : 0,
        peak: accumulator.peak,
        samples: count,
    }
}

function normalizeProfile(input, effectiveLimits) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new Error('native_adapter_profile_required')
    }
    if (
        input.channelUuid != null
        || input.channel_uuid != null
        || input.uuid != null
    ) {
        throw new Error('native_adapter_arm_is_fifo_not_uuid_bound')
    }
    const profileId = input.id ?? input.profileId ?? input.profile_id
    if (
        typeof profileId !== 'string'
        || !/^[A-Za-z0-9_-]{1,64}$/.test(profileId)
    ) {
        throw new Error('native_adapter_profile_id_invalid')
    }
    const processingDelayMs = boundedInteger(
        input.processingDelayMs ?? input.processing_delay_ms,
        0,
        0,
        50,
        'native_adapter_processing_delay_invalid',
    )
    const maxQueueFrames = boundedInteger(
        input.maxQueueFrames ?? input.max_queue_frames,
        effectiveLimits.maxQueueFrames,
        1,
        effectiveLimits.maxQueueFrames,
        'native_adapter_profile_queue_limit_invalid',
    )
    const returnHz = input.returnHz ?? input.return_hz ?? 997
    if (
        typeof returnHz !== 'number'
        || !Number.isFinite(returnHz)
        || returnHz < 100
        || returnHz > 3400
    ) {
        throw new Error('native_adapter_return_hz_invalid')
    }
    const sourceHz = input.sourceHz ?? input.source_hz ?? null
    if (
        sourceHz != null
        && (
            typeof sourceHz !== 'number'
            || !Number.isFinite(sourceHz)
            || sourceHz < 100
            || sourceHz > 3400
        )
    ) {
        throw new Error('native_adapter_source_hz_invalid')
    }
    return Object.freeze({
        channelUuid: null,
        profileId,
        processingDelayMs,
        maxQueueFrames,
        suppressNativeReturn: input.suppressNativeReturn === true
            || input.suppress_native_return === true,
        returnHz,
        sourceHz,
    })
}

function safeProfileSnapshot(profile) {
    return {
        channel_uuid: profile.channelUuid,
        profile_id: profile.profileId,
        processing_delay_ms: profile.processingDelayMs,
        max_queue_frames: profile.maxQueueFrames,
        suppress_native_return: profile.suppressNativeReturn,
        return_hz: profile.returnHz,
        source_hz: profile.sourceHz,
    }
}

function callbackProfileSnapshot(profile) {
    return {
        channelUuid: profile.channelUuid,
        profileId: profile.profileId,
        processingDelayMs: profile.processingDelayMs,
        maxQueueFrames: profile.maxQueueFrames,
        suppressNativeReturn: profile.suppressNativeReturn,
        returnHz: profile.returnHz,
        sourceHz: profile.sourceHz,
        ...safeProfileSnapshot(profile),
    }
}

function createMetrics() {
    return {
        adapterAcceptedNativeFrames: 0,
        adapterWrappedInternalFrames: 0,
        adapterAcceptedReturnFrames: 0,
        adapterEmittedNativeFrames: 0,
        nativeBytesReceived: 0,
        internalBytesSent: 0,
        internalBytesReceived: 0,
        nativeBytesSent: 0,
        rejectedFrames: 0,
        duplicateFrames: 0,
        outOfOrderFrames: 0,
        recoveredMissingFrames: 0,
        unresolvedMissingFrames: 0,
        checksumMismatches: 0,
        controlMessages: 0,
        websocketConnections: 1,
        queueHighWaterMark: 0,
        cleanupDroppedFrames: 0,
        inFlightReturnFramesAtCleanup: 0,
        malformedNativeControls: 0,
        unsupportedSampleFormats: 0,
        bridgeAuthFailures: 0,
        backpressureFailures: 0,
        idleTimeouts: 0,
        bridgeBufferedBytesHighWaterMark: 0,
        nativeBufferedBytesHighWaterMark: 0,
        latencies: [],
    }
}

function publicSessionSnapshot(session) {
    return {
        channel_uuid: session.channelUuid,
        session_id: session.sessionId,
        profile_id: session.profile.profileId,
        state: session.state,
        reason: session.reason,
        started_at: session.startedAt,
        ended_at: session.endedAt,
        duration_ms: session.durationMs,
        bridge_ready: session.bridgeReady,
        native_close_code: session.nativeCloseCode,
        bridge_close_code: session.bridgeCloseCode,
        adapter_accepted_native_frames:
            session.metrics.adapterAcceptedNativeFrames,
        adapter_wrapped_internal_frames:
            session.metrics.adapterWrappedInternalFrames,
        adapter_accepted_return_frames:
            session.metrics.adapterAcceptedReturnFrames,
        adapter_emitted_native_frames:
            session.metrics.adapterEmittedNativeFrames,
        native_bytes_received: session.metrics.nativeBytesReceived,
        internal_bytes_sent: session.metrics.internalBytesSent,
        internal_bytes_received: session.metrics.internalBytesReceived,
        native_bytes_sent: session.metrics.nativeBytesSent,
        rejected_frames: session.metrics.rejectedFrames,
        duplicate_frames: session.metrics.duplicateFrames,
        out_of_order_frames: session.metrics.outOfOrderFrames,
        recovered_missing_frames: session.metrics.recoveredMissingFrames,
        unresolved_missing_frames: session.metrics.unresolvedMissingFrames,
        checksum_mismatches: session.metrics.checksumMismatches,
        control_messages: session.metrics.controlMessages,
        websocket_connections: session.metrics.websocketConnections,
        queue_depth: session.queue.length,
        carry_bytes: session.carry.length,
        queue_high_water_mark: session.metrics.queueHighWaterMark,
        bridge_buffered_bytes_high_water_mark:
            session.metrics.bridgeBufferedBytesHighWaterMark,
        native_buffered_bytes_high_water_mark:
            session.metrics.nativeBufferedBytesHighWaterMark,
        cleanup_dropped_frames: session.metrics.cleanupDroppedFrames,
        in_flight_return_frames_at_cleanup:
            session.metrics.inFlightReturnFramesAtCleanup,
        malformed_native_controls:
            session.metrics.malformedNativeControls,
        unsupported_sample_formats:
            session.metrics.unsupportedSampleFormats,
        bridge_auth_failures: session.metrics.bridgeAuthFailures,
        backpressure_failures: session.metrics.backpressureFailures,
        idle_timeouts: session.metrics.idleTimeouts,
        latency: latencySummary(session.metrics.latencies),
        source_tone_amplitudes: signalSnapshot(session.sourceSignal),
        return_tone_amplitudes: signalSnapshot(session.returnSignal),
        cleanup_result: session.cleanupResult,
        profile: safeProfileSnapshot(session.profile),
    }
}

function createFreeSwitchMediaAdapter({
    nativeHost = '127.0.0.1',
    nativePort = 0,
    bridgeUrl,
    bridgeToken,
    limits = {},
    onSessionAssigned,
} = {}) {
    assertSafeBindHost(nativeHost)
    if (
        !Number.isInteger(nativePort)
        || nativePort < 0
        || nativePort > 65535
    ) {
        throw new Error('native_adapter_port_invalid')
    }
    const parsedBridgeUrl = parseBridgeUrl(bridgeUrl)
    if (
        typeof bridgeToken !== 'string'
        || !/^[A-Za-z0-9._~-]{32,256}$/.test(bridgeToken)
    ) {
        throw new Error('native_adapter_bridge_token_required')
    }
    if (
        onSessionAssigned != null
        && typeof onSessionAssigned !== 'function'
    ) {
        throw new Error('native_adapter_assignment_callback_invalid')
    }
    if (
        limits == null
        || typeof limits !== 'object'
        || Array.isArray(limits)
    ) {
        throw new Error('native_adapter_limits_invalid')
    }
    const allowedLimitKeys = new Set(Object.keys(DEFAULT_LIMITS))
    const unknownLimitKey = Object.keys(limits).find(
        key => !allowedLimitKeys.has(key),
    )
    if (unknownLimitKey) {
        throw new Error(`native_adapter_limit_unknown:${unknownLimitKey}`)
    }

    const requestedLimits = { ...DEFAULT_LIMITS, ...limits }
    const effectiveLimits = Object.freeze({
        maxSessions: boundedInteger(
            requestedLimits.maxSessions,
            DEFAULT_LIMITS.maxSessions,
            1,
            2,
            'native_adapter_max_sessions_invalid',
        ),
        maxArmedSlots: boundedInteger(
            requestedLimits.maxArmedSlots,
            DEFAULT_LIMITS.maxArmedSlots,
            1,
            2,
            'native_adapter_max_armed_slots_invalid',
        ),
        maxFramesPerSession: boundedInteger(
            requestedLimits.maxFramesPerSession,
            DEFAULT_LIMITS.maxFramesPerSession,
            1,
            6000,
            'native_adapter_max_frames_invalid',
        ),
        maxQueueFrames: boundedInteger(
            requestedLimits.maxQueueFrames,
            DEFAULT_LIMITS.maxQueueFrames,
            1,
            64,
            'native_adapter_max_queue_invalid',
        ),
        maxNativeMessageBytes: boundedInteger(
            requestedLimits.maxNativeMessageBytes,
            DEFAULT_LIMITS.maxNativeMessageBytes,
            AUDIO_CONTRACT.bytesPerFrame,
            64 * AUDIO_CONTRACT.bytesPerFrame,
            'native_adapter_native_message_limit_invalid',
        ),
        maxBridgeBufferedBytes: boundedInteger(
            requestedLimits.maxBridgeBufferedBytes,
            DEFAULT_LIMITS.maxBridgeBufferedBytes,
            AUDIO_CONTRACT.bytesPerFrame + 28,
            1024 * 1024,
            'native_adapter_bridge_buffer_limit_invalid',
        ),
        maxNativeBufferedBytes: boundedInteger(
            requestedLimits.maxNativeBufferedBytes,
            DEFAULT_LIMITS.maxNativeBufferedBytes,
            AUDIO_CONTRACT.bytesPerFrame,
            1024 * 1024,
            'native_adapter_native_buffer_limit_invalid',
        ),
        bridgeHandshakeTimeoutMs: boundedInteger(
            requestedLimits.bridgeHandshakeTimeoutMs,
            DEFAULT_LIMITS.bridgeHandshakeTimeoutMs,
            100,
            5000,
            'native_adapter_handshake_timeout_invalid',
        ),
        idleTimeoutMs: boundedInteger(
            requestedLimits.idleTimeoutMs,
            DEFAULT_LIMITS.idleTimeoutMs,
            100,
            120000,
            'native_adapter_idle_timeout_invalid',
        ),
        maxSessionRuntimeMs: boundedInteger(
            requestedLimits.maxSessionRuntimeMs,
            DEFAULT_LIMITS.maxSessionRuntimeMs,
            100,
            120000,
            'native_adapter_runtime_limit_invalid',
        ),
    })

    if (effectiveLimits.maxArmedSlots < effectiveLimits.maxSessions) {
        throw new Error('native_adapter_armed_slots_below_session_limit')
    }

    const pendingProfiles = []
    const activeSessions = new Map()
    const completedSessions = new Map()
    const runtimeStartedAt = new Date().toISOString()
    const runtimeCounters = {
        upgradesRejected: 0,
        invalidPaths: 0,
        authFailures: 0,
        duplicateConnections: 0,
        unarmedConnections: 0,
        capacityRejections: 0,
        sessionsAssigned: 0,
    }
    let listening = false
    let stopping = false
    let stopPromise = null
    let stoppedAt = null

    const httpServer = http.createServer((_req, res) => {
        res.statusCode = 404
        res.end('not found')
    })
    const wss = new WebSocketServer({
        noServer: true,
        maxPayload: effectiveLimits.maxNativeMessageBytes,
        perMessageDeflate: false,
    })

    const sendNativeControl = (session, payload) => {
        const ws = session.nativeWs
        if (!ws || ws.readyState !== WebSocket.OPEN) return false
        try {
            ws.send(JSON.stringify(payload))
            session.metrics.controlMessages += 1
            return true
        } catch {
            return false
        }
    }

    const sendBridgeControl = (session, payload) => {
        const ws = session.bridgeWs
        if (!ws || ws.readyState !== WebSocket.OPEN) return false
        try {
            ws.send(JSON.stringify(payload))
            session.metrics.controlMessages += 1
            return true
        } catch {
            return false
        }
    }

    const closeSocketBounded = (ws, code, reason) => {
        if (!ws || ws.readyState === WebSocket.CLOSED) return
        if (ws.readyState === WebSocket.CONNECTING) {
            try { ws.terminate() } catch {}
            return
        }
        if (ws.readyState === WebSocket.OPEN) {
            try {
                ws.close(code, String(reason).slice(0, 100))
            } catch {
                try { ws.terminate() } catch {}
                return
            }
        }
        if (ws.readyState !== WebSocket.CLOSING) return
        const forceTimer = setTimeout(() => {
            if (ws.readyState !== WebSocket.CLOSED) {
                try { ws.terminate() } catch {}
            }
        }, CLOSE_GRACE_MS)
        forceTimer.unref()
        ws.once('close', () => clearTimeout(forceTimer))
    }

    const completeSession = (
        session,
        reason,
        {
            state = 'ended',
            nativeCloseCode = 1000,
            bridgeCloseCode = 1000,
        } = {},
    ) => {
        if (!session || session.finished) return false
        session.finished = true
        session.state = state
        session.reason = reason
        session.nativeCloseCode ??= nativeCloseCode
        session.bridgeCloseCode ??= bridgeCloseCode
        session.endedAt = new Date().toISOString()
        session.durationMs = Date.now() - session.startedEpochMs
        session.metrics.cleanupDroppedFrames += session.queue.length
        if (session.carry.length > 0) {
            session.metrics.cleanupDroppedFrames += 1
        }
        const inFlightReturns = session.pendingSentAt.size
        session.metrics.inFlightReturnFramesAtCleanup += inFlightReturns
        session.metrics.cleanupDroppedFrames += inFlightReturns
        session.metrics.unresolvedMissingFrames += inFlightReturns
        session.queue.length = 0
        session.carry = Buffer.alloc(0)
        session.pendingSentAt.clear()
        if (session.runtimeTimer) clearTimeout(session.runtimeTimer)
        if (session.handshakeTimer) clearTimeout(session.handshakeTimer)
        if (session.idleTimer) clearTimeout(session.idleTimer)
        session.runtimeTimer = null
        session.handshakeTimer = null
        session.idleTimer = null
        session.cleanupResult = 'released'
        activeSessions.delete(session.channelUuid)
        completedSessions.set(session.channelUuid, session)

        const nativeWs = session.nativeWs
        const bridgeWs = session.bridgeWs
        closeSocketBounded(nativeWs, nativeCloseCode, reason)
        closeSocketBounded(bridgeWs, bridgeCloseCode, reason)
        return true
    }

    const failSession = (
        session,
        reason,
        {
            nativeCloseCode = CLOSE_CODES.badRequest,
            bridgeCloseCode = CLOSE_CODES.badRequest,
        } = {},
    ) => completeSession(session, reason, {
        state: 'failed',
        nativeCloseCode,
        bridgeCloseCode,
    })

    const resetIdleTimer = session => {
        if (session.finished || !session.bridgeReady) return
        if (session.idleTimer) clearTimeout(session.idleTimer)
        session.idleTimer = setTimeout(() => {
            session.metrics.idleTimeouts += 1
            failSession(session, 'media_idle_timeout', {
                nativeCloseCode: CLOSE_CODES.timeout,
                bridgeCloseCode: CLOSE_CODES.timeout,
            })
        }, effectiveLimits.idleTimeoutMs)
        session.idleTimer.unref()
    }

    const flushNativeQueue = session => {
        if (
            session.finished
            || !session.bridgeReady
            || session.bridgeWs?.readyState !== WebSocket.OPEN
        ) {
            return
        }
        while (!session.finished && session.queue.length > 0) {
            const bufferedAmount = session.bridgeWs.bufferedAmount
            session.metrics.bridgeBufferedBytesHighWaterMark = Math.max(
                session.metrics.bridgeBufferedBytesHighWaterMark,
                bufferedAmount,
            )
            if (bufferedAmount > effectiveLimits.maxBridgeBufferedBytes) {
                session.metrics.rejectedFrames += 1
                session.metrics.backpressureFailures += 1
                failSession(session, 'bridge_outbound_backpressure', {
                    nativeCloseCode: CLOSE_CODES.backpressure,
                    bridgeCloseCode: CLOSE_CODES.backpressure,
                })
                return
            }

            const item = session.queue.shift()
            const wrapped = encodeAudioFrame({
                sequence: item.sequence,
                payload: item.payload,
                sentAtMs: item.sentAtMs,
            })
            try {
                session.bridgeWs.send(wrapped, { binary: true })
            } catch {
                session.queue.unshift(item)
                failSession(session, 'bridge_send_failed', {
                    nativeCloseCode: CLOSE_CODES.upstreamFailure,
                    bridgeCloseCode: CLOSE_CODES.upstreamFailure,
                })
                return
            }
            session.pendingSentAt.set(item.sequence, item.sentAtMs)
            session.metrics.adapterWrappedInternalFrames += 1
            session.metrics.internalBytesSent += wrapped.length
        }
    }

    const acceptNormalizedFrame = (session, frame) => {
        if (
            session.metrics.adapterAcceptedNativeFrames
            >= effectiveLimits.maxFramesPerSession
        ) {
            session.metrics.rejectedFrames += 1
            failSession(session, 'frame_limit', {
                nativeCloseCode: CLOSE_CODES.resourceLimit,
                bridgeCloseCode: CLOSE_CODES.resourceLimit,
            })
            return false
        }
        if (session.queue.length >= effectiveLimits.maxQueueFrames) {
            session.metrics.rejectedFrames += 1
            session.metrics.backpressureFailures += 1
            failSession(session, 'native_queue_backpressure', {
                nativeCloseCode: CLOSE_CODES.backpressure,
                bridgeCloseCode: CLOSE_CODES.backpressure,
            })
            return false
        }

        const sequence = session.nextNativeSequence
        session.nextNativeSequence += 1
        const item = {
            sequence,
            sentAtMs: Date.now(),
            payload: Buffer.from(frame),
        }
        session.queue.push(item)
        session.metrics.adapterAcceptedNativeFrames += 1
        session.metrics.nativeBytesReceived += frame.length
        session.metrics.queueHighWaterMark = Math.max(
            session.metrics.queueHighWaterMark,
            session.queue.length,
        )
        updateSignalAccumulator(session.sourceSignal, frame)
        resetIdleTimer(session)
        flushNativeQueue(session)
        return !session.finished
    }

    const acceptNativeBinary = (session, data) => {
        const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data)
        if (
            chunk.length === 0
            || chunk.length > effectiveLimits.maxNativeMessageBytes
        ) {
            session.metrics.rejectedFrames += 1
            failSession(session, 'native_audio_message_invalid', {
                nativeCloseCode: CLOSE_CODES.badRequest,
            })
            return
        }

        let combined
        if (session.carry.length === 0) {
            combined = chunk
        } else {
            combined = Buffer.concat([session.carry, chunk])
        }
        let offset = 0
        while (
            !session.finished
            && combined.length - offset >= AUDIO_CONTRACT.bytesPerFrame
        ) {
            const frame = combined.subarray(
                offset,
                offset + AUDIO_CONTRACT.bytesPerFrame,
            )
            offset += AUDIO_CONTRACT.bytesPerFrame
            if (!acceptNormalizedFrame(session, frame)) return
        }
        session.carry = Buffer.from(combined.subarray(offset))
    }

    const acceptNativeControl = (session, data) => {
        session.metrics.controlMessages += 1
        const message = safeJsonParse(data)
        if (!message) {
            session.metrics.malformedNativeControls += 1
            failSession(session, 'malformed_native_control')
            return
        }
        if (message.type !== 'audio' && message.type !== 'rawAudio') {
            failSession(session, 'unsupported_native_control')
            return
        }
        const audio = message.data ?? message.audio
        if (
            !audio
            || audio.sampleRate !== AUDIO_CONTRACT.sampleRate
            || (
                audio.channels != null
                && audio.channels !== AUDIO_CONTRACT.channels
            )
            || (
                audio.codec != null
                && audio.codec !== AUDIO_CONTRACT.codec
            )
        ) {
            session.metrics.unsupportedSampleFormats += 1
            failSession(session, 'unsupported_sample_format')
        }
    }

    const acceptBridgeBinary = (session, data) => {
        const wire = Buffer.isBuffer(data) ? data : Buffer.from(data)
        session.metrics.internalBytesReceived += wire.length
        let frame
        try {
            frame = decodeAudioFrame(wire)
        } catch (error) {
            session.metrics.rejectedFrames += 1
            if (
                error instanceof FrameProtocolError
                && error.code === 'checksum_mismatch'
            ) {
                session.metrics.checksumMismatches += 1
            }
            failSession(session, 'invalid_bridge_audio')
            return
        }

        if (!session.pendingSentAt.has(frame.sequence)) {
            session.metrics.rejectedFrames += 1
            if (frame.sequence < session.expectedReturnSequence) {
                session.metrics.duplicateFrames += 1
            } else if (frame.sequence > session.expectedReturnSequence) {
                session.metrics.outOfOrderFrames += 1
            }
            failSession(session, 'bridge_return_unsolicited')
            return
        }
        if (frame.sequence < session.expectedReturnSequence) {
            session.metrics.duplicateFrames += 1
            session.metrics.rejectedFrames += 1
            return
        }
        if (frame.sequence > session.expectedReturnSequence) {
            session.metrics.outOfOrderFrames += 1
            session.metrics.rejectedFrames += 1
            session.metrics.unresolvedMissingFrames += (
                frame.sequence - session.expectedReturnSequence
            )
            failSession(session, 'bridge_return_out_of_order')
            return
        }

        session.expectedReturnSequence += 1
        session.metrics.adapterAcceptedReturnFrames += 1
        const sentAtMs = session.pendingSentAt.get(frame.sequence)
        session.pendingSentAt.delete(frame.sequence)
        if (sentAtMs != null) {
            session.metrics.latencies.push(Math.max(0, Date.now() - sentAtMs))
        }
        updateSignalAccumulator(session.returnSignal, frame.payload)

        if (session.profile.suppressNativeReturn) return
        if (session.nativeWs?.readyState !== WebSocket.OPEN) {
            session.metrics.cleanupDroppedFrames += 1
            completeSession(session, 'native_disconnect')
            return
        }
        const bufferedAmount = session.nativeWs.bufferedAmount
        session.metrics.nativeBufferedBytesHighWaterMark = Math.max(
            session.metrics.nativeBufferedBytesHighWaterMark,
            bufferedAmount,
        )
        if (bufferedAmount > effectiveLimits.maxNativeBufferedBytes) {
            session.metrics.rejectedFrames += 1
            session.metrics.backpressureFailures += 1
            failSession(session, 'native_outbound_backpressure', {
                nativeCloseCode: CLOSE_CODES.backpressure,
                bridgeCloseCode: CLOSE_CODES.backpressure,
            })
            return
        }
        try {
            session.nativeWs.send(frame.payload, { binary: true })
        } catch {
            failSession(session, 'native_send_failed', {
                nativeCloseCode: CLOSE_CODES.upstreamFailure,
            })
            return
        }
        session.metrics.adapterEmittedNativeFrames += 1
        session.metrics.nativeBytesSent += frame.payload.length
    }

    const acceptBridgeControl = (session, data) => {
        session.metrics.controlMessages += 1
        const message = safeJsonParse(data)
        if (!message || typeof message.type !== 'string') {
            failSession(session, 'malformed_bridge_control')
            return
        }
        if (message.type === 'hello') {
            if (
                message.sessionId !== session.sessionId
                || session.bridgeMetadataSent
            ) {
                failSession(session, 'bridge_hello_invalid')
                return
            }
            session.bridgeMetadataSent = true
            sendBridgeControl(session, {
                type: 'metadata',
                sessionId: session.sessionId,
                audio: AUDIO_CONTRACT,
            })
            return
        }
        if (message.type === 'ready') {
            if (
                message.sessionId !== session.sessionId
                || !session.bridgeMetadataSent
                || session.bridgeReady
            ) {
                failSession(session, 'bridge_ready_invalid')
                return
            }
            session.bridgeReady = true
            session.state = 'active'
            if (session.handshakeTimer) clearTimeout(session.handshakeTimer)
            session.handshakeTimer = null
            resetIdleTimer(session)
            flushNativeQueue(session)
            return
        }
        if (
            message.type === 'frame_rejected'
            || message.type === 'out_of_order'
            || message.type === 'duplicate'
            || message.type === 'control_rejected'
        ) {
            session.metrics.rejectedFrames += 1
            failSession(session, `bridge_${message.type}`, {
                nativeCloseCode: CLOSE_CODES.badRequest,
                bridgeCloseCode: CLOSE_CODES.badRequest,
            })
            return
        }
        if (message.type === 'timeout') {
            failSession(session, 'bridge_timeout', {
                nativeCloseCode: CLOSE_CODES.upstreamFailure,
            })
            return
        }
        if (message.type === 'ended') {
            completeSession(
                session,
                message.reason === 'emergency_stop'
                    ? 'emergency_stop'
                    : 'bridge_ended',
            )
            return
        }
        failSession(session, 'unsupported_bridge_control')
    }

    const openBridgeConnection = session => {
        if (session.finished) return
        const target = new URL(parsedBridgeUrl.href)
        target.searchParams.set('sessionId', session.sessionId)
        target.searchParams.set(
            'processingDelayMs',
            String(session.profile.processingDelayMs),
        )
        target.searchParams.set(
            'maxQueueFrames',
            String(session.profile.maxQueueFrames),
        )
        let bridgeWs
        try {
            bridgeWs = new WebSocket(target, {
                headers: {
                    authorization: `Bearer ${bridgeToken}`,
                },
                handshakeTimeout: effectiveLimits.bridgeHandshakeTimeoutMs,
                perMessageDeflate: false,
                maxPayload: AUDIO_CONTRACT.bytesPerFrame + 4096,
            })
        } catch {
            failSession(session, 'bridge_constructor_failed', {
                nativeCloseCode: CLOSE_CODES.upstreamFailure,
                bridgeCloseCode: CLOSE_CODES.upstreamFailure,
            })
            return
        }
        session.bridgeWs = bridgeWs

        bridgeWs.on('open', () => {
            if (session.finished) return
            session.metrics.websocketConnections += 1
        })
        bridgeWs.on('message', (data, isBinary) => {
            if (session.finished) return
            if (isBinary) {
                if (!session.bridgeReady) {
                    session.metrics.rejectedFrames += 1
                    failSession(session, 'bridge_audio_before_ready')
                    return
                }
                acceptBridgeBinary(session, data)
                return
            }
            acceptBridgeControl(session, data)
        })
        bridgeWs.on('close', code => {
            if (session.finished) return
            session.bridgeCloseCode = code
            if (code === 4401) {
                session.metrics.bridgeAuthFailures += 1
                failSession(session, 'bridge_auth_failure', {
                    nativeCloseCode: CLOSE_CODES.unauthorized,
                    bridgeCloseCode: CLOSE_CODES.unauthorized,
                })
                return
            }
            if (code === CLOSE_CODES.backpressure) {
                session.metrics.rejectedFrames += 1
                session.metrics.backpressureFailures += 1
                failSession(session, 'bridge_queue_backpressure', {
                    nativeCloseCode: CLOSE_CODES.backpressure,
                    bridgeCloseCode: CLOSE_CODES.backpressure,
                })
                return
            }
            if (code === CLOSE_CODES.resourceLimit) {
                session.metrics.rejectedFrames += 1
                failSession(session, 'bridge_resource_limit', {
                    nativeCloseCode: CLOSE_CODES.resourceLimit,
                    bridgeCloseCode: CLOSE_CODES.resourceLimit,
                })
                return
            }
            if (session.requestedBridgeDisconnect) {
                completeSession(session, 'bridge_disconnect_requested')
                return
            }
            failSession(session, 'bridge_disconnect', {
                nativeCloseCode: CLOSE_CODES.upstreamFailure,
                bridgeCloseCode: CLOSE_CODES.upstreamFailure,
            })
        })
        bridgeWs.on('error', () => {
            // Close owns cleanup. Request headers and tokens are intentionally
            // never logged or included in snapshots.
        })
    }

    const createSession = (channelUuid, profile, nativeWs) => {
        const now = Date.now()
        const assignedProfile = Object.freeze({
            ...profile,
            channelUuid,
        })
        return {
            channelUuid,
            sessionId: channelUuid,
            profile: assignedProfile,
            nativeWs,
            bridgeWs: null,
            state: 'connecting',
            reason: null,
            startedAt: new Date(now).toISOString(),
            startedEpochMs: now,
            endedAt: null,
            durationMs: 0,
            bridgeReady: false,
            bridgeMetadataSent: false,
            requestedBridgeDisconnect: false,
            nativeCloseCode: null,
            bridgeCloseCode: null,
            finished: false,
            nextNativeSequence: 0,
            expectedReturnSequence: 0,
            carry: Buffer.alloc(0),
            queue: [],
            pendingSentAt: new Map(),
            metrics: createMetrics(),
            sourceSignal: createSignalAccumulator(assignedProfile.sourceHz),
            returnSignal: createSignalAccumulator(assignedProfile.returnHz),
            runtimeTimer: null,
            handshakeTimer: null,
            idleTimer: null,
            cleanupResult: 'pending',
        }
    }

    const handleNativeConnection = (nativeWs, profile, channelUuid) => {
        const session = createSession(channelUuid, profile, nativeWs)
        activeSessions.set(channelUuid, session)
        runtimeCounters.sessionsAssigned += 1

        session.runtimeTimer = setTimeout(() => {
            failSession(session, 'session_runtime_limit', {
                nativeCloseCode: CLOSE_CODES.resourceLimit,
                bridgeCloseCode: CLOSE_CODES.resourceLimit,
            })
        }, effectiveLimits.maxSessionRuntimeMs)
        session.runtimeTimer.unref()
        session.handshakeTimer = setTimeout(() => {
            failSession(session, 'bridge_handshake_timeout', {
                nativeCloseCode: CLOSE_CODES.upstreamFailure,
                bridgeCloseCode: CLOSE_CODES.upstreamFailure,
            })
        }, effectiveLimits.bridgeHandshakeTimeoutMs)
        session.handshakeTimer.unref()

        nativeWs.on('message', (data, isBinary) => {
            if (session.finished) return
            if (isBinary) {
                acceptNativeBinary(session, data)
                return
            }
            acceptNativeControl(session, data)
        })
        nativeWs.on('close', code => {
            if (session.finished) return
            session.nativeCloseCode = code
            if ([1002, 1003, 1007, 1009].includes(code)) {
                session.metrics.rejectedFrames += 1
                failSession(session, 'native_protocol_error', {
                    nativeCloseCode: code,
                    bridgeCloseCode: CLOSE_CODES.badRequest,
                })
                return
            }
            sendBridgeControl(session, {
                type: 'graceful_end',
                sessionId: session.sessionId,
            })
            completeSession(session, 'native_disconnect')
        })
        nativeWs.on('error', error => {
            if (
                session.finished
                || !String(error?.code ?? '').startsWith('WS_ERR_')
            ) {
                return
            }
            session.metrics.rejectedFrames += 1
            failSession(session, 'native_protocol_error', {
                nativeCloseCode: CLOSE_CODES.badRequest,
                bridgeCloseCode: CLOSE_CODES.badRequest,
            })
        })

        const rawAudioSent = sendNativeControl(session, {
            type: 'rawAudio',
            data: { sampleRate: AUDIO_CONTRACT.sampleRate },
        })
        if (!rawAudioSent) {
            failSession(session, 'native_mode_declaration_failed', {
                nativeCloseCode: CLOSE_CODES.upstreamFailure,
                bridgeCloseCode: CLOSE_CODES.upstreamFailure,
            })
            return
        }

        if (onSessionAssigned) {
            try {
                onSessionAssigned(Object.freeze({
                    channelUuid,
                    session: Object.freeze(publicSessionSnapshot(session)),
                    profile: Object.freeze(
                        callbackProfileSnapshot(session.profile),
                    ),
                }))
            } catch {
                failSession(session, 'session_assignment_callback_failed')
                return
            }
        }
        if (session.finished) return
        openBridgeConnection(session)
    }

    const rejectUpgrade = (socket, statusCode, reason) => {
        runtimeCounters.upgradesRejected += 1
        const statusText = statusCode === 400
            ? 'Bad Request'
            : statusCode === 403
                ? 'Forbidden'
                : statusCode === 409
                    ? 'Conflict'
                    : 'Service Unavailable'
        try {
            socket.end(
                `HTTP/1.1 ${statusCode} ${statusText}\r\n`
                + 'Connection: close\r\n'
                + 'Content-Length: 0\r\n\r\n',
            )
        } catch {
            try { socket.destroy() } catch {}
        }
        return reason
    }

    httpServer.on('upgrade', (req, socket, head) => {
        if (stopping) {
            rejectUpgrade(socket, 503, 'runtime_stopping')
            return
        }
        let parsed
        try {
            parsed = new URL(req.url, `http://${nativeHost}`)
        } catch {
            runtimeCounters.invalidPaths += 1
            rejectUpgrade(socket, 400, 'invalid_path')
            return
        }
        const pathMatch = /^\/([0-9a-f-]+)$/.exec(parsed.pathname)
        const channelUuid = pathMatch?.[1] ?? ''
        if (
            parsed.search
            || !isCanonicalUuid(channelUuid)
            || parsed.pathname !== `/${channelUuid}`
        ) {
            runtimeCounters.invalidPaths += 1
            rejectUpgrade(socket, 400, 'invalid_path')
            return
        }
        if (req.headers['x-yoko-dev-probe'] !== REQUIRED_PROBE_HEADER) {
            runtimeCounters.authFailures += 1
            rejectUpgrade(socket, 403, 'probe_header_invalid')
            return
        }
        if (
            activeSessions.has(channelUuid)
            || completedSessions.has(channelUuid)
        ) {
            runtimeCounters.duplicateConnections += 1
            rejectUpgrade(socket, 409, 'duplicate_session')
            return
        }
        if (pendingProfiles.length === 0) {
            runtimeCounters.unarmedConnections += 1
            rejectUpgrade(socket, 403, 'slot_not_armed')
            return
        }
        if (activeSessions.size >= effectiveLimits.maxSessions) {
            runtimeCounters.capacityRejections += 1
            rejectUpgrade(socket, 503, 'max_sessions')
            return
        }

        const profile = pendingProfiles[0]
        try {
            wss.handleUpgrade(req, socket, head, nativeWs => {
                const claimedProfile = pendingProfiles.shift()
                if (claimedProfile !== profile) {
                    closeSocketBounded(
                        nativeWs,
                        CLOSE_CODES.conflict,
                        'slot_claim_conflict',
                    )
                    return
                }
                handleNativeConnection(nativeWs, profile, channelUuid)
            })
        } catch {
            runtimeCounters.upgradesRejected += 1
            try { socket.destroy() } catch {}
        }
    })

    const arm = input => {
        if (stopping) throw new Error('native_adapter_stopping')
        const profile = normalizeProfile(input, effectiveLimits)
        if (pendingProfiles.length >= effectiveLimits.maxArmedSlots) {
            throw new Error('native_adapter_arm_limit')
        }
        pendingProfiles.push(profile)
        return {
            ...safeProfileSnapshot(profile),
            queue_position: pendingProfiles.length,
        }
    }

    const listen = () => new Promise((resolve, reject) => {
        if (stopping) {
            reject(new Error('native_adapter_stopping'))
            return
        }
        if (listening) {
            const address = httpServer.address()
            resolve({
                host: nativeHost,
                port: address.port,
                startedAt: runtimeStartedAt,
            })
            return
        }
        httpServer.once('error', reject)
        httpServer.listen(nativePort, nativeHost, () => {
            httpServer.off('error', reject)
            listening = true
            const address = httpServer.address()
            resolve({
                host: nativeHost,
                port: address.port,
                startedAt: runtimeStartedAt,
            })
        })
    })

    const disconnectBridge = channelUuid => {
        if (!isCanonicalUuid(channelUuid)) return false
        const session = activeSessions.get(channelUuid)
        if (!session || session.finished || !session.bridgeWs) return false
        session.requestedBridgeDisconnect = true
        try {
            session.bridgeWs.terminate()
        } catch {
            completeSession(session, 'bridge_disconnect_requested')
        }
        return true
    }

    const emergencyStop = channelUuid => {
        if (!isCanonicalUuid(channelUuid)) return false
        const session = activeSessions.get(channelUuid)
        if (!session || session.finished) return false
        sendBridgeControl(session, {
            type: 'emergency_stop',
            sessionId: channelUuid,
        })
        completeSession(session, 'emergency_stop', {
            nativeCloseCode: CLOSE_CODES.emergencyStop,
            bridgeCloseCode: 1000,
        })
        return true
    }

    const snapshot = () => ({
        active: [...activeSessions.values()].map(publicSessionSnapshot),
        completed: [...completedSessions.values()].map(publicSessionSnapshot),
        pendingSlots: pendingProfiles.length,
        runtime: {
            host: nativeHost,
            port: httpServer.address()?.port ?? null,
            bridge_host: parsedBridgeUrl.hostname,
            bridge_port: Number(
                parsedBridgeUrl.port
                || (parsedBridgeUrl.protocol === 'wss:' ? 443 : 80),
            ),
            bridge_path: parsedBridgeUrl.pathname,
            started_at: runtimeStartedAt,
            stopped_at: stoppedAt,
            stopping,
            active_sessions: activeSessions.size,
            completed_sessions: completedSessions.size,
            rss_bytes: process.memoryUsage().rss,
            ...runtimeCounters,
        },
        limits: { ...effectiveLimits },
        audio: { ...AUDIO_CONTRACT },
    })

    const stop = () => {
        if (stopPromise) return stopPromise
        stopPromise = (async () => {
            stopping = true
            pendingProfiles.length = 0
            for (const session of [...activeSessions.values()]) {
                completeSession(session, 'runtime_shutdown')
            }
            for (const client of wss.clients) {
                try { client.terminate() } catch {}
            }
            await new Promise(resolve => wss.close(() => resolve()))
            if (httpServer.listening) {
                await new Promise(resolve => httpServer.close(() => resolve()))
            }
            listening = false
            stoppedAt = new Date().toISOString()
        })()
        return stopPromise
    }

    return {
        activeSessions,
        arm,
        completedSessions,
        disconnectBridge,
        effectiveLimits,
        emergencyStop,
        httpServer,
        listen,
        snapshot,
        stop,
        wss,
    }
}

module.exports = {
    CLOSE_CODES,
    DEFAULT_LIMITS,
    REQUIRED_PROBE_HEADER,
    createFreeSwitchMediaAdapter,
    isCanonicalUuid,
    isPrivateIpv4,
    latencySummary,
    publicSessionSnapshot,
}
