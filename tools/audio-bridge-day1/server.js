/**
 * AudioBridge — orchestrates AI-call dialog over FreeSWITCH.
 *
 *   FreeSWITCH (mod_audio_fork)  →  WS /audio  (binary PCM in, JSON metadata first)
 *   FreeSWITCH (uuid_broadcast)  ←  HTTP /play/<name>.wav   (playback source)
 *
 * Modules layered on top of the original Day-1 audio roundtrip:
 *   - stt-router (Yandex SpeechKit gRPC streaming OR OpenAI Whisper fallback)
 *   - tts-router (Yandex SpeechKit REST OR OpenAI TTS fallback)
 *   - llm-client (OpenAI Chat with function-calling: save_lead_data /
 *                 end_call / transfer_to_manager)
 *   - call-session (per-call orchestrator binding STT → LLM → TTS)
 *   - crm-client (HTTP back to CRM: resolve scenario by call UUID,
 *                 stream transcript items, finalize on hangup)
 *
 * Without any API keys the bridge stays in Day-1 behaviour: PCM in, no
 * dialog out. With OPENAI_API_KEY alone it works end-to-end via Whisper +
 * OpenAI TTS (russian voice quality is so-so but the pipeline runs).
 * With Yandex keys it upgrades to native russian STT/TTS.
 *
 * Also exposes control endpoints to drive ESL from a browser/curl during tests:
 *   GET  /test-play/:uuid    — uuid_broadcast <uuid> http://127.0.0.1:3030/play/test.wav aleg
 *   GET  /test-break/:uuid   — uuid_break <uuid>
 */

// Load bridge-local .env (HTTPS_PROXY, BRIDGE_SHARED_TOKEN, CRM_BASE_URL,
// optional per-bridge model overrides). Must run BEFORE init-proxy and the
// runtime/crm modules so they see env values consistently.
require('dotenv').config({ path: require('path').join(__dirname, '.env') })

// Install undici global proxy dispatcher BEFORE any module that may
// issue an outbound fetch is required. OpenAI / Yandex providers go
// through this on geo-blocked networks (RU). Configure via HTTPS_PROXY.
require('./init-proxy').initProxy()

const http = require('http')
const fs = require('fs')
const path = require('path')
const net = require('net')
const os = require('os')
const crypto = require('crypto')
const { WebSocketServer } = require('ws')

const stt = require('./stt-router')
const tts = require('./tts-router')
const llm = require('./llm-client')
const crm = require('./crm-client')
const runtime = require('./runtime-config')
const { opsLog } = require('./opsLog')
const { CallSession } = require('./call-session')

// Active per-call sessions keyed by FreeSWITCH call UUID. WS connections
// reference one of these by the `call-id` query string (set in fork_meta).
const sessions = new Map()

// Pre-answer TTS queueing — see «answer-gated broadcast» note in
// broadcastWav() and the ESL onEvent handler. The bridge synthesises the
// bot's greeting during ringing (so it's ready by the time the lead
// answers) but must NOT push audio onto the channel until the lead's
// handset is actually live — Megafon's SBC routes early-media RTP into
// the ringback rather than the user's ear (issue #23). These three
// collections track per-channel state through the PARK → ANSWER →
// HANGUP lifecycle.
//
// deadChannels is intentionally a separate set rather than an
// `aliveChannels.delete(uuid)` on hangup: TTS synthesis can outlive the
// call (LLM tail + ~3 s synth wallclock), and a broadcastWav() invocation
// that lands AFTER HANGUP_COMPLETE must short-circuit instead of queueing
// into an orphan slot that no future ANSWER will flush. The set is small
// (one entry per call ID) and cleared whenever a new PARK arrives for
// the same UUID — see the relevant branch in onEvent().
const answeredChannels = new Set()        // callUuids that have fired CHANNEL_ANSWER
const deadChannels = new Set()            // callUuids past CHANNEL_HANGUP_COMPLETE
const pendingBroadcasts = new Map()       // callUuid → Array<{ file, durMs, resolve }>

const PORT = Number(process.env.AUDIO_BRIDGE_PORT ?? 3030)
const ESL_HOST = process.env.FS_ESL_HOST ?? '127.0.0.1'
const ESL_PORT = Number(process.env.FS_ESL_PORT ?? 8021)
const ESL_PASS = process.env.ESL_PASSWORD ?? 'ClueCon'
// Directory where bridge writes TTS WAVs that FS will then play back.
// Override via BRIDGE_AUDIO_DIR env when FreeSWITCH lives outside the
// host process and you want to put the files on a filesystem with
// low-latency streaming reads — important: FS reads the file in
// 20 ms chunks during playback, so DrvFs / SMB / network paths can
// introduce RTP underruns ("choppy bot voice", #23). Pointing this
// at a UNC path on WSL tmpfs (\\wsl.localhost\<distro>\dev\shm\...)
// keeps FS reading from ext4/tmpfs even when the bridge runs on
// Windows.
const AUDIO_DIR = process.env.BRIDGE_AUDIO_DIR ?? path.join(__dirname, 'audio')

