// Yandex TTS readiness probe — Part 4 of the AI-call hardening pass.
//
// What it does:
//   1. Fetches API keys from CRM (/api/internal/ai-call-keys), confirms
//      YANDEX_API_KEY + YANDEX_FOLDER_ID are populated.
//   2. Verifies the tts-router would pick Yandex when forced.
//   3. Calls yandex-tts.synthesize() against a short Russian test phrase.
//   4. Parses the returned WAV header and asserts:
//        - RIFF / WAVE magic
//        - 8 kHz mono linear16 (FreeSWITCH `playback` reads this natively)
//        - duration in [1.5, 5.0] seconds for a 7-word phrase
//   5. Saves the WAV under /dev/shm/yandex-tts-probe-<ts>.wav for manual
//      listening if you want to.
//
// Does NOT flip the production pipeline. Bridge stays on
// AI_CALL_TTS_PROVIDER=openai per CLAUDE.md — readiness probe only.
//
// Usage: node scripts/probe_yandex_tts.js
// Exit 0 on success, 1 on any check failure.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') })
require('../init-proxy').initProxy()

const fs = require('fs')
const path = require('path')
const os = require('os')
const crm = require('../crm-client')
const runtime = require('../runtime-config')

const PHRASE = process.argv[2] ?? 'Здравствуйте, это тест AI-обзвона.'

function parseWavHeader(buf) {
    if (buf.length < 44) return null
    if (buf.toString('ascii', 0, 4) !== 'RIFF') return null
    if (buf.toString('ascii', 8, 12) !== 'WAVE') return null
    const audioFormat = buf.readUInt16LE(20)
    const channels = buf.readUInt16LE(22)
    const sampleRate = buf.readUInt32LE(24)
    const bitsPerSample = buf.readUInt16LE(34)
    const byteRate = buf.readUInt32LE(28)
    // Walk to data chunk (may be after a LIST/INFO chunk).
    let dataLen = 0, dataOff = -1
    for (let i = 12; i < buf.length - 8; i++) {
        if (buf.toString('ascii', i, i + 4) === 'data') {
            dataOff = i + 8
            dataLen = buf.readUInt32LE(i + 4)
            break
        }
    }
    const durationMs = byteRate ? (dataLen / byteRate) * 1000 : null
    return { audioFormat, channels, sampleRate, bitsPerSample, byteRate, dataLen, dataOff, durationMs }
}

async function main() {
    const report = { phrase: PHRASE, steps: [], pass: true }

    // Step 1 — keys via CRM
    let keys = null
    try {
        keys = await crm.fetchKeys()
    } catch (err) {
        report.steps.push({ step: 'fetchKeys', ok: false, error: err.message })
        report.pass = false
        return finalize(report)
    }
    const hasApiKey = !!keys.yandexApiKey
    const hasFolderId = !!keys.yandexFolderId
    report.steps.push({
        step: 'fetchKeys',
        ok: hasApiKey && hasFolderId,
        yandexApiKey: hasApiKey ? `${String(keys.yandexApiKey).slice(0, 6)}…(${String(keys.yandexApiKey).length} chars)` : null,
        yandexFolderId: hasFolderId ? keys.yandexFolderId : null,
        openaiKeyAlsoPresent: !!keys.openaiApiKey,
    })
    if (!hasApiKey || !hasFolderId) {
        report.pass = false
        return finalize(report)
    }
    runtime.setKeys(keys)

    // Step 2 — tts-router would pick Yandex if forced
    const prevForce = process.env.AI_CALL_TTS_PROVIDER
    process.env.AI_CALL_TTS_PROVIDER = 'yandex'
    let provider, enabled
    try {
        // Lazy-require AFTER env override so the router reads the new value.
        delete require.cache[require.resolve('../tts-router')]
        const ttsRouter = require('../tts-router')
        provider = ttsRouter.describeProvider()
        enabled = ttsRouter.enabled()
    } finally {
        if (prevForce === undefined) delete process.env.AI_CALL_TTS_PROVIDER
        else process.env.AI_CALL_TTS_PROVIDER = prevForce
    }
    report.steps.push({
        step: 'ttsRouter (forced yandex)',
        ok: provider === 'yandex' && enabled,
        describeProvider: provider,
        enabled,
    })
    if (!(provider === 'yandex' && enabled)) {
        report.pass = false
        return finalize(report)
    }

    // Step 3 — synthesize
    const yandexTts = require('../yandex-tts')
    let wavBytes
    const t0 = Date.now()
    try {
        wavBytes = await yandexTts.synthesize(PHRASE)
    } catch (err) {
        report.steps.push({ step: 'yandexTts.synthesize', ok: false, error: err.message })
        report.pass = false
        return finalize(report)
    }
    const synthMs = Date.now() - t0
    report.steps.push({
        step: 'yandexTts.synthesize',
        ok: Buffer.isBuffer(wavBytes) && wavBytes.length > 0,
        bytes: wavBytes.length,
        synthMs,
    })

    // Step 4 — WAV header / format
    const header = parseWavHeader(wavBytes)
    const formatOk = header
        && header.audioFormat === 1     // PCM
        && header.channels === 1
        && header.sampleRate === 8000
        && header.bitsPerSample === 16
        && (header.durationMs ?? 0) > 1500
        && (header.durationMs ?? 0) < 5000
    report.steps.push({
        step: 'WAV format check (8 kHz mono linear16 PCM, dur ≈ 2-4 s)',
        ok: !!formatOk,
        header,
    })
    if (!formatOk) {
        report.pass = false
        return finalize(report)
    }

    // Step 5 — persist for manual listening
    const tmpDir = process.env.YANDEX_TTS_PROBE_DIR ?? os.tmpdir()
    const outPath = path.join(tmpDir, `yandex-tts-probe-${Date.now()}.wav`)
    fs.writeFileSync(outPath, wavBytes)
    report.steps.push({ step: 'persisted', ok: true, path: outPath })

    return finalize(report)
}

function finalize(report) {
    console.log(JSON.stringify(report, null, 2))
    process.exit(report.pass ? 0 : 1)
}

main().catch(err => {
    console.error('FATAL:', err)
    process.exit(2)
})
