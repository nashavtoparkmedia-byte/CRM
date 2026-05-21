/**
 * STT provider selector.
 *
 * Picks the SpeechToText backend per call, based on the *current* runtime
 * config (which can change between calls — admin saved a new key in the UI):
 *   1. Yandex SpeechKit gRPC streaming   — Yandex API key + Folder ID present
 *   2. OpenAI Whisper batch              — OpenAI key present (fallback)
 *   3. Disabled                          — neither, bridge runs audio-only
 *
 * The Yandex SDK is lazy-loaded once, the first time a Yandex-eligible
 * session is requested — that way Day-1 boxes that never set Yandex keys
 * never need `@yandex-cloud/nodejs-sdk` installed.
 *
 * Common per-session interface:
 *   session.start() : Promise<void>
 *   session.send(pcmBuffer : Buffer) : void
 *   session.stop() : void
 * Plus {onPartial, onFinal, onError} callbacks in the constructor.
 */

const runtime = require('./runtime-config')
const { WhisperSttSession } = require('./whisper-stt')

let YandexSttSessionCtor = null
let yandexLoadAttempted = false

function loadYandexSdkLazy() {
    if (yandexLoadAttempted) return
    yandexLoadAttempted = true
    try {
        YandexSttSessionCtor = require('./yandex-stt').YandexSttSession
    } catch (err) {
        console.error(`[stt-router] Yandex STT requested but SDK not installed: ${err.message}`)
        console.error('[stt-router] run: cd tools/audio-bridge-day1 && npm install @yandex-cloud/nodejs-sdk')
    }
}

function hasYandex() {
    // Allow operator to force a specific STT provider regardless of which
    // keys are present. Useful when Yandex keys are configured in admin UI
    // but the Yandex SDK in this build is broken (e.g.
    // `this.stream.on is not a function` from a streaming API mismatch),
    // and we want to stay on the Whisper fallback while debugging.
    const force = (process.env.AI_CALL_STT_PROVIDER ?? '').toLowerCase()
    if (force === 'whisper' || force === 'openai') return false
    if (force === 'yandex') return !!runtime.getYandexApiKey()
    return !!runtime.getYandexApiKey()
}

function hasOpenAi() {
    return !!runtime.getOpenAiKey()
}

function describeProvider() {
    if (hasYandex()) return 'yandex'
    if (hasOpenAi()) return 'whisper'
    return 'disabled'
}

/**
 * Create a new STT session for one call. Returns null if no provider is
 * currently configured — callers should treat that as "audio-only mode"
 * (PCM is recorded/logged, the dialog skipped).
 */
function createSttSession({ onPartial, onFinal, onError, callUuid } = {}) {
    if (hasYandex()) {
        loadYandexSdkLazy()
        if (YandexSttSessionCtor) {
            return new YandexSttSessionCtor({
                apiKey: runtime.getYandexApiKey(),
                folderId: runtime.getYandexFolderId(),
                callUuid,
                onPartial, onFinal, onError,
            })
        }
        // SDK missing — fall through to Whisper if available.
    }
    if (hasOpenAi()) {
        // Whisper doesn't have a streaming-inactivity surface yet (it's
        // batch over fetch with its own 15 s timeout), so callUuid is
        // not propagated to it from this PR.
        return new WhisperSttSession({ onPartial, onFinal, onError })
    }
    return null
}

module.exports = {
    createSttSession,
    describeProvider,
    enabled: () => hasYandex() || hasOpenAi(),
}
