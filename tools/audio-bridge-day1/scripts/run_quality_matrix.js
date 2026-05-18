// Issue #23 — automated config-matrix quality A/B run.
//
// For each FS configuration in CONFIGS:
//   1. Apply the config (load/unload mod_audio_fork, override channel vars)
//   2. Originate playback of REFERENCE_WAV to user/103
//   3. Wait for FS recording to stabilise (call end)
//   4. Wait for browser MCP-snippet to upload its capture to :3033
//   5. Score browser capture vs reference via PESQ
//   6. Collect results
//
// Output: a JSON table on stdout. Each row = config + scores.
//
// NB: this script does NOT inject the browser snippet — that must be
// pre-installed in the CRM tab via mcp__Claude_in_Chrome__javascript_tool.
// The snippet uploads each capture to /dev/shm/test-23/uploads/cnova-<config>-<ts>.wav.
// We probe that dir by mtime to pick up the latest file.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') })

const net = require('net')
const crypto = require('crypto')
const path = require('path')
const { execFileSync, spawnSync } = require('child_process')
const fs = require('fs')

const ESL_HOST = process.env.FS_ESL_HOST ?? '127.0.0.1'
const ESL_PORT = Number(process.env.FS_ESL_PORT ?? 8021)
const ESL_PASS = process.env.ESL_PASSWORD ?? 'ClueCon'

const REFERENCE = process.env.REFERENCE_WAV ?? '/dev/shm/test-23/C4-nova-24k-RAW.wav'
const REFERENCE_8K = process.env.REFERENCE_8K_WAV ?? '/dev/shm/test-23/C2-nova-8k-CLEAN.wav'

// FS configurations to A/B. Each is a list of channel vars + a "setup"
// callback that runs fs_cli commands before the test.
// NB: do NOT toggle mod_audio_fork load/unload inside the matrix — repeated
// load/unload of this module hangs / crashes FS 1.10. Set FS state once
// (mod_audio_fork unloaded, the empirically-best state per earlier tests)
// and run channel-var variations only.
//
// timerfd timer also dropped earlier — calls ended at ~4s instead of
// full ~8s, browser snippet caught no audio. Skipping that variant
// until we understand WHY (likely WSL2 timerfd vs FS scheduling).
const CONFIGS = [
    { name: 'soft-smallbuf', setup: [], vars: { playback_buffer_len: 8192 } },
    { name: 'soft-bigbuf', setup: [], vars: { playback_buffer_len: 131072 } },
    { name: 'soft-megabuf', setup: [], vars: { playback_buffer_len: 524288 } },
]

function eslApi(cmd, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
        const sock = net.connect(ESL_PORT, ESL_HOST)
        sock.setEncoding('utf8')
        let buf = '', stage = 'connecting'
        const timer = setTimeout(() => { sock.destroy(); reject(new Error(`esl timeout (${stage})`)) }, timeoutMs)
        sock.on('data', chunk => {
            buf += chunk
            if (stage === 'connecting' && buf.includes('Content-Type: auth/request')) {
                stage = 'auth'; buf = ''; sock.write(`auth ${ESL_PASS}\n\n`); return
            }
            if (stage === 'auth' && buf.includes('+OK accepted')) {
                stage = 'sending'; buf = ''; sock.write(`api ${cmd}\n\n`); return
            }
            if (stage === 'sending') {
                const i = buf.indexOf('Content-Type: api/response')
                if (i === -1) return
                const m = buf.substring(i).match(/Content-Length: (\d+)\r?\n\r?\n([\s\S]*)/)
                if (m && Buffer.byteLength(m[2], 'utf8') >= Number(m[1])) {
                    clearTimeout(timer); sock.removeAllListeners('data'); sock.end()
                    resolve(m[2].trim())
                }
            }
        })
        sock.on('error', e => { clearTimeout(timer); reject(e) })
    })
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

async function originatePlayback(wav, vars) {
    const uuid = crypto.randomUUID()
    const recPath = `/var/lib/freeswitch/recordings/${uuid}.wav`
    const allVars = {
        origination_uuid: uuid,
        origination_caller_id_name: "'AI Test 23'",
        rtp_secure_media: 'false',
        RECORD_STEREO: 'true',
        recording_file: recPath,
        execute_on_answer: `'record_session ${recPath}'`,
        sip_h_P_CRM_Outbound_Bridge: 'true',
        ...vars,
    }
    const varStr = Object.entries(allVars).map(([k, v]) => `${k}=${v}`).join(',')
    const cmd = `originate {${varStr}}user/103 &playback(${wav})`
    const reply = await eslApi(cmd, 30000)
    return { uuid, reply }
}

