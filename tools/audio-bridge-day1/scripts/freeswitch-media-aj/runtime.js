'use strict'

const crypto = require('node:crypto')
const readline = require('node:readline')

const {
    AUDIO_CONTRACT,
    crc32,
} = require('../dev-loopback/protocol')
const {
    createDevLoopbackRuntime,
    publicSessionSnapshot,
} = require('../dev-loopback/server')
const {
    createFreeSwitchMediaAdapter,
} = require('./native-adapter')

const MAX_RUNTIME_MS = 120000
const MAX_RSS_BYTES = 192 * 1024 * 1024
const RETURN_AMPLITUDE = 9000
const ADAPTER_LIMITS = Object.freeze({
    maxSessions: 2,
    maxArmedSlots: 2,
    maxFramesPerSession: 512,
    maxQueueFrames: 8,
    maxNativeMessageBytes: AUDIO_CONTRACT.bytesPerFrame * 8,
    maxBridgeBufferedBytes:
        8 * (AUDIO_CONTRACT.bytesPerFrame + 28),
    maxNativeBufferedBytes: AUDIO_CONTRACT.bytesPerFrame * 8,
    maxSessionRuntimeMs: 10000,
    bridgeHandshakeTimeoutMs: 750,
    idleTimeoutMs: 1750,
})

function writeEvent(type, payload = {}) {
    process.stdout.write(`YOKO_AJ_RUNTIME ${JSON.stringify({ type, ...payload })}\n`)
}

function deterministicReturnFrame(sessionId, sequence, frequency) {
    const frame = Buffer.allocUnsafe(AUDIO_CONTRACT.bytesPerFrame)
    const phaseOffset = crc32(Buffer.from(sessionId, 'utf8')) % AUDIO_CONTRACT.sampleRate
    for (let sample = 0; sample < AUDIO_CONTRACT.samplesPerFrame; sample += 1) {
        const sampleIndex = (sequence * AUDIO_CONTRACT.samplesPerFrame) + sample + phaseOffset
        const value = Math.round(
            RETURN_AMPLITUDE
            * Math.sin((2 * Math.PI * frequency * sampleIndex) / AUDIO_CONTRACT.sampleRate),
        )
        frame.writeInt16LE(value, sample * AUDIO_CONTRACT.bytesPerSample)
    }
    return frame
}

function bridgeSnapshots(runtime) {
    return {
        active: [...runtime.activeSessions.values()].map(publicSessionSnapshot),
        completed: [...runtime.completedSessions.values()].map(publicSessionSnapshot),
    }
}