// Ensure AUDIO_DIR exists on boot. When BRIDGE_AUDIO_DIR points to a
// tmpfs path (e.g. \\wsl.localhost\<distro>\dev\shm\bridge-tts), the
// directory disappears on WSL restart / suspend-resume. Recreating it
// here keeps the bridge usable through the project's «Запусти проект
// полностью» trigger without a manual mkdir step after every reboot.
try {
    fs.mkdirSync(AUDIO_DIR, { recursive: true })
    console.log(`[bridge] AUDIO_DIR ready → ${AUDIO_DIR}`)
} catch (err) {
    console.error(`[bridge] failed to create AUDIO_DIR ${AUDIO_DIR}: ${err.message}`)
}

// Address FreeSWITCH (in WSL2) uses to reach this bridge (on the Windows
// host). We empirically tested both modes:
//   - WSL2 *mirrored* networking (default on Win11): WSL shares the LAN IP
//     with Windows, so a connect to 192.168.x.y from inside WSL routes to
//     WSL's own stack first and gets ECONNREFUSED. The only address that
//     actually crosses over is 127.0.0.1, which mirrored mode forwards
//     transparently to a Windows-bound socket on the same port.
//   - WSL2 *NAT* (legacy): 127.0.0.1 inside WSL is WSL itself; you must
//     use the host's LAN IP (192.168.x.y) or the WSL host's gateway.
//
// We default to 127.0.0.1 because:
//   a) Mirrored is the Win11 default, and
//   b) NAT mode users typically already set BRIDGE_LAN_IP=192.168.x.y
//      when wiring up FreeSWITCH the first time.
function detectLanIp() {
    if (process.env.BRIDGE_LAN_IP) return process.env.BRIDGE_LAN_IP
    return '127.0.0.1'
}
const LAN_IP = detectLanIp()
const FORK_WS_URL = `ws://${LAN_IP}:${PORT}/audio`

// Trigger uuid_audio_fork on calls landing on these dialplan extensions.
// Bridge listens to CHANNEL_ANSWER events and auto-invokes the API.
const AUTO_FORK_EXTENSIONS = (process.env.AUTO_FORK_EXTENSIONS ?? '9999,9998')
    .split(',').map(s => s.trim()).filter(Boolean)

// ── HTTP server: serves WAV for uuid_broadcast + control endpoints ─────────────

const httpServer = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url.startsWith('/play/')) {
        const name = path.basename(req.url.split('?')[0])
        const file = path.join(AUDIO_DIR, name)
        if (!fs.existsSync(file)) {
            res.statusCode = 404
            return res.end('not found')
        }
        const stat = fs.statSync(file)
        res.setHeader('Content-Type', 'audio/wav')
        res.setHeader('Content-Length', stat.size)
        fs.createReadStream(file).pipe(res)
        return
    }
    if (req.method === 'GET' && req.url.startsWith('/test-play/')) {
        const uuid = decodeURIComponent(req.url.split('/').pop())
        // Use LAN IP, not 127.0.0.1: FreeSWITCH runs in WSL2 and loopback
        // inside WSL is WSL itself, not the Windows host serving this HTTP.
        return eslApi(`uuid_broadcast ${uuid} http://${LAN_IP}:${PORT}/play/test.wav aleg`)
            .then(out => res.end(`OK: ${out}`))
            .catch(err => { res.statusCode = 500; res.end(`ERR: ${err.message}`) })
    }
    if (req.method === 'GET' && req.url.startsWith('/test-break/')) {
        const uuid = decodeURIComponent(req.url.split('/').pop())
        return eslApi(`uuid_break ${uuid}`)
            .then(out => res.end(`OK: ${out}`))
            .catch(err => { res.statusCode = 500; res.end(`ERR: ${err.message}`) })
    }
    if (req.method === 'GET' && req.url === '/health') {
        res.end('ok')
        return
    }
    res.statusCode = 404
    res.end('not found')
})

// /play strips query string before basename (avoid `test.wav?x=1` becoming a 404)
// — applied inside the /play handler above via req.url.split('?')[0].

httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`[http] listening on :${PORT}`)
    // Note: providers can become enabled later when admins save keys via the
    // CRM UI — these booleans reflect only the .env state at boot. The
    // per-call STT/LLM/TTS dispatch re-evaluates on every session start.
    console.log(`[stt] boot: ${stt.enabled() ? `enabled (${stt.describeProvider()})` : 'DISABLED — configure key in CRM settings'}`)
    console.log(`[tts] boot: ${tts.enabled() ? `enabled (${tts.describeProvider()})` : 'DISABLED — configure key in CRM settings'}`)
    console.log(`[llm] boot: ${llm.enabled() ? 'enabled (OpenAI Chat)' : 'DISABLED — configure OpenAI key in CRM settings'}`)
})

// ── WebSocket server: receives PCM from mod_audio_fork ─────────────────────────

const wss = new WebSocketServer({ server: httpServer, path: '/audio' })