function callWslBash(cmd) {
    const r = spawnSync('wsl.exe', ['-d', 'Ubuntu-24.04', '-u', 'root', 'bash', '-c', cmd], { encoding: 'utf8' })
    return { stdout: r.stdout || '', stderr: r.stderr || '', status: r.status }
}

function waitForFsRecording(uuid, timeoutMs = 30000) {
    const p = `\\\\wsl.localhost\\Ubuntu-24.04\\var\\lib\\freeswitch\\recordings\\${uuid}.wav`
    const start = Date.now()
    let prev = 0, stable = 0
    while (Date.now() - start < timeoutMs) {
        const cur = fs.existsSync(p) ? fs.statSync(p).size : 0
        if (cur > 5000 && cur === prev) {
            stable++
            if (stable >= 2) return cur
        } else stable = 0
        prev = cur
        const wait = 1500; const t0 = Date.now(); while (Date.now() - t0 < wait) {}
    }
    return prev
}

function findLatestUpload() {
    // Browser snippet writes `capture-pcN-<ts>.wav`. Pick newest by mtime.
    const r = callWslBash('ls -t /dev/shm/test-23/uploads/capture-pc*.wav 2>/dev/null | head -1')
    return r.stdout.trim()
}

function scoreCapture(refWav, capWav) {
    const r = callWslBash(`bash /mnt/d/Github/CRM/tools/audio-bridge-day1/scripts/score_browser_capture.sh ${refWav} ${capWav} 2>/dev/null`)
    try { return JSON.parse(r.stdout) } catch { return { raw: r.stdout, stderr: r.stderr } }
}

async function main() {
    console.log(`reference (full):  ${REFERENCE}`)
    console.log(`reference (8k nb): ${REFERENCE_8K}`)

    const results = []
    for (const cfg of CONFIGS) {
        console.log(`\n--- config: ${cfg.name} ---`)
        // Apply setup
        for (const s of cfg.setup) {
            console.log(`  fs_cli ${s}`)
            try { await eslApi(s) } catch (e) { console.log(`  setup failed: ${e.message}`) }
        }
        // Wait for module state to settle
        await sleep(1500)

        // Originate
        const { uuid } = await originatePlayback(REFERENCE, cfg.vars)
        console.log(`  uuid=${uuid}`)

        // Wait for FS rec to stabilise (= call ended)
        const size = waitForFsRecording(uuid, 25000)
        console.log(`  FS rec size=${size}`)

        // Browser snippet finalises and POSTs ~1–2 s after track ends.
        // Wait until a NEW upload (newer than test start) appears, with
        // a generous 10 s ceiling. Falls through with no-upload if the
        // call dropped early before audio arrived in the browser.
        const testStartMs = Date.now() - 30_000  // generous backstop
        let cap = ''
        for (let i = 0; i < 10; i++) {
            await sleep(1000)
            cap = findLatestUpload()
            if (cap) {
                const stat = callWslBash(`stat -c %Y ${cap} 2>/dev/null`)
                const mtimeSec = parseInt(stat.stdout.trim(), 10) || 0
                if (mtimeSec * 1000 > testStartMs) break
            }
            cap = ''
        }
        if (!cap) {
            console.log(`  NO UPLOAD FOUND for ${cfg.name}`)
            results.push({ config: cfg.name, error: 'no upload' })
            continue
        }
        console.log(`  capture: ${cap}`)
        // Move it to a per-config name so the next iteration's `latest` is unambiguous
        const cfgPath = `/dev/shm/test-23/uploads/scored-${cfg.name}.wav`
        callWslBash(`mv -f ${cap} ${cfgPath}`)

        // Score against NB reference
        const score = scoreCapture(REFERENCE_8K, cfgPath)
        console.log(`  MOS=${score.pesq_mos_lqo?.toFixed(2)} SNR=${score.snr_db?.toFixed(1)}dB align=${score.alignment_offset_ms?.toFixed(0)}ms`)
        results.push({ config: cfg.name, ...score, capturePath: cfgPath })
    }

    console.log('\n=== SUMMARY ===')
    console.table(results.map(r => ({
        config: r.config,
        mos: r.pesq_mos_lqo?.toFixed(3),
        snr_db: r.snr_db?.toFixed(1),
        align_ms: r.alignment_offset_ms?.toFixed(0),
    })))
    console.log('\nfull report:')
    console.log(JSON.stringify(results, null, 2))
}

main().catch(e => { console.error('FATAL:', e); process.exit(1) })
