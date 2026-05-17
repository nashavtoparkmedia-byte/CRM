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
function createSttSession({ onPartial, onFinal, onError } = {}) {
    if (hasYandex()) {
        loadYandexSdkLazy()
        if (YandexSttSessionCtor) {
            return new YandexSttSessionCtor({
                apiKey: runtime.getYandexApiKey(),
                folderId: runtime.getYandexFolderId(),
                onPartial, onFinal, onError,
            })
        }
        // SDK missing — fall through to Whisper if available.
    }
    if (hasOpenAi()) {
        return new WhisperSttSession({ onPartial, onFinal, onError })
    }
    return null
}

module.exports = {
    createSttSession,
    describeProvider,
    enabled: () => hasYandex() || hasOpenAi(),
}
