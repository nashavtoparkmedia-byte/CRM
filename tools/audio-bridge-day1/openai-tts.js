/**
 * OpenAI TTS fallback — POST https://api.openai.com/v1/audio/speech.
 *
 * Returns a PCM-encoded WAV at 8 kHz mono so it slots into the same
 * uuid_broadcast playback path as Yandex output (and as the static test.wav
 * that exists today).
 *
 * Caveats for MVP:
 *   - OpenAI's TTS voices are primarily English; Russian works but with a
 *     noticeable accent. Good enough for verifying the pipeline; for real
 *     production we expect YANDEX_API_KEY to be set and pick yandex-tts.js
 *     via tts-router.
 *   - We ask the API for `pcm` (16-bit, 24 kHz). Then downsample to 8 kHz
 *     by simple decimation (drop 2/3 of samples). Quality suffers but
 *     matches the bridge's 8 kHz pipeline — converting in 1 place beats
 *     adding a resampler dep.
 */

const runtime = require('./runtime-config')

const OPENAI_TTS_MODEL = process.env.OPENAI_TTS_MODEL ?? 'tts-1'
const OPENAI_TTS_VOICE = process.env.OPENAI_TTS_VOICE ?? 'alloy'
const OPENAI_TTS_TIMEOUT_MS = Number(process.env.OPENAI_TTS_TIMEOUT_MS ?? 15000)

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
 * Naive decimation: drop every 2nd and 3rd sample to convert 24 kHz to
 * 8 kHz (3:1 ratio). Produces noticeable aliasing on consonants, but the
 * call codec at 8 kHz already heavily band-limits speech, so it's fine
 * for an MVP. If audio quality becomes an issue, swap in a proper
 * low-pass + resampler.
 */
function downsample24To8(pcm24k) {
    const samples24 = pcm24k.length / 2
    const samples8 = Math.floor(samples24 / 3)
    const out = Buffer.alloc(samples8 * 2)
    for (let i = 0; i < samples8; i++) {
        const v = pcm24k.readInt16LE(i * 3 * 2)
        out.writeInt16LE(v, i * 2)
    }
    return out
}

async function synthesize(text) {
    const apiKey = runtime.getOpenAiKey()
    if (!apiKey) throw new Error('OpenAI API key is not configured')

    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), OPENAI_TTS_TIMEOUT_MS)
    try {
        const res = await fetch('https://api.openai.com/v1/audio/speech', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
                model: OPENAI_TTS_MODEL,
                voice: OPENAI_TTS_VOICE,
                input: text,
                response_format: 'pcm', // signed 16-bit, 24 kHz, mono
            }),
            signal: ac.signal,
        })
        if (!res.ok) {
            const err = await res.text().catch(() => '')
            throw new Error(`OpenAI TTS HTTP ${res.status}: ${err.slice(0, 200)}`)
        }
        const pcm24 = Buffer.from(await res.arrayBuffer())
        const pcm8 = downsample24To8(pcm24)
        return Buffer.concat([wavHeader(pcm8.length), pcm8])
    } finally {
        clearTimeout(timer)
    }
}

module.exports = {
    synthesize,
    enabled: () => !!runtime.getOpenAiKey(),
}
