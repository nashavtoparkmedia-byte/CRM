// Three-step probe to localise the choppy-bot signature in the TTS path:
//
//   1. POST /v1/audio/speech with response_format=wav → save as ORIGINAL
//      (OpenAI returns a complete 24 kHz mono PCM WAV; this is the raw
//      synth output, no bridge-side processing).
//   2. POST /v1/audio/speech with response_format=pcm → run the bridge's
//      FIR resampler (current production path) → save as POST-FIR.
//   3. Take ORIGINAL (24 kHz) and decimate with ffmpeg's swr instead of
//      our FIR → save as POST-FFMPEG.
//
// Analyse all three with the existing analyze_local_wav.js. If ORIGINAL is
// clean and POST-FIR has micro-gaps → our FIR introduces the choppy. If
// ORIGINAL is choppy already → OpenAI's TTS itself is the culprit and we
// need to switch model / voice or a different provider. POST-FFMPEG is the
// drop-in alternative we'd ship if FIR is to blame.
//
// Run with: node scripts/probe_tts_pipeline.js "<russian phrase>"
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') })
require('../init-proxy').initProxy()

const fs = require('fs')
const path = require('path')
const os = require('os')
const { spawn } = require('child_process')
const crm = require('../crm-client')
const runtime = require('../runtime-config')
const ttsModule = require('../openai-tts')

const FFMPEG = path.join(__dirname, '..', '..', '..', 'gravity-mvp', 'node_modules', '@ffmpeg-installer', 'win32-x64', 'ffmpeg.exe')

function wavHeader(pcmByteLen, sampleRate, channels = 1, bits = 16) {
    const buf = Buffer.alloc(44)
    buf.write('RIFF', 0)
    buf.writeUInt32LE(36 + pcmByteLen, 4)
    buf.write('WAVE', 8)
    buf.write('fmt ', 12)
    buf.writeUInt32LE(16, 16)
    buf.writeUInt16LE(1, 20)
    buf.writeUInt16LE(channels, 22)
    buf.writeUInt32LE(sampleRate, 24)
    buf.writeUInt32LE(sampleRate * channels * bits / 8, 28)
    buf.writeUInt16LE(channels * bits / 8, 32)
    buf.writeUInt16LE(bits, 34)
    buf.write('data', 36)
    buf.writeUInt32LE(pcmByteLen, 40)
    return buf
}

function ffmpegResample(inputPath, outputPath, targetSr) {
    return new Promise((resolve, reject) => {
        // -ar targetSr drives sample rate; -acodec pcm_s16le forces 16-bit
        // little-endian linear PCM, matching the bridge / FS contract.
        const ff = spawn(FFMPEG, ['-y', '-i', inputPath, '-acodec', 'pcm_s16le', '-ar', String(targetSr), '-ac', '1', outputPath])
        let stderr = ''
        ff.stderr.on('data', d => { stderr += d.toString() })
        ff.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}: ${stderr.slice(-300)}`)))
    })
}

async function fetchTts(format, text, apiKey) {
    const res = await fetch('https://api.openai.com/v1/audio/speech', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
            model: process.env.OPENAI_TTS_MODEL ?? 'tts-1',
            voice: process.env.OPENAI_TTS_VOICE ?? 'alloy',
            input: text,
            response_format: format,
        }),
    })
    if (!res.ok) {
        const err = await res.text().catch(() => '')
        throw new Error(`OpenAI ${format} HTTP ${res.status}: ${err.slice(0, 200)}`)
    }
    return Buffer.from(await res.arrayBuffer())
}

async function main() {
    const phrase = process.argv[2] ?? 'Здравствуйте, меня зовут ассистент, я хотел бы задать вам пару коротких вопросов про вашу работу водителем такси.'
    const keys = await crm.fetchKeys()
    runtime.setKeys(keys)
    const apiKey = runtime.getOpenAiKey()
    if (!apiKey) throw new Error('OpenAI key not configured')

    const outDir = path.join(os.tmpdir(), `tts-probe-${Date.now()}`)
    fs.mkdirSync(outDir, { recursive: true })
    console.log(`probe outputs → ${outDir}`)
    console.log(`phrase: ${phrase}`)

    // 1. ORIGINAL — OpenAI's own WAV (24 kHz).
    console.log('\n[1] fetching response_format=wav (24 kHz reference)...')
    const wavBuf = await fetchTts('wav', phrase, apiKey)
    const wavPath = path.join(outDir, '1-openai-original-24k.wav')
    fs.writeFileSync(wavPath, wavBuf)
    console.log(`    saved ${wavBuf.length} bytes`)

    // 2. POST-FIR — same pipeline the bridge runs on every call.
    console.log('\n[2] fetching response_format=pcm + running bridge openai-tts.synthesize() FIR...')
    const firWav = await ttsModule.synthesize(phrase)
    const firPath = path.join(outDir, '2-bridge-fir-8k.wav')
    fs.writeFileSync(firPath, firWav)
    console.log(`    saved ${firWav.length} bytes`)

    // 3. POST-FFMPEG — ORIGINAL run through swr (ffmpeg's high-quality
    // resampler) to 8 kHz. If this is clean and POST-FIR is choppy, we
    // can swap implementations.
    console.log('\n[3] resampling ORIGINAL → 8 kHz via ffmpeg swr...')
    const ffPath = path.join(outDir, '3-ffmpeg-swr-8k.wav')
    await ffmpegResample(wavPath, ffPath, 8000)
    const ffStat = fs.statSync(ffPath)
    console.log(`    saved ${ffStat.size} bytes`)

    // 4. Bonus: ORIGINAL run through ffmpeg → 24 kHz pass-through (to
    // verify ffmpeg itself doesn't introduce artifacts on a no-op).
    console.log('\n[4] sanity: ORIGINAL → 24 kHz pass-through via ffmpeg...')
    const passPath = path.join(outDir, '4-ffmpeg-passthrough-24k.wav')
    await ffmpegResample(wavPath, passPath, 24000)
    const passStat = fs.statSync(passPath)
    console.log(`    saved ${passStat.size} bytes`)

    console.log('\nAll four files written. Analyse with:')
    console.log(`  node scripts/analyze_local_wav.js "${wavPath}" ORIGINAL-24k`)
    console.log(`  node scripts/analyze_local_wav.js "${firPath}" BRIDGE-FIR-8k`)
    console.log(`  node scripts/analyze_local_wav.js "${ffPath}" FFMPEG-SWR-8k`)
    console.log(`  node scripts/analyze_local_wav.js "${passPath}" FFMPEG-PASSTHROUGH-24k`)
}

main().catch(e => { console.error('FATAL:', e); process.exit(1) })