async function main() {
    const nativeHost = process.env.YOKO_AJ_NATIVE_HOST
    const nativePort = Number(process.env.YOKO_AJ_NATIVE_PORT || 8080)
    if (!nativeHost) throw new Error('YOKO_AJ_NATIVE_HOST is required')

    const bridgeToken = crypto.randomBytes(32).toString('hex')
    const profileBySession = new Map()
    const bridge = createDevLoopbackRuntime({
        host: '127.0.0.1',
        port: 0,
        token: bridgeToken,
        limits: {
            maxSessions: 2,
            maxTotalSessions: 16,
            maxRuntimeMs: MAX_RUNTIME_MS,
            maxSessionRuntimeMs: 10000,
            maxRssBytes: MAX_RSS_BYTES,
            maxFramesPerSession: 512,
            maxBytesPerSession: 512 * AUDIO_CONTRACT.bytesPerFrame,
            maxQueueFrames: 8,
            maxOutboundBufferedBytes: 8 * (AUDIO_CONTRACT.bytesPerFrame + 28),
            idleTimeoutMs: 1500,
            reconnectWindowMs: 250,
            metadataTimeoutMs: 500,
        },
        transformOutboundPayload(payload, context) {
            const profile = profileBySession.get(context.sessionId)
            if (!profile || profile.returnMode === 'identity') return payload
            const frequency = Number(profile.returnHz || 997)
            return deterministicReturnFrame(context.sessionId, context.sequence, frequency)
        },
    })
    const bridgeReady = await bridge.listen()

    const adapter = createFreeSwitchMediaAdapter({
        nativeHost,
        nativePort,
        bridgeUrl: `ws://127.0.0.1:${bridgeReady.port}/dev-audio`,
        bridgeToken,
        limits: ADAPTER_LIMITS,
        onSessionAssigned({ channelUuid, profile }) {
            profileBySession.set(channelUuid, Object.freeze({ ...profile }))
        },
    })
    const adapterReady = await adapter.listen()
    writeEvent('ready', {
        pid: process.pid,
        nativeHost: adapterReady.host,
        nativePort: adapterReady.port,
        bridgeHost: bridgeReady.host,
        bridgePort: bridgeReady.port,
        auth: {
            native: 'isolated-network + fixed capability header + one-time armed slot',
            bridge: 'process-local bearer',
        },
        rssBytes: process.memoryUsage().rss,
    })

    let stopPromise = null
    const stop = reason => {
        if (stopPromise) return stopPromise
        stopPromise = (async () => {
            await adapter.stop()
            await bridge.stop()
            profileBySession.clear()
            writeEvent('stopped', {
                reason,
                rssBytes: process.memoryUsage().rss,
                activeAdapterSessions: adapter.activeSessions?.size ?? 0,
                activeBridgeSessions: bridge.activeSessions.size,
            })
        })()
        return stopPromise
    }

    const reply = (id, ok, payload = {}) => {
        writeEvent('response', { id, ok, ...payload })
    }
    const lines = readline.createInterface({
        input: process.stdin,
        crlfDelay: Infinity,
    })
    lines.on('line', line => {
        void (async () => {
            let command
            try {
                command = JSON.parse(line)
            } catch {
                writeEvent('command_rejected', { code: 'invalid_json' })
                return
            }
            const id = String(command.id || '')
            try {
                if (command.action === 'arm') {
                    const armed = adapter.arm(command.profile || {})
                    reply(id, true, { armed })
                    return
                }
                if (command.action === 'snapshot') {
                    reply(id, true, {
                        adapter: adapter.snapshot(),
                        bridge: bridgeSnapshots(bridge),
                        rssBytes: process.memoryUsage().rss,
                    })
                    return
                }
                if (command.action === 'disconnect_bridge') {
                    const result = await adapter.disconnectBridge(String(command.channelUuid || ''))
                    reply(id, true, { result })
                    return
                }
                if (command.action === 'emergency_stop') {
                    const result = await adapter.emergencyStop(String(command.channelUuid || ''))
                    reply(id, true, { result })
                    return
                }
                if (command.action === 'shutdown') {
                    await stop('command')
                    reply(id, true)
                    lines.close()
                    setImmediate(() => process.exit(0))
                    return
                }
                reply(id, false, { code: 'unsupported_action' })
            } catch (error) {
                reply(id, false, { code: error.code || 'command_failed', message: error.message })
            }
        })()
    })

    const runtimeTimer = setTimeout(() => {
        void stop('max_runtime').then(() => process.exit(1))
    }, MAX_RUNTIME_MS)
    runtimeTimer.unref()
    const memoryTimer = setInterval(() => {
        if (process.memoryUsage().rss > MAX_RSS_BYTES) {
            void stop('rss_limit').then(() => process.exit(1))
        }
    }, 100)
    memoryTimer.unref()

    const signalStop = signal => {
        void stop(signal).then(() => process.exit(0))
    }
    process.once('SIGINT', () => signalStop('SIGINT'))
    process.once('SIGTERM', () => signalStop('SIGTERM'))
    process.once('uncaughtException', error => {
        writeEvent('fatal', { code: 'uncaught_exception', message: error.message })
        void stop('uncaught_exception').finally(() => process.exit(1))
    })
    process.once('unhandledRejection', error => {
        writeEvent('fatal', {
            code: 'unhandled_rejection',
            message: error instanceof Error ? error.message : String(error),
        })
        void stop('unhandled_rejection').finally(() => process.exit(1))
    })
}

if (require.main === module) {
    main().catch(error => {
        writeEvent('fatal', { code: 'startup_failed', message: error.message })
        process.exitCode = 1
    })
}

module.exports = {
    ADAPTER_LIMITS,
    deterministicReturnFrame,
}
