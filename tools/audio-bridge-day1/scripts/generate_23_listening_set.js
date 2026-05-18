// Issue #23 listening set — generates 3 WAV files of the SAME Russian phrase
// for side-by-side perceptual comparison. The user listens to A/B/C locally
// on Windows to localise where the choppy quality lives.
//
//   A — OpenAI TTS raw 24 kHz, current voice/model (alloy / from env).
//       This is what the bridge receives BEFORE any local processing.
//       If A already sounds choppy → blame is on OpenAI's Russian rendering.
//
//   B — Same A run through the bridge's ffmpeg swr resampler to 8 kHz mono.
//       This is exactly the WAV the bridge writes to /dev/shm and hands to
//       FreeSWITCH. If B sounds significantly worse than A → blame is on
//       our resample stage. If B sounds same as A → our resample is fine.
//
//   C — OpenAI TTS raw 24 kHz with a DIFFERENT voice (default: nova).
//       Control sample to test the hypothesis "OpenAI alloy specifically is
//       bad on Russian". If C sounds noticeably cleaner → voice swap fixes
//       the perceived issue without leaving OpenAI. If C is equally bad →
//       it's the model / language combo, not the voice.
//
// Run with: node scripts/generate_23_listening_set.js [phrase]
//
// Output: writes 3 WAVs to D:\Github\CRM\.claude\diag-23\<timestamp>\ and
// prints absolute Windows paths so the user can open them directly in
// Media Player / VLC.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') })
require('../init-proxy').initProxy()

const path = require('path')
const fs = require('fs')
const { spawn } = require('child_process')
const crm = require('../crm-client')
const runtime = require('../runtime-config')

// Match the same ffmpeg path the bridge uses in openai-tts.js so the
// listening B-file is bit-for-bit what the live bridge would produce.
const FFMPEG_BIN = process.env.FFMPEG_BIN
    ?? path.join(__dirname, '..', '..', '..', 'gravity-mvp', 'node_modules', '@ffmpeg-installer', 'win32-x64', 'ffmpeg.exe')

const MODEL = process.env.OPENAI_TTS_MODEL ?? 'tts-1'
const VOICE_PRIMARY = process.env.OPENAI_TTS_VOICE ?? 'alloy'
const VOICE_CONTROL = process.env.OPENAI_TTS_VOICE_CONTROL ?? 'nova'

const DEFAULT_PHRASE = 'Здравствуйте, меня зовут ассистент, я хотел бы задать вам пару коротких вопросов про вашу работу водителем такси.'

function ffmpegResample(inputWavPath, outputWavPath, targetSr) {
    return new Promise((resolve, reject) => {
        const ff = spawn(FFMPEG_BIN, [
            '-y', '-loglevel', 'error',
            '-i', inputWavPath,
            '-acodec', 'pcm_s16le',
            '-ar', String(targetSr),
            '-ac', '1',
            outputWavPath,
        ])
        let stderr = ''
        ff.stderr.on('data', d => { stderr += d.toString() })
        ff.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}: ${stderr.slice(-300)}`)))
    })
}

async function fetchOpenAiWav({ text, voice, model, apiKey }) {
    const res = await fetch('https://api.openai.com/v1/audio/speech', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
            model,
            voice,
            input: text,
            response_format: 'wav',
        }),
    })
    if (!res.ok) {
        const err = await res.text().catch(() => '')
        throw new Error(`OpenAI (${voice}/${model}) HTTP ${res.status}: ${err.slice(0, 200)}`)
    }
    return Buffer.from(await res.arrayBuffer())
}

async function main() {
    const phrase = process.argv[2] ?? DEFAULT_PHRASE
    const keys = await crm.fetchKeys()
    runtime.setKeys(keys)
    const apiKey = runtime.getOpenAiKey()
    if (!apiKey) throw new Error('OpenAI API key not configured')

    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const outDir = path.join('D:\\Github\\CRM\\.claude', 'diag-23', ts)
    fs.mkdirSync(outDir, { recursive: true })

    console.log(`\nphrase: ${phrase}`)
    console.log(`out dir: ${outDir}\n`)

    // A — primary voice/model, raw OpenAI WAV at 24 kHz
    console.log(`[A] fetching ${VOICE_PRIMARY}/${MODEL} raw 24 kHz...`)
    const wavA = await fetchOpenAiWav({ text: phrase, voice: VOICE_PRIMARY, model: MODEL, apiKey })
    const pathA = path.join(outDir, `A-${VOICE_PRIMARY}-${MODEL}-raw-24k.wav`)
    fs.writeFileSync(pathA, wavA)
    console.log(`    → ${pathA} (${wavA.length} bytes)`)

    // B — same A through bridge's ffmpeg swr → 8 kHz (what FS receives)
    console.log(`[B] resampling A → 8 kHz via ffmpeg swr (bridge output)...`)
    const pathB = path.join(outDir, `B-${VOICE_PRIMARY}-${MODEL}-bridge-ffmpeg-8k.wav`)
    await ffmpegResample(pathA, pathB, 8000)
    console.log(`    → ${pathB} (${fs.statSync(pathB).size} bytes)`)

    // C — control voice, raw OpenAI WAV at 24 kHz
    console.log(`[C] fetching ${VOICE_CONTROL}/${MODEL} raw 24 kHz (control voice)...`)
    const wavC = await fetchOpenAiWav({ text: phrase, voice: VOICE_CONTROL, model: MODEL, apiKey })
    const pathC = path.join(outDir, `C-${VOICE_CONTROL}-${MODEL}-raw-24k.wav`)
    fs.writeFileSync(pathC, wavC)
    console.log(`    → ${pathC} (${wavC.length} bytes)`)

    console.log(`\n${'='.repeat(60)}`)
    console.log(`Listen to each file in order. Compare to memory of how the`)
    console.log(`bot sounded over the phone.`)
    console.log(`${'='.repeat(60)}\n`)
    console.log(`A — raw OpenAI from primary voice (${VOICE_PRIMARY}/${MODEL}):`)
    console.log(`    ${pathA}`)
    console.log(`B — what bridge writes for FS (${VOICE_PRIMARY}/${MODEL} → 8k):`)
    console.log(`    ${pathB}`)
    console.log(`C — same phrase, different voice (${VOICE_CONTROL}/${MODEL}):`)
    console.log(`    ${pathC}\n`)
}

main().catch(e => { console.error('FATAL:', e); process.exit(1) })
