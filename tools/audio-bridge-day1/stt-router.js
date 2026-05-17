/**
 * STT provider selector.
 *
 * Picks the right SpeechToText backend at bridge boot time:
 *   1. Yandex SpeechKit gRPC streaming   — if YANDEX_API_KEY is set (best UX)
 *   2. OpenAI Whisper batch              — if OPENAI_API_KEY is set (fallback)
 *   3. Disabled                          — neither key present, bridge runs
 *                                          in audio-only mode (Day-1 behaviour)
 *
 * The CallSession code talks to one tiny session interface, common to both:
 *   session.start() : Promise<void>
 *   session.send(pcmBuffer : Buffer) : void
 *   session.stop() : void
 * Plus event callbacks {onPartial, onFinal, onError} passed via constructor.
 */

// Lazy-require yandex-stt: its @yandex-cloud/nodejs-sdk dependency may not
// be installed on Day-1 boxes that only use Whisper fallback. We only pull
// it in when a Yandex API key is actually present at boot.
const { WhisperSttSession } = require('./whisper-stt')

const YANDEX_API_KEY = process.env.YANDEX_API_KEY
const YANDEX_FOLDER_ID = process.env.YANDEX_FOLDER_ID
const OPENAI_API_KEY = process.env.OPENAI_API_KEY

let YandexSttSession = null
if (YANDEX_API_KEY) {
    try {
        YandexSttSession = require('./yandex-stt').YandexSttSession
    } catch (err) {
        console.error(`[stt-router] Yandex STT requested but SDK not installed: ${err.message}`)
        console.error('[stt-router] run: cd tools/audio-bridge-day1 && npm install @yandex-cloud/nodejs-sdk')
    }
}

function describeProvider() {
    if (YandexSttSession) return 'yandex'
    if (OPENAI_API_KEY) return 'whisper'
    return 'disabled'
}

/**
 * Create a new STT session for one call. Returns null if no provider is
 * available — callers should treat that as "audio-only mode" and skip
 * STT/LLM/TTS entirely (Day-1 behaviour).
 */
function createSttSession({ onPartial, onFinal, onError } = {}) {
    if (YandexSttSession) {
        return new YandexSttSession({
            apiKey: YANDEX_API_KEY,
            folderId: YANDEX_FOLDER_ID,
            onPartial, onFinal, onError,
        })
    }
    if (OPENAI_API_KEY) {
        return new WhisperSttSession({ onPartial, onFinal, onError })
    }
    return null
}

module.exports = {
    createSttSession,
    describeProvider,
    enabled: !!YandexSttSession || !!OPENAI_API_KEY,
}
