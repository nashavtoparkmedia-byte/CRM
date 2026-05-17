/**
 * OpenAI Whisper batch STT fallback.
 *
 * Unlike Yandex SpeechKit's streaming gRPC, OpenAI's audio/transcriptions is
 * a synchronous HTTP endpoint — you send a complete audio file, you get the
 * full transcript. To approximate "streaming" we buffer ~3 seconds of PCM
 * frames, flush as WAV, get back text, emit it as an `onFinal` event.
 *
 * Trade-offs:
 *   - No partial results during the chunk.
 *   - Higher latency than gRPC streaming (one round-trip per chunk).
 *   - But: works on a single shared OpenAI key, no extra account needed.
 *
 * This is the fallback path. If YANDEX_API_KEY is set, stt-router picks
 * yandex-stt.js instead.
 */

const runtime = require('./runtime-config')

const OPENAI_WHISPER_MODEL = process.env.OPENAI_WHISPER_MODEL ?? 'whisper-1'
const WHISPER_CHUNK_MS = Number(process.env.WHISPER_CHUNK_MS ?? 3000)
const WHISPER_LANG = process.env.WHISPER_LANG ?? 'ru'

// PCM: 8 kHz mono LINEAR16 (matches mod_audio_fork "mixed 8000" config) →
// 16000 bytes per second. We flush every WHISPER_CHUNK_MS milliseconds OR
// when ~1 second of silence is detected (TODO: VAD; for MVP we use simple
// time-based flushing).
const PCM_SAMPLE_RATE = 8000
const PCM_BYTES_PER_SEC = PCM_SAMPLE_RATE * 2
const PCM_BYTES_PER_CHUNK = Math.round((PCM_BYTES_PER_SEC * WHISPER_CHUNK_MS) / 1000)

/**
 * Build a 44-byte RIFF/WAVE header for a mono 16-bit PCM buffer.
 * Whisper accepts WAV directly, so wrapping the buffer once per flush
 * lets us avoid bringing in ffmpeg.
 */
function wavHeader(pcmByteLen, sampleRate = PCM_SAMPLE_RATE) {
    const buf = Buffer.alloc(44)
    buf.write('RIFF', 0)
    buf.writeUInt32LE(36 + pcmByteLen, 4)
    buf.write('WAVE', 8)
    buf.write('fmt ', 12)
    buf.writeUInt32LE(16, 16)             // subchunk1 size
    buf.writeUInt16LE(1, 20)              // PCM format
    buf.writeUInt16LE(1, 22)              // mono
    buf.writeUInt32LE(sampleRate, 24)
    buf.writeUInt32LE(sampleRate * 2, 28) // byte rate
    buf.writeUInt16LE(2, 32)              // block align
    buf.writeUInt16LE(16, 34)             // bits per sample
    buf.write('data', 36)
    buf.writeUInt32LE(pcmByteLen, 40)
    return buf
}

class WhisperSttSession {
    constructor({ onPartial, onFinal, onError } = {}) {
        this.onPartial = onPartial ?? (() => {})
        this.onFinal = onFinal ?? (() => {})
        this.onError = onError ?? (() => {})
        this.buffers = []
        this.bufferedBytes = 0
        this.stopped = false
        this.inFlight = false
        this.flushTimer = null
    }

    async start() {
        if (!runtime.getOpenAiKey()) throw new Error('OpenAI API key is not configured')
        this.stopped = false
        // Periodic flush — runs even with no audio (no-op on empty buffer).
        // We don't use silence detection in MVP; the timer is the cadence.
        this.flushTimer = setInterval(() => this._tryFlush(), WHISPER_CHUNK_MS)
    }

    send(pcmBuffer) {
        if (this.stopped) return
        this.buffers.push(pcmBuffer)
        this.bufferedBytes += pcmBuffer.length
        // Flush early once we have a full chunk worth of audio — keeps
        // latency at WHISPER_CHUNK_MS regardless of the timer cadence.
        if (this.bufferedBytes >= PCM_BYTES_PER_CHUNK) this._tryFlush()
    }

    stop() {
        this.stopped = true
        if (this.flushTimer) {
            clearInterval(this.flushTimer)
            this.flushTimer = null
        }
        // Flush whatever is left so we don't lose trailing audio.
        this._tryFlush()
    }

    async _tryFlush() {
        if (this.inFlight || this.bufferedBytes === 0) return
        const pcm = Buffer.concat(this.buffers, this.bufferedBytes)
        this.buffers = []
        this.bufferedBytes = 0
        this.inFlight = true
        try {
            const text = await this._transcribe(pcm)
            if (text && text.trim()) this.onFinal(text.trim())
        } catch (err) {
            this.onError(err)
        } finally {
            this.inFlight = false
        }
    }

    async _transcribe(pcmBuffer) {
        const wav = Buffer.concat([wavHeader(pcmBuffer.length), pcmBuffer])
        // OpenAI's transcriptions endpoint takes multipart/form-data with
        // a `file` field. We assemble the body by hand to avoid pulling
        // in form-data — keeps the bridge dependency-light.
        const boundary = `----whisper-${Date.now().toString(36)}`
        const head =
            `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="file"; filename="chunk.wav"\r\n` +
            `Content-Type: audio/wav\r\n\r\n`
        const tail =
            `\r\n--${boundary}\r\n` +
            `Content-Disposition: form-data; name="model"\r\n\r\n${OPENAI_WHISPER_MODEL}\r\n` +
            `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="language"\r\n\r\n${WHISPER_LANG}\r\n` +
            `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="response_format"\r\n\r\ntext\r\n` +
            `--${boundary}--\r\n`

        const body = Buffer.concat([Buffer.from(head, 'utf8'), wav, Buffer.from(tail, 'utf8')])

        const ac = new AbortController()
        const timer = setTimeout(() => ac.abort(), 15000)
        try {
            const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${runtime.getOpenAiKey()}`,
                    'Content-Type': `multipart/form-data; boundary=${boundary}`,
                    'Content-Length': body.length.toString(),
                },
                body,
                signal: ac.signal,
            })
            if (!res.ok) {
                const errBody = await res.text().catch(() => '')
                throw new Error(`Whisper HTTP ${res.status}: ${errBody.slice(0, 200)}`)
            }
            return await res.text()
        } finally {
            clearTimeout(timer)
        }
    }
}

module.exports = {
    WhisperSttSession,
    enabled: () => !!runtime.getOpenAiKey(),
}
