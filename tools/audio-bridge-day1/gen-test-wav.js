/**
 * Generates audio/test.wav — 3s, 8kHz mono 16-bit PCM, 440Hz tone → 880Hz tone.
 * Used as the playback source for uuid_broadcast in Day 1 audio roundtrip.
 */
const fs = require('fs')
const path = require('path')

const SR = 8000          // 8 kHz to match mod_audio_fork PCM rate
const DUR_SEC = 3
const N = SR * DUR_SEC

const buf = Buffer.alloc(44 + N * 2)
// WAV RIFF header
buf.write('RIFF', 0)
buf.writeUInt32LE(36 + N * 2, 4)
buf.write('WAVE', 8)
buf.write('fmt ', 12)
buf.writeUInt32LE(16, 16)         // fmt chunk size
buf.writeUInt16LE(1, 20)          // PCM format
buf.writeUInt16LE(1, 22)          // 1 channel (mono)
buf.writeUInt32LE(SR, 24)
buf.writeUInt32LE(SR * 2, 28)     // byte rate
buf.writeUInt16LE(2, 32)          // block align
buf.writeUInt16LE(16, 34)         // bits per sample
buf.write('data', 36)
buf.writeUInt32LE(N * 2, 40)

// Samples: 440Hz 1s → silence 0.5s → 880Hz 1s → silence 0.5s
for (let i = 0; i < N; i++) {
    const t = i / SR
    let v = 0
    if (t < 1)        v = Math.sin(2 * Math.PI * 440 * t) * 8000
    else if (t < 1.5) v = 0
    else if (t < 2.5) v = Math.sin(2 * Math.PI * 880 * t) * 8000
    buf.writeInt16LE(v | 0, 44 + i * 2)
}

const outDir = path.join(__dirname, 'audio')
fs.mkdirSync(outDir, { recursive: true })
const outPath = path.join(outDir, 'test.wav')
fs.writeFileSync(outPath, buf)
console.log(`wrote ${outPath} — ${DUR_SEC}s, ${SR}Hz mono 16-bit, 440Hz→880Hz`)