wss.on('connection', (ws, req) => {
    const remote = `${req.socket.remoteAddress}:${req.socket.remotePort}`
    // mod_audio_fork passes our "fork_meta" tag in the URL query — we encode
    // the FreeSWITCH call UUID there at auto-fork time so we can route the
    // WS stream back to the right CallSession.
    const urlObj = new URL(req.url, `http://${req.headers.host}`)
    const callUuid = urlObj.searchParams.get('callUuid')
    const session = callUuid ? sessions.get(callUuid) : null
    console.log(`[ws] connected from ${remote} callUuid=${callUuid ?? '?'} session=${session ? 'YES' : 'no'}`)

    let metaSeen = false
    let frames = 0
    let bytes = 0
    let firstFrameAt = null
    let lastFrameAt = null
    let lastLogAt = Date.now()
    let slowFramesInWindow = 0

    ws.on('message', (data, isBinary) => {
        if (!isBinary) {
            // mod_audio_fork sends a JSON metadata frame as the first text message.
            if (!metaSeen) {
                metaSeen = true
                console.log(`[ws] metadata: ${data.toString().slice(0, 300)}`)
            } else {
                console.log(`[ws] text frame: ${data.toString().slice(0, 200)}`)
            }
            return
        }

        const now = Date.now()
        if (!firstFrameAt) {
            firstFrameAt = now
            console.log(`[ws] first PCM frame: ${data.length} bytes (session=${session ? 'on' : 'audio-only'})`)
        } else if (lastFrameAt && now - lastFrameAt > 50) {
            // Count every slow gap; log aggregated per second below.
            slowFramesInWindow++
        }
        lastFrameAt = now
        frames++
        bytes += data.length

        // mod_audio_fork "mixed" mode delivers a single mono channel — no
        // deinterleaving needed. Forward to the live CallSession
        // orchestrator (if a session is bound). No session → bridge is
        // in Day-1 audio-only mode; PCM frames are still counted/logged
        // for diagnostics.
        if (session) session.onPcm(data)

        // Throttle stats to ~1/sec, include slow-frame count for the window.
        if (now - lastLogAt >= 1000) {
            const elapsedSec = (now - firstFrameAt) / 1000
            const slowSuffix = slowFramesInWindow > 0
                ? ` slowFrames=${slowFramesInWindow}`
                : ''
            console.log(
                `[ws] frames=${frames} bytes=${bytes} ` +
                `fps=${(frames / elapsedSec).toFixed(1)} ` +
                `avg=${(bytes / frames).toFixed(0)}B/frame ` +
                `elapsed=${elapsedSec.toFixed(1)}s${slowSuffix}`,
            )
            lastLogAt = now
            slowFramesInWindow = 0
        }
    })

    ws.on('close', code => {
        const elapsedSec = firstFrameAt ? (Date.now() - firstFrameAt) / 1000 : 0
        console.log(
            `[ws] closed code=${code} frames=${frames} bytes=${bytes} ` +
            `dur=${elapsedSec.toFixed(1)}s`,
        )
        if (session) session.stop()
    })

    ws.on('error', err => {
        console.error(`[ws] error: ${err.message}`)
    })
})

console.log(`[ws] mounted on ws://0.0.0.0:${PORT}/audio`)

// ── ESL minimal one-shot client: connect, auth, send one api, close ────────────

function eslApi(command, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
        const sock = net.connect(ESL_PORT, ESL_HOST)
        sock.setEncoding('utf8')
        let buf = ''
        let stage = 'connecting'

        const timer = setTimeout(() => {
            sock.destroy()
            reject(new Error(`esl timeout after ${timeoutMs}ms (stage=${stage})`))
        }, timeoutMs)

        sock.on('data', chunk => {
            buf += chunk

            if (stage === 'connecting' && buf.includes('Content-Type: auth/request')) {
                stage = 'authenticating'
                buf = ''
                sock.write(`auth ${ESL_PASS}\n\n`)
                return
            }

            if (stage === 'authenticating') {
                if (buf.includes('+OK accepted')) {
                    stage = 'sending'
                    buf = ''
                    sock.write(`api ${command}\n\n`)
                    return
                }
                if (buf.includes('-ERR')) {
                    clearTimeout(timer)
                    sock.destroy()
                    reject(new Error(`esl auth failed: ${buf.split('\n').filter(l => l.includes('-ERR'))[0] || 'unknown'}`))
                    return
                }
            }

            if (stage === 'sending') {
                // Trim buffer to start at api/response to avoid matching a stray
                // Content-Length: header from an unrelated event preceding it.
                const respIdx = buf.indexOf('Content-Type: api/response')
                if (respIdx === -1) return
                const respBuf = buf.substring(respIdx)
                const m = respBuf.match(/Content-Length: (\d+)\r?\n\r?\n([\s\S]*)/)
                if (m) {
                    const expectedLen = Number(m[1])
                    const body = m[2]
                    if (Buffer.byteLength(body, 'utf8') >= expectedLen) {
                        clearTimeout(timer)
                        stage = 'done'
                        sock.removeAllListeners('data')
                        sock.end()
                        resolve(body.trim())
                    }
                }
            }
        })

        sock.on('error', err => {
            clearTimeout(timer)
            reject(err)
        })
    })
}

