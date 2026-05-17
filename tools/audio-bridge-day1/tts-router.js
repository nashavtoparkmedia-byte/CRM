/**
 * TTS provider selector.
 *
 * Priority (evaluated per call based on current runtime config):
 *   1. Yandex SpeechKit (russian-native)        — Yandex API key + Folder ID
 *   2. OpenAI TTS (russian via OpenAI voice)    — OpenAI API key
 *   3. Disabled                                 — neither, bridge stays silent
 *
 * Returns a complete WAV (header + PCM body) at 8 kHz mono — the format
 * that uuid_broadcast and the bridge's existing /play handler already
 * understand.
 */

const yandex = require('./yandex-tts')
const openai = require('./openai-tts')

function describeProvider() {
    if (yandex.enabled()) return 'yandex'
    if (openai.enabled()) return 'openai'
    return 'disabled'
}

async function synthesize(text) {
    if (yandex.enabled()) return yandex.synthesize(text)
    if (openai.enabled()) return openai.synthesize(text)
    throw new Error('No TTS provider configured (save Yandex or OpenAI key in the settings UI)')
}

module.exports = {
    synthesize,
    describeProvider,
    enabled: () => yandex.enabled() || openai.enabled(),
}
