// Byte-for-byte sample diff between two WAV files.
//
// My earlier silence-run comparator missed sub-30ms artefacts. This script
// directly walks the linear-16 PCM payloads of two same-format WAVs and
// reports:
//   - sample count match
//   - exact byte-identity
//   - if different: where they diverge, peak abs-difference, and a sliding
//     window summary so we can see whether the divergence is constant
//     (consistent codec-or-filter bias) or burst-like (timing dropouts)
//
// Usage: node scripts/diff_wav_samples.js <ref.wav> <test.wav>

const fs = require('fs')

function readWav(p) {
    const buf = fs.readFileSync(p)
    if (buf.toString('ascii', 0, 4) !== 'RIFF') throw new Error(`${p} not RIFF`)
    if (buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error(`${p} not WAVE`)
    const ch = buf.readUInt16LE(22)
    const sr = buf.readUInt32LE(24)
    const bits = buf.readUInt16LE(34)
    // Walk chunks until we hit "data"
    let off = 12
    while (off < buf.length - 8) {
        const id = buf.toString('ascii', off, off + 4)
        const sz = buf.readUInt32LE(off + 4)
        if (id === 'data') {
            return {
                sr, ch, bits,
                samples: sz / (ch * bits / 8),
                pcm: buf.slice(off + 8, off + 8 + sz),
            }
        }
        off += 8 + sz
    }
    throw new Error(`${p}: no data chunk`)
}

function main() {
    const refPath = process.argv[2]
    const testPath = process.argv[3]
    if (!refPath || !testPath) {
        console.error('usage: diff_wav_samples.js <ref.wav> <test.wav>')
        process.exit(1)
    }
    const ref = readWav(refPath)
    const test = readWav(testPath)
    console.log(`ref:  ${refPath}`)
    console.log(`      ${ref.sr} Hz / ${ref.ch} ch / ${ref.bits}-bit / ${ref.samples} samples (${(ref.samples / ref.sr * 1000).toFixed(0)} ms)`)
    console.log(`test: ${testPath}`)
    console.log(`      ${test.sr} Hz / ${test.ch} ch / ${test.bits}-bit / ${test.samples} samples (${(test.samples / test.sr * 1000).toFixed(0)} ms)`)
    if (ref.sr !== test.sr || ref.ch !== test.ch || ref.bits !== test.bits) {
        console.error('FORMAT MISMATCH — cannot compare raw samples')
        process.exit(2)
    }

    const bytesPerSample = ref.bits / 8

    // Find the first non-silent sample in each — record_session may insert
    // a few samples of leading silence between the ANSWER event and the
    // first audio frame from playback(). Without alignment, every sample
    // compares "different" purely from the offset, not from real corruption.
    const SILENCE_THRESHOLD = 100
    function firstNonSilent(pcm, samples) {
        for (let i = 0; i < samples; i++) {
            if (Math.abs(pcm.readInt16LE(i * bytesPerSample)) > SILENCE_THRESHOLD) return i
        }
        return 0
    }
    const refStart = firstNonSilent(ref.pcm, ref.samples)
    const testStart = firstNonSilent(test.pcm, test.samples)
    console.log(`ref first-audio sample:  ${refStart} (${(refStart / ref.sr * 1000).toFixed(1)} ms)`)
    console.log(`test first-audio sample: ${testStart} (${(testStart / test.sr * 1000).toFixed(1)} ms)`)
    console.log(`alignment offset:        ${testStart - refStart} samples`)
    console.log()

    const nSamples = Math.min(ref.samples - refStart, test.samples - testStart)
    let nDiff = 0
    let firstDiff = -1
    let maxAbsDiff = 0
    let sumAbsDiff = 0

    // Also bucket the diffs by 1-second windows to spot bursty corruption.
    const winMs = 100
    const winSamples = Math.floor(ref.sr * winMs / 1000)
    const windowDiffs = []

    for (let i = 0; i < nSamples; i++) {
        const a = ref.pcm.readInt16LE((refStart + i) * bytesPerSample)
        const b = test.pcm.readInt16LE((testStart + i) * bytesPerSample)
        const d = Math.abs(a - b)
        if (d > 0) {
            nDiff++
            if (firstDiff === -1) firstDiff = i
            if (d > maxAbsDiff) maxAbsDiff = d
            sumAbsDiff += d
            const wIdx = Math.floor(i / winSamples)
            windowDiffs[wIdx] = (windowDiffs[wIdx] ?? 0) + 1
        }
    }

    console.log()
    console.log(`compared samples:  ${nSamples}`)
    console.log(`differing samples: ${nDiff} (${(100 * nDiff / nSamples).toFixed(2)}%)`)
    console.log(`bit-identical:     ${nDiff === 0 ? 'YES' : 'NO'}`)
    if (nDiff > 0) {
        console.log(`first diff:        sample ${firstDiff} (${(firstDiff / ref.sr * 1000).toFixed(0)} ms in)`)
        console.log(`max abs diff:      ${maxAbsDiff}`)
        console.log(`mean abs diff:     ${(sumAbsDiff / nDiff).toFixed(1)}`)
        console.log()
        console.log(`per-${winMs}ms-window diff count (only windows with diffs):`)
        for (let w = 0; w < windowDiffs.length; w++) {
            const c = windowDiffs[w] ?? 0
            if (c === 0) continue
            const tMs = w * winMs
            const bar = '#'.repeat(Math.min(60, Math.round(60 * c / winSamples)))
            console.log(`  ${String(tMs).padStart(5)}-${String(tMs + winMs).padStart(5)} ms  ${String(c).padStart(4)} (${(100 * c / winSamples).toFixed(0)}%)  ${bar}`)
        }
    }
}

main()