// ── CallSession lifecycle ──────────────────────────────────────────────────────
//
// Bound to the FreeSWITCH call by the CRM-issued AI-call session row. CRM
// stores `fsUuid` on the Call when /api/ai-calls/start originates; this
// bridge looks the row up here and builds a CallSession around the
// scenario.

async function ensureSessionForCall(callUuid) {
    if (sessions.has(callUuid)) return sessions.get(callUuid)

    // Refresh provider keys from CRM (DB-backed). The fetch is cached
    // 60 s in crm-client, so back-to-back calls share one DB hit. The
    // moment an admin saves a new key via the UI, the next call picks
    // it up automatically.
    try {
        const keys = await crm.fetchKeys()
        runtime.setKeys(keys)
    } catch (err) {
        console.error(`[session] runtime key refresh failed: ${err.message}`)
        // Non-fatal — fall back to whatever runtime + .env already had.
    }

    let resolved
    try {
        resolved = await crm.resolveCallByUuid(callUuid)
    } catch (err) {
        // 404 is expected for ad-hoc test calls (no CRM session row). Don't
        // spam the log — the WS handler will note "session=no" anyway.
        if (!err.message.includes('HTTP 404')) {
            console.error(`[crm] resolve ${callUuid}: ${err.message}`)
        }
        return null
    }
    if (!resolved?.callId || !resolved?.scenario) return null

    console.log(`[session] bind ${callUuid} → callId=${resolved.callId} scenario="${resolved.scenario.name}"`)

    // CRM-canonical intermediate state writes are reported at most once
    // per call to keep `Call.aiSessionStatus` operator-meaningful — we
    // don't want a flood of greeting/active POSTs on bridge reconnect.
    // Endpoint is also idempotent server-side; this is the bridge-side
    // first line of defence.
    let greetingReported = false
    let activeReported = false

    const session = new CallSession({
        callUuid,
        scenario: resolved.scenario,
        broadcastWav: wav => broadcastWav(callUuid, wav),
        onFinalize: payload => {
            sessions.delete(callUuid)
            crm.finalize(resolved.callId, payload).catch(err => {
                console.error(`[crm] finalize ${resolved.callId} failed: ${err.message}`)
            })
        },
        onTranscriptItem: (role, text, receipt) => {
            crm.appendTranscript(resolved.callId, role, text, receipt).catch(() => {})
        },
        onState: s => {
            // Always emit a structured JSON-line for every transition
            // (idle/greeting/listening/thinking/speaking/ended). This is
            // the «full operational timeline» surface — observable via
            // `tail bridge.log | jq` without touching the DB.
            opsLog('info', 'ai_call_state_changed', {
                callUuid,
                callId: resolved.callId,
                to: s,
            })
            // CRM-canonical state write: `greeting` once, on entry.
            // The other DB-visible transitions are owned by other paths:
            //   - `starting`     → /api/ai-calls/start route
            //   - `active`       → onUserSpoke below (first STT final)
            //   - `transferring` → finalize route (reason='transferred')
            //   - `ended`/`failed` → finalize route
            // Everything else (listening/thinking/speaking/idle) stays
            // bridge-local and never touches `Call.aiSessionStatus`.
            if (s === 'greeting' && !greetingReported) {
                greetingReported = true
                crm.postState(resolved.callId, 'greeting')
            }
        },
        onUserSpoke: () => {
            // First STT final the session accepts. Marks the call as
            // `active` in CRM — «real dialog has started, not just
            // bot-monologue in greeting». Helper guards against the
            // 2nd+ STT final hitting this branch; endpoint idempotency
            // is the second line of defence.
            if (activeReported) return
            activeReported = true
            crm.postState(resolved.callId, 'active')
        },
    })
    sessions.set(callUuid, session)
    session.start().catch(err => {
        console.error(`[session ${callUuid}] start failed: ${err.message}`)
        sessions.delete(callUuid)
    })
    return session
}

// Translate the Windows AUDIO_DIR into the path FreeSWITCH (running in
// WSL2) sees over the auto-mounted DrvFs. The bridge's AUDIO_DIR comes from
// path.join(__dirname, 'audio') on Windows, e.g. "D:\\Github\\…\\audio";
// from WSL the same dir is "/mnt/d/Github/…/audio". Override via env if
// your bridge or FS layout differs (e.g. both on Linux, or FS on a remote
// host with NFS-mounted audio).
function defaultAudioDirForFs() {
    if (process.env.BRIDGE_AUDIO_DIR_FS) return process.env.BRIDGE_AUDIO_DIR_FS
    // "D:\Github\..." → "/mnt/d/Github/..." (Windows DrvFs convention)
    const win = AUDIO_DIR
    const m = /^([a-zA-Z]):[\\/](.*)$/.exec(win)
    if (m) {
        const drive = m[1].toLowerCase()
        const rest = m[2].replace(/\\/g, '/')
        return `/mnt/${drive}/${rest}`
    }
    return win
}
const AUDIO_DIR_FS = defaultAudioDirForFs()

