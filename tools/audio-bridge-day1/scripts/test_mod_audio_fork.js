// Issue #20 — minimal reproducible test for mod_audio_fork mix-type and
// pause/resume bugs.
//
// What it does:
//   1. Spawns a dedicated WS server on :3032 (separate from the bridge's
//      :3030 so we get clean per-test telemetry).
//   2. Originates a loopback call: `originate loopback/9998/default &park()`.
//      The 9998 extension answers + plays a brief tone_stream into the
//      channel (so there's audio for `mod_audio_fork` to actually fork).
//      Loopback means no SIP trunk, no minutes burned.
//   3. For each mix-type (mono / mixed / stereo) runs the API:
//        uuid_audio_fork <uuid> start ws://.../audio mono 8000 <bugname>
//      and observes: did WS connect? how many PCM frames in N seconds?
//      what was the FS api response?
//   4. With a working session, tests `pause` → frames stop? `resume` →
//      frames resume?
//   5. Tests `stop` then `start` again (the prior known-bad case where
//      resume after fake-pause left the call one-way).
//   6. Tears down the loopback call.
//
// Output: JSON report on stdout summarising each test.
//
// Usage: node scripts/test_mod_audio_fork.js
//
// Requires mod_audio_fork loaded, FS running, 9998 extension defined
// with answer + tone_stream + park.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') })

const net = require('net')
const crypto = require('crypto')
const { WebSocketServer } = require('ws')

const ESL_HOST = process.env.FS_ESL_HOST ?? '127.0.0.1'
const ESL_PORT = Number(process.env.FS_ESL_PORT ?? 8021)
const ESL_PASS = process.env.ESL_PASSWORD ?? 'ClueCon'
const WS_PORT = Number(process.env.TEST_WS_PORT ?? 3032)
// LAN IP that FS (WSL) uses to reach this script (Windows host). Same
// rule as bridge: WSL2 mirrored networking forwards 127.0.0.1 in WSL
// to the Windows host loopback, but the bridge config uses an explicit
// LAN IP as a fallback for NAT-mode WSL. Mirror that here.
const LAN_IP = process.env.BRIDGE_LAN_IP ?? '127.0.0.1'

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

// Per-test state: every test call gets a fresh meter that the WS handler
// updates as frames arrive.
class FrameMeter {
    constructor() {
        this.connectionsOpened = 0
        this.connectionsClosed = 0
        this.firstFrameMs = null
        this.lastFrameMs = null
        this.frameCount = 0
        this.byteCount = 0
        this.metadata = []
    }

    onOpen() { this.connectionsOpened++ }
    onClose() { this.connectionsClosed++ }
    onFrame(bytes) {
        const now = Date.now()
        if (!this.firstFrameMs) this.firstFrameMs = now
        this.lastFrameMs = now
        this.frameCount++
        this.byteCount += bytes
    }
    onMeta(text) { this.metadata.push(text) }

    snapshot() {
        const dur = this.firstFrameMs ? (this.lastFrameMs - this.firstFrameMs) / 1000 : 0
        return {
            connectionsOpened: this.connectionsOpened,
            connectionsClosed: this.connectionsClosed,
            frameCount: this.frameCount,
            byteCount: this.byteCount,
            durationSec: Number(dur.toFixed(2)),
            fps: dur > 0 ? Number((this.frameCount / dur).toFixed(1)) : null,
            firstFrameMsAgo: this.firstFrameMs ? Date.now() - this.firstFrameMs : null,
            metadataCount: this.metadata.length,
        }
    }
}

const meter = new FrameMeter()  // shared — we reset between tests
function resetMeter() {
    meter.connectionsOpened = 0
    meter.connectionsClosed = 0
    meter.firstFrameMs = null
    meter.lastFrameMs = null
    meter.frameCount = 0
    meter.byteCount = 0
    meter.metadata = []
}

// Spawn WS server + return when it's listening
function startWsServer() {
    return new Promise((resolve, reject) => {
        const wss = new WebSocketServer({ port: WS_PORT, host: '0.0.0.0' })
        wss.on('listening', () => {
            console.log(`[ws] listening on ${WS_PORT}`)
            resolve(wss)
        })
        wss.on('error', reject)
        wss.on('connection', (ws, req) => {
            console.log(`[ws] connection from ${req.socket.remoteAddress}:${req.socket.remotePort} url=${req.url}`)
            meter.onOpen()
            ws.on('message', (data, isBinary) => {
                if (isBinary) meter.onFrame(data.length)
                else meter.onMeta(data.toString().slice(0, 200))
            })
            ws.on('close', code => {
                console.log(`[ws] connection closed code=${code}`)
                meter.onClose()
            })
            ws.on('error', err => console.error(`[ws] connection error: ${err.message}`))
        })
    })
}

async function originateLoopback() {
    const uuid = crypto.randomUUID()
    // Loopback to 9999 (audio_fork test ext: answer + 800ms sleep + park),
    // then on the A-leg play a long-duration tone for the whole test
    // window. That way both READ and WRITE sides of the channel carry
    // audio continuously and `mixed` / `stereo` can be exercised as
    // well as `mono`.
    //
    // tone_stream://%(60000,0,440) = 60s 440Hz tone with 0ms gap. The %
    // glyph needs no escape via originate-with-app-form because the app
    // string is parsed AFTER originate's brace-block parser.
    const vars = `origination_uuid=${uuid},ignore_early_media=true`
    const cmd = `originate {${vars}}loopback/9999/default &playback(tone_stream://%(60000,0,440))`
    const reply = await eslApi(cmd, 15000)
    console.log(`[setup] originate: ${reply.trim()}`)
    return uuid
}

