/**
 * OpenAI TTS fallback — POST https://api.openai.com/v1/audio/speech.
 *
 * Returns a WAV at 8 kHz mono linear16 — pre-resampled on this side so
 * the file matches the channel rate of the SIP trunk natively
 * (Megafon / PCMA / G.711a is 8 kHz). FreeSWITCH then plays the WAV
 * without any on-the-fly resampling, which empirically gave choppy /
 * dropped-syllable output through the trunk (issue #23).
 *
 * History of resampling attempts (all of which produced choppy bot voice
 * — issue #23) and why they failed:
 *
 *   1. «naive decimation» (drop 2 of 3 samples to go from 24 → 8 kHz).
 *      No anti-alias filter → severe aliasing on consonants.
 *
 *   2. Hand off the 24 kHz WAV to FS and let it resample. Sounded
 *      slightly better but still choppy live; either the FS resampler
 *      runs in a tight RTP loop without enough headroom, or DrvFs
 *      streaming-read latency between bridge writes (D:\…) and FS reads
 *      (/mnt/d/…) caused playback underruns.
 *
 *   3. 13-tap windowed-sinc FIR (cutoff 4 kHz, Hamming window) running
 *      in-process. Mathematically correct LPF but the short window has
 *      a wide transition band (3–6 kHz) and only ~30 dB of stop-band
 *      attenuation. Russian fricatives ('с', 'ш', 'з', 'щ') and
 *      affricates ('ц', 'ч') concentrate energy in 4–6 kHz; the FIR
 *      attenuated them so heavily that their amplitude dropped below
 *      the recognisable threshold and the listener perceived missing
 *      syllables. Measured: 11 micro-gaps (30–200 ms) in OpenAI's raw
 *      24 kHz output, exploded to 20 after the FIR — top gap dilated
 *      from 111 ms to 172 ms. See scripts/probe_tts_pipeline.js for the
 *      A/B reproduction.
 *
 *   4. ffmpeg's swr (current). High-quality polyphase resampler with a
 *      sharper transition band and >70 dB stop-band attenuation. Same
 *      probe shows only 5 extra micro-gaps over the raw 24 kHz baseline
 *      (vs +9 for the FIR), and the longest gap dilations are
 *      sub-perceptual. The ffmpeg subprocess spawn adds ~30 ms which is
 *      noise compared to OpenAI's 2–3 s synth time.
 *
 * Caveats for MVP:
 *   - OpenAI's TTS voices are primarily English; Russian works but with a
 *     noticeable accent. Good enough for verifying the pipeline; for real
 *     production we expect YANDEX_API_KEY to be set and pick yandex-tts.js
 *     via tts-router.
 */

const path = require('path')
const os = require('os')
const fs = require('fs')
const { spawn } = require('child_process')
const crypto = require('crypto')
const runtime = require('./runtime-config')

const OPENAI_TTS_MODEL = process.env.OPENAI_TTS_MODEL ?? 'tts-1'
const OPENAI_TTS_VOICE = process.env.OPENAI_TTS_VOICE ?? 'alloy'
const OPENAI_TTS_TIMEOUT_MS = Number(process.env.OPENAI_TTS_TIMEOUT_MS ?? 15000)

// ffmpeg path — reuse the binary already installed in gravity-mvp's
// node_modules (via @ffmpeg-installer/ffmpeg, pulled in by
// recordingProcessor.ts). Avoids a second 80 MB install in the bridge
// folder. Override via FFMPEG_BIN if the relative path is wrong on a
// non-default layout (e.g. monorepo hoist, or running the bridge alone).
const FFMPEG_BIN = process.env.FFMPEG_BIN
    ?? path.join(__dirname, '..', '..', 'gravity-mvp', 'node_modules', '@ffmpeg-installer', 'win32-x64', 'ffmpeg.exe')

const DST_RATE = 8000

/**
 * Resample one TTS payload from OpenAI's 24 kHz WAV to 8 kHz mono linear16
 * via ffmpeg's swr. Input is the WAV bytes returned by /v1/audio/speech
 * with response_format=wav; output is a self-contained 8 kHz mono PCM
 * WAV ready to hand to FreeSWITCH's uuid_broadcast.
 *
 * Files live in os.tmpdir() with random names so concurrent calls don't
 * collide. Cleaned up in a finally block; on Windows the deletes are
 * fire-and-forget (handles linger briefly after ffmpeg exits).
 */
function resampleViaFfmpeg(inputWav) {
    return new Promise((resolve, reject) => {
        const tag = crypto.randomBytes(6).toString('hex')
        const inPath = path.join(os.tmpdir(), `tts-${tag}-in.wav`)
        const outPath = path.join(os.tmpdir(), `tts-${tag}-out.wav`)
        fs.writeFile(inPath, inputWav, err => {
            if (err) return reject(err)
            // -y overwrite, -i input, -acodec pcm_s16le 16-bit linear,
            // -ar 8000 sample rate, -ac 1 mono. swr is ffmpeg's default
            // resampler and uses a polyphase filter that's much sharper
            // than what we can hand-roll in JS without significant CPU
            // cost. -loglevel error keeps stderr quiet unless something
            // breaks.
            const ff = spawn(FFMPEG_BIN, [
                '-y', '-loglevel', 'error',
                '-i', inPath,
                '-acodec', 'pcm_s16le',
                '-ar', String(DST_RATE),
                '-ac', '1',
                outPath,
            ])
            let stderr = ''
            ff.stderr.on('data', d => { stderr += d.toString() })
            ff.on('error', e => reject(e))
            ff.on('close', code => {
                if (code !== 0) {
                    fs.unlink(inPath, () => {})
                    fs.unlink(outPath, () => {})
                    return reject(new Error(`ffmpeg ${code}: ${stderr.slice(-300)}`))
                }
                fs.readFile(outPath, (rerr, buf) => {
                    fs.unlink(inPath, () => {})
                    fs.unlink(outPath, () => {})
                    if (rerr) return reject(rerr)
                    resolve(buf)
                })
            })
        })
    })
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
                // Ask for a complete WAV (24 kHz mono linear16, well-formed
                // RIFF header). Earlier we used response_format=pcm to dodge
                // a chunked-WAV header bug, but that path is gone — we
                // re-encode through ffmpeg anyway, which writes a clean
                // header. Asking for `wav` here lets ffmpeg auto-detect
                // the input format without hard-coding 24 kHz on our side.
                response_format: 'wav',
            }),
            signal: ac.signal,
        })
        if (!res.ok) {
            const err = await res.text().catch(() => '')
            throw new Error(`OpenAI TTS HTTP ${res.status}: ${err.slice(0, 200)}`)
        }
        const wav24 = Buffer.from(await res.arrayBuffer())
        return await resampleViaFfmpeg(wav24)
    } finally {
        clearTimeout(timer)
    }
}

module.exports = {
    synthesize,
    enabled: () => !!runtime.getOpenAiKey(),
}