// Parse a standard 44-byte RIFF/WAVE header and return playback duration
// in milliseconds. Returns null if the buffer doesn't look like a WAV,
// in which case the caller falls back to a conservative default.
function wavDurationMs(wavBuffer) {
    if (!wavBuffer || wavBuffer.length < 44) return null
    if (wavBuffer.toString('ascii', 0, 4) !== 'RIFF') return null
    if (wavBuffer.toString('ascii', 8, 12) !== 'WAVE') return null
    // ByteRate at offset 28-31 (little-endian uint32). Equals
    // sampleRate * channels * bitsPerSample / 8 → bytes of audio per second.
    const byteRate = wavBuffer.readUInt32LE(28)
    if (!byteRate) return null
    const dataBytes = wavBuffer.length - 44
    return Math.round((dataBytes / byteRate) * 1000)
}

// Save WAV to AUDIO_DIR with a unique name and trigger uuid_broadcast on the
// aleg. We pass a FILESYSTEM path that FreeSWITCH can read directly (file:
// or bare path), not an HTTP URL — mod_httapi in our setup honours the WSL
// env's http_proxy and fails to fetch loopback URLs through Xray. The
// shared DrvFs mount under /mnt/<drive>/... is plenty for inter-process
// audio handoff and skips the cache/network stack entirely.
//
// Returns the estimated playback duration in ms (from the WAV header).
// CallSession uses this to keep STT muted for the full TTS playback
// window — uuid_broadcast is fire-and-forget on the FS side, so without
// this estimate STT would un-mute halfway through playback and pick up
// our own audio as "lead speech" (echo).
//
// Note on echo prevention: we don't wrap broadcast with audio_fork
// pause/resume any more. Since we switched the fork to mix-type=mono
// (search `BRIDGE_FORK_MIX` in this file) the WS sees inbound caller
// audio only — STT physically cannot hear our TTS. The prior comment
// here claimed `pause`/`resume` were broken in this fork's build; that
// assertion was based on a buggy test condition and was disproven by
// `scripts/test_mod_audio_fork.js`. pause IS effective (frames stop
// within 2 s) and resume IS effective (frames restart within 2 s).
// We just don't need either under mono.
async function broadcastWav(callUuid, wavBuffer) {
    const name = `tts-${callUuid.slice(0, 8)}-${crypto.randomBytes(4).toString('hex')}.wav`
    const fileWin = path.join(AUDIO_DIR, name)
    const t0 = Date.now()
    await fs.promises.writeFile(fileWin, wavBuffer)
    const fileFs = `${AUDIO_DIR_FS}/${name}`
    const writeMs = Date.now() - t0
    const durMs = wavDurationMs(wavBuffer)
    console.log(`[broadcast] ${callUuid} wrote ${wavBuffer.length} bytes in ${writeMs}ms (duration≈${durMs}ms) → ${fileFs}`)

    // Tidy up the WAV after a generous delay — playback is async on the FS
    // side so we can't delete immediately. 60 s covers anything plausible
    // for a single TTS phrase (including a worst-case queue in
    // pendingBroadcasts where the ringing window stretched 10 s+).
    //
    // BRIDGE_KEEP_TTS=1 disables cleanup entirely so issue #23 diagnostics
    // (scripts/analyze_local_wav.js) can compare the bridge-generated WAV
    // against the FS-rendered call recording side-by-side.
    if (process.env.BRIDGE_KEEP_TTS !== '1') {
        setTimeout(() => fs.promises.unlink(fileWin).catch(() => {}), 60_000).unref()
    }

    // Channel-state-aware playback.
    //
    //   dead     — CHANNEL_HANGUP_COMPLETE has already fired. Don't even
    //              hand the WAV to FreeSWITCH: the leg is gone and any
    //              uuid_broadcast would fail with «no session». Returning
    //              null here also short-circuits CallSession._speak()'s
    //              mute-window math (it treats 0/null as «nothing to
    //              wait for»), which lets the session torn-down logic
    //              run unblocked. Without this branch a late-arriving
    //              synthesis (e.g. the end_call goodbye that synthesises
    //              after FS already closed the channel) would enter the
    //              pre-answer branch below, find no ANSWER ever coming,
    //              and leak a permanent entry in pendingBroadcasts.
    //
    //   pre-answer (not yet in answeredChannels, not in deadChannels)
    //            — Megafon's SBC routes pre-answer audio into the ringback
    //              leg, so a uuid_broadcast started during RINGING is
    //              either lost entirely or truncated when the lead picks
    //              up mid-phrase. Queue the WAV and return a Promise that
    //              resolves with durMs once the ANSWER handler fires
    //              uuid_broadcast on its behalf. CallSession._speak()
    //              awaits this Promise, so its acceptSttAfter window
    //              stays anchored to actual-playback-start rather than
    //              synth-completion.
    //
    //   live     — already answered; fire-and-forget below.
    if (deadChannels.has(callUuid)) {
        console.log(`[broadcast] ${callUuid} dropped — channel already hung up`)
        return null
    }
    if (!answeredChannels.has(callUuid)) {
        return new Promise(resolve => {
            const list = pendingBroadcasts.get(callUuid) ?? []
            list.push({ file: fileFs, durMs, resolve })
            pendingBroadcasts.set(callUuid, list)
            console.log(`[broadcast] ${callUuid} queued (pre-answer) — queue size: ${list.length}`)
        })
    }

    try {
        const reply = await eslApi(`uuid_broadcast ${callUuid} ${fileFs} aleg`)
        console.log(`[broadcast] ${callUuid} fs reply: ${reply.trim().slice(0, 120)}`)
    } catch (err) {
        console.error(`[broadcast] ${callUuid} → ${name} failed: ${err.message}`)
        return null
    }
    return durMs
}

