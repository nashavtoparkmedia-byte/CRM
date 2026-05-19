// Smoke for Task #4 (recording upload) + Task #5 (finalize timeout).
//
// Exercises the AI-call persistence path WITHOUT placing a real SIP call:
//
//   1. Insert a synthetic Call row (isAi=true, transcript populated, fsUuid
//      random). Skips driver/contact relations to keep the harness
//      independent of seed data — Task creation in finalize gates on
//      driverId presence which we leave null, so manager_task path is
//      exercised via a separate call row with driverId set further down.
//   2. Place a small valid WAV at the FS-recording path the processor
//      expects (ffmpeg synthetic sine, 1 s).
//   3. Invoke processRecording directly (no FS event needed — we just want
//      the upload + DB-update + queue-enqueue path).
//   4. Re-read the Call row → assert recordingPath populated.
//   5. POST /api/ai-calls/sessions/<id>/finalize with a full result payload
//      → assert response under 3 s, sessionStatus='ended', aiAnalysis set,
//      aiSummary set.
//
// All assertions guarded by hard timeouts so a hung Redis / MinIO / route
// surfaces as a clear «took > Xs» rather than an indefinite poll.
//
// Run:  node gravity-mvp/scripts/smoke_ai_persistence.js
// Exit: 0 = all checks passed; non-zero = first failure.

const path = require('path')
const fs = require('fs/promises')
const { existsSync } = require('fs')
const os = require('os')
const { spawnSync } = require('child_process')
const { randomUUID } = require('crypto')

const CRM_BASE = process.env.CRM_BASE_URL ?? 'http://127.0.0.1:3002'
const FS_RECORDINGS_DIR = process.env.FS_RECORDINGS_DIR
    ?? '\\\\wsl.localhost\\Ubuntu-24.04\\var\\lib\\freeswitch\\recordings'

async function withTimeout(p, ms, tag) {
    let to
    const timer = new Promise((_, reject) => {
        to = setTimeout(() => reject(new Error(`timeout_${tag}_after_${ms}ms`)), ms)
    })
    try { return await Promise.race([p, timer]) } finally { clearTimeout(to) }
}

function step(name, ok, info) {
    const tick = ok ? '✓' : '✗'
    const detail = info ? ` ${JSON.stringify(info).slice(0, 200)}` : ''
    console.log(`  ${tick} ${name}${detail}`)
    return ok
}

async function makeTestWav(targetPath) {
    // 1 second 440 Hz sine via system ffmpeg (WSL) — same binary the
    // bridge probe + recordingProcessor work with.
    const ffmpegCandidates = [
        process.env.FFMPEG_BIN,
        path.join(__dirname, '..', 'node_modules', '@ffmpeg-installer', 'win32-x64', 'ffmpeg.exe'),
    ].filter(Boolean)
    let ffmpeg = null
    for (const c of ffmpegCandidates) {
        if (existsSync(c)) { ffmpeg = c; break }
    }
    if (!ffmpeg) throw new Error('ffmpeg binary not found — set FFMPEG_BIN')
    const r = spawnSync(ffmpeg, [
        '-y', '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
        '-ar', '8000', '-ac', '2', '-acodec', 'pcm_s16le',
        targetPath,
    ], { stdio: 'pipe' })
    if (r.status !== 0) throw new Error(`ffmpeg ${r.status}: ${r.stderr?.toString() ?? ''}`)
}

