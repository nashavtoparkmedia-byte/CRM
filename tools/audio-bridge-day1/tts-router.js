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

// Operator-level forced provider. Mirrors AI_CALL_STT_PROVIDER on the STT
// side. Set to 'openai' to skip Yandex TTS while we're still in the
// echo-fix phase (keeps the pipeline on the same provider the prior live
// calls used, for apples-to-apples comparison). Auto-mode kicks in by
// default when this env var is empty.
function forcedProvider() {
    return (process.env.AI_CALL_TTS_PROVIDER ?? '').toLowerCase()
}

function yandexEnabledEffective() {
    const f = forcedProvider()
    if (f === 'openai' || f === 'whisper') return false
    if (f === 'yandex') return yandex.enabled()
    return yandex.enabled()
}

function openaiEnabledEffective() {
    const f = forcedProvider()
    if (f === 'yandex') return false
    return openai.enabled()
}

function describeProvider() {
    if (yandexEnabledEffective()) return 'yandex'
    if (openaiEnabledEffective()) return 'openai'
    return 'disabled'
}

async function synthesize(text) {
    if (yandexEnabledEffective()) return yandex.synthesize(text)
    if (openaiEnabledEffective()) return openai.synthesize(text)
    throw new Error('No TTS provider configured (save Yandex or OpenAI key in the settings UI)')
}

module.exports = {
    synthesize,
    describeProvider,
    enabled: () => yandex.enabled() || openai.enabled(),
}