// ── ESL persistent event listener: drives the per-call lifecycle ───────────────
//
// Subscribes once to ALL FreeSWITCH events and filters in onEvent() down to
// three that matter:
//   CHANNEL_PARK            → bind CRM session + start greeting synthesis
//                             (during RINGING, so the WAV is on disk by the
//                             time the lead picks up)
//   CHANNEL_ANSWER          → start uuid_audio_fork (STT stream) AND flush
//                             any pre-synthesised playback queued in
//                             pendingBroadcasts
//   CHANNEL_HANGUP_COMPLETE → release per-call gating state and resolve
//                             orphan awaiters
//
// The full motivation (answer-gated playback for issue #23) is documented
// inline at the top of onEvent() and in broadcastWav(). Connection
// reconnects with exponential backoff on disconnect.

function startEslEventListener() {
    let reconnectDelay = 2000
    let buf = ''
    let stage = 'connecting'

    const sock = net.connect(ESL_PORT, ESL_HOST)
    sock.setEncoding('utf8')

    function onEvent(headersText) {
        try {
            // Parse "key: value" headers — keep raw values; decode lazily.
            const headers = {}
            for (const line of headersText.split('\n')) {
                const idx = line.indexOf(': ')
                if (idx > 0) headers[line.substring(0, idx)] = line.substring(idx + 2)
            }
            const eventName = headers['Event-Name']

            // Three event types drive the session lifecycle. Each does ONE
            // thing — splitting "synth" from "play" was the whole point of
            // this rework (see «answer-gated broadcast» note at the top of
            // the file and in broadcastWav()).
            //
            //   CHANNEL_PARK            — dialplan executed park(). For
            //                             outbound calls through Megafon's
            //                             SBC this fires 5–15 s BEFORE the
            //                             lead picks up, while the channel
            //                             is still RINGING. Use it as the
            //                             earliest reliable trigger to
            //                             bind the CallSession and let the
            //                             greeting synthesise in the
            //                             background, so the WAV is ready
            //                             on disk by the time ANSWER fires.
            //                             broadcastWav() queues the file
            //                             into pendingBroadcasts until then.
            //   CHANNEL_ANSWER          — SIP 200 OK landed; channel went
            //                             RINGING → ACTIVE. NOW audio
            //                             actually reaches the handset.
            //                             Start uuid_audio_fork (STT
            //                             stream) AND flush any
            //                             pre-synthesised playback queued
            //                             during PARK.
            //   CHANNEL_HANGUP_COMPLETE — release gating maps so they don't
            //                             leak per-call. Also resolves any
            //                             orphaned queued broadcasts (e.g.
            //                             lead rejected the call before
            //                             answering) so the awaiting
            //                             _speak() doesn't hang forever.
            //
            // Earlier attempts that DIDN'T work:
            //   - Trigger everything on CHANNEL_PARK: bot starts speaking
            //     into a still-ringing channel. Megafon's SBC routes that
            //     audio into the ringback leg instead of the user's ear;
            //     first 1–3 s of greeting (or the entire short utterance)
            //     gets lost. Manifested as «teryayutsya bukvy» / choppy
            //     greeting (issue #23, first pass).
            //   - Trigger everything on CHANNEL_ANSWER: synthesis only
            //     starts AFTER pickup, so the lead hears 8–12 s of dead air
            //     while CRM + LLM + TTS round-trip runs. Tested live
            //     2026-05-18: confirmed unusable (issue #23, second pass).
            //   - park = synth, answer = play (current): synthesis overlaps
            //     with ringing wait; playback fires the instant the channel
            //     is live. No dead air, no lost syllables.
            if (eventName !== 'CHANNEL_PARK'
                && eventName !== 'CHANNEL_ANSWER'
                && eventName !== 'CHANNEL_HANGUP_COMPLETE') return

            const uuid = headers['Unique-ID'] || headers['Channel-Call-UUID']
            if (!uuid) return

            // For `originate user/103 9999 XML default`, the actually-dialed
            // dialplan extension lands in variable_dialed_extension /
            // variable_originate_called_number, while Caller-Destination-Number
            // shows the SIP user URI piece. Check every plausible field.
            //
            // We do the extension filter BEFORE the event-specific branches
            // so HANGUP_COMPLETE on unrelated channels (other extensions
            // in the dialplan — manager outbound, MAX inbound, etc.) never
            // pollutes our per-channel state maps. Without this, every
            // hangup in the system would leak one entry into deadChannels.
            const dialedExts = [
                headers['variable_dialed_extension'],
                headers['variable_originate_called_number'],
                headers['variable_destination_number'],
                headers['Caller-Destination-Number'],
            ].filter(Boolean)

            const matched = AUTO_FORK_EXTENSIONS.find(ext => dialedExts.includes(ext))
            // Log only for our extensions OR for a UUID we've already
            // bound (so we see HANGUPs on bound channels even if the
            // extension headers got dropped by FS on the way out — happens
            // on aborted originates).
            const knownUuid = answeredChannels.has(uuid) || pendingBroadcasts.has(uuid)
            if (matched || knownUuid) {
                console.log(`[esl] ${eventName} uuid=${uuid} dialed=[${dialedExts.join(',')}] matched=${matched ?? 'none'}`)
            }
            if (!matched && !knownUuid) return

            if (eventName === 'CHANNEL_HANGUP_COMPLETE') {
                // Release any awaiters and clear gating state. Use durMs=0
                // so the resumed _speak() falls through its mute-window
                // calculation immediately — the session is being torn down
                // anyway via the WS close → session.stop() path.
                const queued = pendingBroadcasts.get(uuid)
                if (queued && queued.length) {
                    console.log(`[esl] CHANNEL_HANGUP_COMPLETE ${uuid} → dropping ${queued.length} unplayed broadcast(s)`)
                    for (const item of queued) {
                        try { item.resolve(0) } catch {}
                    }
                }
                pendingBroadcasts.delete(uuid)
                answeredChannels.delete(uuid)
                // Mark dead so any future broadcastWav() (e.g. the
                // end_call goodbye that finished synthesising after FS
                // closed the channel) drops the WAV instead of queueing
                // into a slot that no future ANSWER will flush. Bounded
                // memory: the entry is reaped on the next PARK for this
                // UUID, and call UUIDs are unique-per-call anyway, so
                // worst-case is one dangling entry until the next call
                // on the same UUID — which Megafon will never reuse.
                deadChannels.add(uuid)
                return
            }

            if (eventName === 'CHANNEL_PARK') {
                // Bind CRM session + kick off greeting synthesis NOW. The
                // returned Promise resolves once tts.synthesize() lands a
                // WAV in AUDIO_DIR; broadcastWav() then sees
                // answeredChannels still empty and queues it into
                // pendingBroadcasts[uuid] until ANSWER arrives. We do NOT
                // start uuid_audio_fork here — fork during ringing would
                // stream the SBC's ringback tone into STT, which Whisper
                // would happily transcribe as garbage user speech.
                //
                // For ad-hoc test calls (no CRM-side session row)
                // resolveCallByUuid returns 404 and ensureSessionForCall
                // resolves to null — no session is bound, but the ANSWER
                // branch still fires audio_fork so the audio path can be
                // verified end-to-end via the WS log.
                //
                // Clear deadChannels for this UUID in the unlikely event
                // FS reuses it for a retry — keeps the gating state
                // bounded over a long process lifetime.
                deadChannels.delete(uuid)
                ensureSessionForCall(uuid)
                    .catch(err => console.error(`[esl] session bind failed for ${uuid}: ${err.message}`))
                return
            }

            // CHANNEL_ANSWER — channel is live. Three jobs in order:
            //   1. Mark the channel as answered so any broadcastWav() that
            //      lands AFTER this point fires immediately.
            //   2. Flush anything queued during PARK→ANSWER ringing.
            //   3. Start uuid_audio_fork to begin streaming user PCM to the
            //      bridge for STT.
            answeredChannels.add(uuid)

            const queued = pendingBroadcasts.get(uuid)
            if (queued && queued.length) {
                pendingBroadcasts.delete(uuid)
                console.log(`[esl] CHANNEL_ANSWER ${uuid} → flushing ${queued.length} queued broadcast(s)`)
                // Fire each queued broadcast sequentially. The await-chain
                // here matters: uuid_broadcast itself is fire-and-forget on
                // the FS side, but we want each item.resolve() to land in
                // order so CallSession._speak()'s acceptSttAfter math is
                // anchored to actual playback-start, not synth completion.
                ;(async () => {
                    for (const item of queued) {
                        try {
                            const reply = await eslApi(`uuid_broadcast ${uuid} ${item.file} aleg`)
                            console.log(`[broadcast] ${uuid} (deferred) fs reply: ${reply.trim().slice(0, 120)}`)
                        } catch (err) {
                            console.error(`[broadcast] ${uuid} (deferred) failed: ${err.message}`)
                        }
                        try { item.resolve(item.durMs) } catch {}
                    }
                })()
            }

            // Start audio_fork in `mono` mix-type. mono = SMBF_READ_STREAM
            // only — the media bug taps ONLY the inbound (caller's)
            // audio side of the channel, never the outbound side that
            // playback() writes our TTS into. STT therefore physically
            // CANNOT hear our own bot voice, regardless of timing —
            // eliminating the entire class of "Whisper finalises stale
            // TTS audio as if the lead said it" race conditions.
            //
            // Prior assertion in this codebase: «mono produces 0 PCM
            // frames in this build of mod_audio_fork, only mixed works».
            // That was wrong — the assertion was based on a transient
            // test condition (loopback channel without active playback
            // → mixed/stereo see no write-side audio → looks broken;
            // but mono is unaffected because it reads only the inbound
            // side, which always has at least silence frames). Verified
            // empirically in scripts/test_mod_audio_fork.js (issue #20):
            //   mono   → 46 fps, 320 B/frame, WS opens, PCM flows
            //   mixed  → 46 fps, 320 B/frame (with audio on write side)
            //   stereo → 46 fps, 640 B/frame
            //   pause  → frames stop within 2 s
            //   resume → frames restart within 2 s
            //
            // BRIDGE_FORK_MIX env overrides if a regression appears
            // (`mixed` falls back to the source-gate echo workaround
            // in call-session.js onPcm()). Default `mono`.
            const mixType = process.env.BRIDGE_FORK_MIX ?? 'mono'
            const meta = `callUuid=${encodeURIComponent(uuid)}`
            const forkUrl = `${FORK_WS_URL}?${meta}`
            const cmd = `uuid_audio_fork ${uuid} start ${forkUrl} ${mixType} 8000 ${meta}`
            console.log(`[esl] auto-forking audio for ${uuid} (ext ${matched}, mix=${mixType})`)
            eslApi(cmd)
                .then(out => console.log(`[esl] auto-fork: ${out}`))
                .catch(err => console.error(`[esl] auto-fork FAILED: ${err.message}`))
        } catch (err) {
            console.error(`[esl] onEvent error: ${err.message}`)
        }
    }

    sock.on('data', chunk => {
        buf += chunk
        if (process.env.ESL_DEBUG === '1') {
            console.log(`[esl-events] RAW(${stage}, ${chunk.length}B): ${JSON.stringify(String(chunk).slice(0, 200))}`)
        }

        if (stage === 'connecting' && buf.includes('Content-Type: auth/request')) {
            stage = 'authenticating'
            buf = ''
            sock.write(`auth ${ESL_PASS}\n\n`)
            return
        }

        if (stage === 'authenticating') {
            if (buf.includes('+OK accepted')) {
                stage = 'subscribing'
                buf = ''
                // Subscribe to ALL events — we filter by Event-Name in onEvent.
                // Some FS builds gate per-name subscriptions; ALL is foolproof.
                sock.write('event plain ALL\n\n')
                return
            }
            if (buf.includes('-ERR')) {
                console.error('[esl-events] auth failed, will retry')
                sock.destroy()
                return
            }
        }

        if (stage === 'subscribing' && /\+OK event listener enabled/.test(buf)) {
            stage = 'listening'
            // Keep buf — there may already be queued events after the reply.
            buf = buf.substring(buf.indexOf('+OK event listener enabled') + 'X'.length * 26)
            console.log(`[esl-events] subscribed (auto-fork URL: ${FORK_WS_URL}, triggers: PARK→synth, ANSWER→play+fork on ${AUTO_FORK_EXTENSIONS.join('/')})`)
            // Fall through to listening parser
        }

        if (stage === 'listening') {
            // ESL message framing:
            //   <header-line>\n
            //   ...
            //   Content-Length: N\n
            //   ...
            //   \n            <- blank line ends headers
            //   <N bytes body>
            // Loop in case multiple frames arrived.
            for (;;) {
                const sepIdx = buf.indexOf('\n\n')
                if (sepIdx === -1) break
                const headerBlock = buf.substring(0, sepIdx)
                const lenMatch = headerBlock.match(/Content-Length:\s*(\d+)/i)
                if (!lenMatch) {
                    // Header block with no Content-Length — skip past it
                    buf = buf.substring(sepIdx + 2)
                    continue
                }
                const bodyLen = Number(lenMatch[1])
                const totalLen = sepIdx + 2 + bodyLen
                if (Buffer.byteLength(buf, 'utf8') < totalLen) break  // wait for more
                const body = buf.substr(sepIdx + 2, bodyLen)
                buf = buf.substring(totalLen)
                onEvent(body)
            }
        }
    })

    sock.on('close', () => {
        console.log(`[esl-events] disconnected, reconnect in ${reconnectDelay}ms`)
        stage = 'connecting'
        buf = ''
        setTimeout(startEslEventListener, reconnectDelay)
        reconnectDelay = Math.min(reconnectDelay * 2, 30000)
    })

    sock.on('error', err => {
        console.error(`[esl-events] socket error: ${err.message}`)
        // 'close' will fire next and handle reconnect
    })
}

startEslEventListener()

// ── Graceful shutdown ──────────────────────────────────────────────────────────

function shutdown(signal) {
    console.log(`[main] ${signal} — shutting down (active WS: ${wss.clients.size}, sessions: ${sessions.size})`)
    for (const session of sessions.values()) {
        try { session.stop() } catch {}
    }
    sessions.clear()
    for (const client of wss.clients) {
        try { client.terminate() } catch {}
    }
    wss.close(() => {})
    httpServer.close(() => process.exit(0))
    setTimeout(() => process.exit(1), 3000).unref()
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
