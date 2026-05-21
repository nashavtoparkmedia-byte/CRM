// Analyse a raw WAV (FS record_session output, mono or stereo) for
// choppy-playback diagnostics. Walks samples and reports peak, energy,
// and silence runs > 30ms. Same algorithm as analyze_call_audio.js but
// against an arbitrary local file (skips MinIO / presigned URL fetch).
//
// Usage: node scripts/analyze_local_wav.js <path-to-wav> [label] [tStartMs] [tEndMs]
//
// tStartMs/tEndMs limit analysis to one time window (useful to isolate a
// single bot utterance within a longer recording — silence runs INSIDE a
// continuous TTS utterance are the choppy-bot-voice signature).
const fs = require('fs')
const path = require('path')

function analyzeWav(wavPath, label, tStartMs = null, tEndMs = null) {
    const buf = fs.readFileSync(wavPath)
    if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
        console.error(`not a RIFF/WAVE file: ${wavPath}`)
        return
    }
    const ch = buf.readUInt16LE(22)
    const sr = buf.readUInt32LE(24)
    const bits = buf.readUInt16LE(34)

    // Find the "data" chunk — record_session writes a 44-byte header most of
    // the time but some FS builds insert a fact chunk for non-PCM formats.
    let dataOffset = -1
    let dataLen = -1
    for (let i = 12; i < buf.length - 8; i++) {
        if (buf.toString('ascii', i, i + 4) === 'data') {
            dataOffset = i + 8
            dataLen = buf.readUInt32LE(i + 4)
            break
        }
    }
    if (dataOffset < 0) { console.error(`no data chunk in ${wavPath}`); return }

    const data = buf.slice(dataOffset, dataOffset + dataLen)
    const sampleBytes = (bits / 8) * ch
    const samples = data.length / sampleBytes
    const durMs = (samples / sr) * 1000

    // For STEREO recordings, scan EACH channel separately — record_session
    // with RECORD_STEREO=true puts caller on one channel and callee (=our
    // TTS) on the other. The choppy-bot-voice analysis only cares about the
    // OUTBOUND channel (what FS rendered for the user). The recordings from
    // an originate-then-park layout in 9999 don't have a manager leg, so
    // both channels may carry the same audio — we report each separately
    // and let the eye pick the answer.
    const SILENCE = 200
    const startSample = tStartMs == null ? 0 : Math.floor((tStartMs / 1000) * sr)
    const endSample = tEndMs == null ? samples : Math.min(samples, Math.floor((tEndMs / 1000) * sr))
    const startByte = startSample * sampleBytes
    const endByte = endSample * sampleBytes
    function scanChannel(chanIdx) {
        let peak = 0
        let energy = 0
        let scanned = 0
        const runs = []
        let currentRun = 0
        for (let i = startByte + chanIdx * (bits / 8); i < endByte; i += sampleBytes) {
            scanned++
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
        return { peak, energy, scanned, runs, longGaps }
    }

    console.log(`\n=== ${label} ===`)
    console.log(`file: ${wavPath}`)
    console.log(`format: ${sr} Hz, ${ch}ch, ${bits}-bit, dur ${durMs.toFixed(0)} ms, samples=${samples}`)
    if (tStartMs != null || tEndMs != null) {
        console.log(`range: ${tStartMs ?? 0}–${tEndMs ?? durMs.toFixed(0)} ms (samples ${startSample}–${endSample})`)
    }

    for (let c = 0; c < ch; c++) {
        const r = scanChannel(c)
        const tagShort = ch === 2 ? (c === 0 ? 'L' : 'R') : 'mono'
        // We care about MICRO-gaps (30–200 ms) for the choppy-bot signature
        // — natural TTS pauses between phrases are 200–600 ms and shouldn't
        // be alarming on their own; runs of 30–150 ms INSIDE a continuous
        // utterance are the smoking gun for FS playback underruns.
        const micro = r.runs.filter(x => x >= 30 && x < 200).sort((a, b) => b - a)
        console.log(`  [${tagShort}] peak=${r.peak} (max=32767), avg|s|=${(r.energy / r.scanned).toFixed(0)}`)
        console.log(`  [${tagShort}] silence-runs total >30ms: ${r.runs.length}, >100ms: ${r.longGaps.length}`)
        console.log(`  [${tagShort}] MICRO-gaps 30–200ms: ${micro.length}; top:`, micro.slice(0, 12).map(x => x.toFixed(0)))
        console.log(`  [${tagShort}] top 10 all silence runs (ms):`, r.runs.slice(0, 10).map(x => x.toFixed(0)))
    }
}

function main() {
    const wavPath = process.argv[2]
    const label = process.argv[3] ?? path.basename(wavPath)
    const tStart = process.argv[4] != null ? Number(process.argv[4]) : null
    const tEnd = process.argv[5] != null ? Number(process.argv[5]) : null
    if (!wavPath) { console.error('usage: analyze_local_wav.js <path-to-wav> [label] [tStartMs] [tEndMs]'); process.exit(1) }
    if (!fs.existsSync(wavPath)) { console.error(`file not found: ${wavPath}`); process.exit(1) }
    analyzeWav(wavPath, label, tStart, tEnd)
}

main()
