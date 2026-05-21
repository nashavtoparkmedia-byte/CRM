// Diagnostic: compare what bridge GENERATED (clean TTS WAV) vs what FS
// actually PLAYED on the channel (record_session MP3 from MinIO). If both
// are clean, the choppy issue lives between FS-egress and the user's ear
// (RTP / Megafon trunk / handset codec). If the MP3 is choppy but the
// generated WAV is clean, it's FS playback inside the call.
//
// Usage: node scripts/analyze_call_audio.js <callId>
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') })
require('../init-proxy').initProxy()

const fs = require('fs')
const path = require('path')
const os = require('os')
const { spawn } = require('child_process')
const { Agent } = require('undici')
const crm = require('../crm-client')
const runtime = require('../runtime-config')
const tts = require('../openai-tts')

const FFMPEG = path.join(__dirname, '..', '..', '..', 'gravity-mvp', 'node_modules', '@ffmpeg-installer', 'win32-x64', 'ffmpeg.exe')

function ffmpegToPCM(input, output) {
    return new Promise((resolve, reject) => {
        const ff = spawn(FFMPEG, ['-y', '-i', input, '-acodec', 'pcm_s16le', '-ar', '8000', '-ac', '1', output])
        let stderr = ''
        ff.stderr.on('data', d => { stderr += d.toString() })
        ff.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}: ${stderr.slice(-200)}`)))
    })
}

function analyzeWav(wavPath, label) {
    const buf = fs.readFileSync(wavPath)
    const ch = buf.readUInt16LE(22)
    const sr = buf.readUInt32LE(24)
    const bits = buf.readUInt16LE(34)
    const data = buf.slice(44)
    const sampleBytes = (bits / 8) * ch
    const samples = data.length / sampleBytes
    const durMs = (samples / sr) * 1000

    // Walk samples (channel 0 only for stereo). Track:
    // - max amplitude
    // - long runs of "near-silence" (|s| < 200 = ~ -44 dBFS)
    // - total energy
    let peak = 0
    let energy = 0
    const SILENCE = 200
    const runs = []  // runs of consecutive silent samples, in ms
    let currentRun = 0
    for (let i = 0; i < data.length; i += sampleBytes) {
        const s = data.readInt16LE(i)
        const abs = Math.abs(s)
        if (abs > peak) peak = abs
        energy += abs
        if (abs < SILENCE) {
            currentRun++
        } else {
            if (currentRun > 0) {
                const runMs = (currentRun / sr) * 1000
                if (runMs > 30) runs.push(runMs)
                currentRun = 0
            }
        }
    }
    if (currentRun > 0) {
        const runMs = (currentRun / sr) * 1000
        if (runMs > 30) runs.push(runMs)
    }

    runs.sort((a, b) => b - a)
    const longGaps = runs.filter(r => r > 100)
    console.log(`\n=== ${label} ===`)
    console.log(`format: ${sr} Hz, ${ch}ch, ${bits}-bit, dur ${durMs.toFixed(0)} ms`)
    console.log(`peak: ${peak} (max=32767), avg|s|: ${(energy / samples).toFixed(0)}`)
    console.log(`silence-runs > 100 ms: ${longGaps.length}`)
    console.log(`top 5 longest silence runs (ms):`, runs.slice(0, 5).map(r => r.toFixed(0)))
}

async function main() {
    const callId = process.argv[2]
    if (!callId) { console.error('usage: analyze_call_audio.js <callId>'); process.exit(1) }

    // 1) Generate a fresh TTS via the CURRENT bridge module → reveals what
    //    bridge produces before FS gets it.
    const keys = await crm.fetchKeys()
    runtime.setKeys(keys)
    const phrase = 'Здравствуйте, проверка качества голоса, один два три четыре пять.'
    console.log('Synthesizing test phrase via bridge openai-tts module...')
    const ttsBytes = await tts.synthesize(phrase)
    const ttsPath = path.join(os.tmpdir(), `analyze-${callId}-tts.wav`)
    fs.writeFileSync(ttsPath, ttsBytes)
    analyzeWav(ttsPath, `BRIDGE-GENERATED TTS (${phrase.length} chars)`)

    // 2) Pull the actual call recording from MinIO → reveals what FS
    //    captured on the channel during playback.
    const directAgent = new Agent()
    const credsRes = await fetch(`http://127.0.0.1:3002/api/calls/${encodeURIComponent(callId)}/recording`, { dispatcher: directAgent })
    const { url } = await credsRes.json()
    if (!url) { console.error('no presigned URL for', callId); process.exit(1) }

    const mp3Path = path.join(os.tmpdir(), `analyze-${callId}.mp3`)
    const wavPath = path.join(os.tmpdir(), `analyze-${callId}-rec.wav`)
    const r = await fetch(url, { dispatcher: directAgent })
    fs.writeFileSync(mp3Path, Buffer.from(await r.arrayBuffer()))
    await ffmpegToPCM(mp3Path, wavPath)
    analyzeWav(wavPath, `CALL RECORDING (record_session MP3)`)
}

main().catch(e => { console.error('FATAL:', e); process.exit(1) })