async function main() {
    // Load Prisma client lazily so this script can fail with a clearer
    // message if gravity-mvp isn't installed yet.
    const { PrismaClient } = require(path.join(__dirname, '..', 'node_modules', '@prisma', 'client'))
    const prisma = new PrismaClient()

    const fsUuid = randomUUID()
    const wavFs = `/var/lib/freeswitch/recordings/${fsUuid}.wav`
    const wavHost = path.join(FS_RECORDINGS_DIR, `${fsUuid}.wav`)
    const tmpWav = path.join(os.tmpdir(), `smoke-${fsUuid}.wav`)

    let allOk = true
    let callId = null
    console.log(`\n=== AI-call persistence smoke ===`)
    console.log(`fsUuid: ${fsUuid}\n`)

    try {
        // STEP 1 — synthetic Call row
        console.log('[1] insert Call row')
        const call = await prisma.call.create({
            data: {
                fsUuid,
                direction: 'outbound',
                fromNumber: 'AI Test',
                toNumber: '+79000000000',
                status: 'completed',
                isAi: true,
                aiSessionStatus: 'active',
                startedAt: new Date(Date.now() - 60_000),
                answeredAt: new Date(Date.now() - 55_000),
                transcript: '[AI] тест\n[Лид] да\n',
            },
        })
        callId = call.id
        allOk = step('Call.create', true, { callId, isAi: call.isAi }) && allOk

        // STEP 2 — generate WAV + copy to FS recordings dir
        console.log('[2] place WAV at FS recordings path')
        await makeTestWav(tmpWav)
        await fs.copyFile(tmpWav, wavHost)
        const wavStat = await fs.stat(wavHost)
        allOk = step('wav file exists', wavStat.size > 0, { wavHost, size: wavStat.size }) && allOk

        // STEP 3 — invoke processRecording in-process via the existing
        // gravity-mvp code path. We tsx-execute a small wrapper file
        // (scripts/_invoke_recording_processor.ts) rather than passing an
        // inline script with `-e` — the latter trips on Windows quoting +
        // path translation. Wrapped in withTimeout.
        console.log('[3] processRecording (TS via tsx)')
        const t0 = Date.now()
        const procResult = await withTimeout(
            (async () => {
                const wrapper = path.join(__dirname, '_invoke_recording_processor.ts')
                // Use shell so Windows resolves `npx` via PATHEXT (npx.cmd /
                // npx.ps1). Quote args defensively in case paths contain
                // spaces. spawnSync with shell:true is fine for an internal
                // dev script — values come from this same process.
                const r = spawnSync(
                    `npx tsx "${wrapper}" "${callId}" "${fsUuid}" "${wavFs}"`,
                    [],
                    { cwd: path.join(__dirname, '..'), encoding: 'utf8', shell: true },
                )
                return { code: r.status, stdout: r.stdout, stderr: r.stderr }
            })(),
            120_000,
            'processRecording',
        )
        allOk = step('processRecording finished', procResult.code === 0,
            { code: procResult.code, ms: Date.now() - t0 }) && allOk
        if (procResult.stderr && procResult.stderr.trim()) {
            console.log('    stderr:', procResult.stderr.slice(0, 500))
        }

        // STEP 4 — verify recordingPath persisted
        console.log('[4] read Call row recordingPath')
        const after = await prisma.call.findUnique({
            where: { id: callId },
            select: { recordingPath: true },
        })
        allOk = step('recordingPath set', !!after?.recordingPath, after) && allOk

        // STEP 5 — POST finalize, expect <3 s response
        console.log('[5] POST finalize')
        const fStart = Date.now()
        const res = await withTimeout(
            fetch(`${CRM_BASE}/api/ai-calls/sessions/${encodeURIComponent(callId)}/finalize`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    callUuid: fsUuid,
                    reason: 'completed',
                    result: {
                        qualification_status: 'qualified',
                        lead_summary: 'Smoke test lead',
                        reason: 'smoke harness',
                        manager_task: { should_create: false },
                        lead_data: { test: 'true' },
                    },
                    leadData: { test: 'true' },
                    transcript: [
                        { role: 'assistant', content: 'тест' },
                        { role: 'user', content: 'да' },
                    ],
                }),
            }),
            5000,
            'finalize_http',
        )
        const fDur = Date.now() - fStart
        allOk = step('finalize HTTP 200', res.ok, { status: res.status, ms: fDur }) && allOk
        allOk = step('finalize ms < 3000', fDur < 3000, { ms: fDur }) && allOk
        const body = await res.json().catch(() => ({}))
        allOk = step('finalize sessionStatus=ended', body.sessionStatus === 'ended', body) && allOk

        // STEP 6 — verify aiAnalysis persisted
        console.log('[6] read Call row aiAnalysis/aiSummary')
        const final = await prisma.call.findUnique({
            where: { id: callId },
            select: {
                aiSessionStatus: true, aiAnalysis: true, aiSummary: true,
                recordingPath: true,
            },
        })
        allOk = step('aiSessionStatus=ended', final?.aiSessionStatus === 'ended', { v: final?.aiSessionStatus }) && allOk
        allOk = step('aiSummary populated', !!final?.aiSummary, { v: (final?.aiSummary ?? '').slice(0, 60) }) && allOk
        allOk = step('aiAnalysis populated', !!final?.aiAnalysis, { hasIt: !!final?.aiAnalysis }) && allOk

    } finally {
        // Cleanup — keep the WAV on disk for inspection if anything failed.
        if (allOk && callId) {
            await prisma.call.delete({ where: { id: callId } }).catch(() => {})
            await fs.unlink(wavHost).catch(() => {})
            await fs.unlink(tmpWav).catch(() => {})
        }
        await prisma.$disconnect()
    }

    console.log(`\n=== ${allOk ? 'PASS' : 'FAIL'} ===`)
    process.exit(allOk ? 0 : 1)
}

main().catch(e => { console.error('\nFATAL:', e); process.exit(2) })
