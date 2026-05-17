/**
 * TTS provider selector.
 *
 * Priority:
 *   1. Yandex SpeechKit (russian-native voice)  — YANDEX_API_KEY + FOLDER_ID
 *   2. OpenAI TTS (russian via alloy voice)     — OPENAI_API_KEY
 *   3. Disabled                                 — neither key, bridge falls
 *                                                 back to silence (no playback)
 *
 * Returns a complete WAV (header + PCM body) at 8 kHz mono — the format
 * that uuid_broadcast and the bridge's existing /play handler already
 * understand.
 */

const yandex = require('./yandex-tts')
const openai = require('./openai-tts')

function describeProvider() {
    if (yandex.enabled) return 'yandex'
    if (openai.enabled) return 'openai'
    return 'disabled'
}

async function synthesize(text) {
    if (yandex.enabled) return yandex.synthesize(text)
    if (openai.enabled) return openai.synthesize(text)
    throw new Error('No TTS provider configured (set YANDEX_API_KEY or OPENAI_API_KEY)')
}

module.exports = {
    synthesize,
    describeProvider,
    enabled: yandex.enabled || openai.enabled,
}
