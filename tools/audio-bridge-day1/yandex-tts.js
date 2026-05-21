/**
 * Yandex SpeechKit v3 TTS — REST synchronize endpoint.
 *
 * Pure Day-2 module: returns a 16-bit PCM 8 kHz mono WAV buffer for the
 * given Russian text. The bridge then writes it to the audio dir and
 * triggers FreeSWITCH `uuid_broadcast` to play it into the call leg.
 *
 * Endpoint chosen: POST https://tts.api.cloud.yandex.net/speech/v1/tts:synthesize
 * (REST, lpcm output). Streaming v3 gRPC exists too but adds zero benefit
 * for short ~5-sec phrases and a lot of code.
 *
 * Disabled when YANDEX_API_KEY is not set.
 */

const runtime = require('./runtime-config')

const YANDEX_TTS_VOICE = process.env.YANDEX_TTS_VOICE ?? 'jane'
const YANDEX_TTS_LANG = process.env.YANDEX_TTS_LANG ?? 'ru-RU'
const YANDEX_TTS_EMOTION = process.env.YANDEX_TTS_EMOTION ?? 'neutral'
const YANDEX_TTS_TIMEOUT_MS = Number(process.env.YANDEX_TTS_TIMEOUT_MS ?? 10000)

function wavHeader(pcmByteLen, sampleRate = 8000) {
    const buf = Buffer.alloc(44)
    buf.write('RIFF', 0)
    buf.writeUInt32LE(36 + pcmByteLen, 4)
    buf.write('WAVE', 8)
    buf.write('fmt ', 12)
    buf.writeUInt32LE(16, 16)
    buf.writeUInt16LE(1, 20)
    buf.writeUInt16LE(1, 22)
    buf.writeUInt32LE(sampleRate, 24)
    buf.writeUInt32LE(sampleRate * 2, 28)
    buf.writeUInt16LE(2, 32)
    buf.writeUInt16LE(16, 34)
    buf.write('data', 36)
    buf.writeUInt32LE(pcmByteLen, 40)
    return buf
}

/**
 * Synthesize `text` and return a complete WAV (header + PCM body) buffer
 * sampled at 8 kHz mono — the format mod_audio_fork and uuid_broadcast
 * understand natively.
 */
async function synthesize(text) {
    const apiKey = runtime.getYandexApiKey()
    const folderId = runtime.getYandexFolderId()
    if (!apiKey) throw new Error('Yandex API key is not configured')
    if (!folderId) throw new Error('Yandex Folder ID is required for SpeechKit TTS')

    const params = new URLSearchParams({
        text,
        lang: YANDEX_TTS_LANG,
        voice: YANDEX_TTS_VOICE,
        emotion: YANDEX_TTS_EMOTION,
        format: 'lpcm',
        sampleRateHertz: '8000',
        folderId,
    })

    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), YANDEX_TTS_TIMEOUT_MS)
    try {
        const res = await fetch('https://tts.api.cloud.yandex.net/speech/v1/tts:synthesize', {
            method: 'POST',
            headers: {
                Authorization: `Api-Key ${apiKey}`,
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: params,
            signal: ac.signal,
        })
        if (!res.ok) {
            const err = await res.text().catch(() => '')
            throw new Error(`Yandex TTS HTTP ${res.status}: ${err.slice(0, 200)}`)
        }
        const pcm = Buffer.from(await res.arrayBuffer())
        return Buffer.concat([wavHeader(pcm.length), pcm])
    } finally {
        clearTimeout(timer)
    }
}

module.exports = {
    synthesize,
    enabled: () => !!runtime.getYandexApiKey() && !!runtime.getYandexFolderId(),
}