async function killChannel(uuid) {
    try {
        const r = await eslApi(`uuid_kill ${uuid}`, 5000)
        console.log(`[teardown] uuid_kill: ${r.trim()}`)
    } catch (e) {
        console.log(`[teardown] uuid_kill failed: ${e.message}`)
    }
}

async function testMixType(uuid, mixType, observeMs = 4000) {
    resetMeter()
    const bugname = `test_${mixType}_${Date.now()}`
    const forkUrl = `ws://${LAN_IP}:${WS_PORT}/audio?test=${mixType}`
    const cmd = `uuid_audio_fork ${uuid} start ${forkUrl} ${mixType} 8000 ${bugname}`
    console.log(`\n--- test mix-type=${mixType} ---`)
    console.log(`  cmd: ${cmd}`)
    const t0 = Date.now()
    let reply, error = null
    try {
        reply = (await eslApi(cmd, 10000)).trim()
        console.log(`  fs reply: ${reply}`)
    } catch (e) {
        error = e.message
        console.log(`  fs reply: ERROR ${e.message}`)
    }
    await sleep(observeMs)
    const stats = meter.snapshot()
    console.log(`  stats after ${observeMs}ms:`, stats)
    // Stop this bug so the next test starts clean
    try {
        const stopR = await eslApi(`uuid_audio_fork ${uuid} stop ${bugname}`, 5000)
        console.log(`  stop reply: ${stopR.trim()}`)
        await sleep(500)  // let WS close cleanup propagate
    } catch (e) {
        console.log(`  stop failed: ${e.message}`)
    }
    return {
        mixType, cmd, reply, error,
        observeMs,
        stats,
        verdict: stats.frameCount > 0 ? 'PCM_OK' : 'NO_PCM',
    }
}

async function testPauseResume(uuid, mixType = 'mono') {
    resetMeter()
    const bugname = `test_pause_${Date.now()}`
    const forkUrl = `ws://${LAN_IP}:${WS_PORT}/audio?test=pause`
    const startCmd = `uuid_audio_fork ${uuid} start ${forkUrl} ${mixType} 8000 ${bugname}`
    console.log(`\n--- test pause/resume on mixed ---`)
    console.log(`  start: ${startCmd}`)
    const startR = (await eslApi(startCmd, 10000)).trim()
    console.log(`  start fs reply: ${startR}`)
    await sleep(2000)
    const beforePause = meter.snapshot()
    console.log(`  baseline after 2s: ${beforePause.frameCount} frames`)

    const pauseR = (await eslApi(`uuid_audio_fork ${uuid} pause ${bugname}`, 5000)).trim()
    console.log(`  pause: ${pauseR}`)
    const pauseStartMs = Date.now()
    const framesAtPause = meter.frameCount
    await sleep(2000)
    const duringPause = meter.snapshot()
    const framesDuringPause = duringPause.frameCount - framesAtPause
    console.log(`  during pause (2s): +${framesDuringPause} frames`)

    const resumeR = (await eslApi(`uuid_audio_fork ${uuid} resume ${bugname}`, 5000)).trim()
    console.log(`  resume: ${resumeR}`)
    const framesAtResume = meter.frameCount
    await sleep(2000)
    const afterResume = meter.snapshot()
    const framesAfterResume = afterResume.frameCount - framesAtResume
    console.log(`  after resume (2s): +${framesAfterResume} frames`)

    try {
        const stopR = await eslApi(`uuid_audio_fork ${uuid} stop ${bugname}`, 5000)
        console.log(`  stop: ${stopR.trim()}`)
        await sleep(500)
    } catch (e) {
        console.log(`  stop failed: ${e.message}`)
    }

    return {
        startReply: startR,
        baselineFrames: beforePause.frameCount,
        pauseReply: pauseR,
        framesDuringPauseWindow: framesDuringPause,
        pauseEffective: framesDuringPause < 5,  // expect ~0 if pause works
        resumeReply: resumeR,
        framesAfterResumeWindow: framesAfterResume,
        resumeEffective: framesAfterResume > 50,  // expect >50 fps in 2s
    }
}

async function main() {
    const wss = await startWsServer()
    let uuid
    try {
        uuid = await originateLoopback()
        // Give FS a moment for the loopback channel to fully answer/park.
        // Without this the first uuid_audio_fork can land before the
        // channel is in CS_EXECUTE → "Error locating session".
        await sleep(800)

        const results = []
        for (const mixType of ['mono', 'mixed', 'stereo']) {
            results.push(await testMixType(uuid, mixType, 3500))
        }
        // Test pause/resume on mono — we already confirmed mono streams
        // frames, so we can actually measure whether pause stops the
        // flow and resume restarts it.
        const pauseResult = await testPauseResume(uuid, 'mono')

        console.log('\n=== SUMMARY ===')
        console.table(results.map(r => ({
            mixType: r.mixType,
            verdict: r.verdict,
            frames: r.stats.frameCount,
            fps: r.stats.fps,
            wsOpen: r.stats.connectionsOpened,
            fsReply: (r.reply || r.error || '').slice(0, 40),
        })))
        console.log('\npause/resume:', JSON.stringify(pauseResult, null, 2))
        console.log('\nfull mix-type report:', JSON.stringify(results, null, 2))
    } finally {
        if (uuid) await killChannel(uuid)
        wss.close()
    }
}

main().catch(e => { console.error('FATAL:', e); process.exit(1) })
