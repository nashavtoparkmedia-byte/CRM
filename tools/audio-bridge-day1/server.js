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
const { CallSession } = require('./call-session')

// Active per-call sessions keyed by FreeSWITCH call UUID. WS connections
// reference one of these by the `call-id` query string (set in fork_meta).
const sessions = new Map()

const PORT = Number(process.env.AUDIO_BRIDGE_PORT ?? 3030)
const ESL_HOST = process.env.FS_ESL_HOST ?? '127.0.0.1'
const ESL_PORT = Number(process.env.FS_ESL_PORT ?? 8021)
const ESL_PASS = process.env.ESL_PASSWORD ?? 'ClueCon'
const AUDIO_DIR = path.join(__dirname, 'audio')

// IP that FreeSWITCH (in WSL2) uses to reach this bridge (on Windows host).
// WSL2 mirrored networking lets WSL→Windows only via LAN IP, NOT 127.0.0.1.
// Pin via env if needed; otherwise auto-detect first non-loopback IPv4.
function detectLanIp() {
    if (process.env.BRIDGE_LAN_IP) return process.env.BRIDGE_LAN_IP
    const ifaces = os.networkInterfaces()
    for (const name of Object.keys(ifaces)) {
        for (const ni of ifaces[name] ?? []) {
            if (ni.family === 'IPv4' && !ni.internal && !ni.address.startsWith('169.254.')) {
                return ni.address
            }
        }
    }
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
        return eslApi(`uuid_broadcast ${uuid} http://127.0.0.1:${PORT}/play/test.wav aleg`)
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

        // Forward to the live CallSession orchestrator (if a session is bound).
        // No session → bridge is in Day-1 audio-only mode; PCM frames are
        // still counted/logged for diagnostics.
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
        onTranscriptItem: (role, text) => {
            crm.appendTranscript(resolved.callId, role, text).catch(() => {})
        },
        onState: s => console.log(`[session ${callUuid}] state=${s}`),
    })
    sessions.set(callUuid, session)
    session.start().catch(err => {
        console.error(`[session ${callUuid}] start failed: ${err.message}`)
        sessions.delete(callUuid)
    })
    return session
}

// Save WAV to AUDIO_DIR with a unique name and trigger uuid_broadcast on
// the aleg. The bridge already serves AUDIO_DIR via GET /play/<name>.
async function broadcastWav(callUuid, wavBuffer) {
    const name = `tts-${callUuid.slice(0, 8)}-${crypto.randomBytes(4).toString('hex')}.wav`
    const file = path.join(AUDIO_DIR, name)
    await fs.promises.writeFile(file, wavBuffer)
    const url = `http://127.0.0.1:${PORT}/play/${name}`
    try {
        await eslApi(`uuid_broadcast ${callUuid} ${url} aleg`)
    } catch (err) {
        console.error(`[broadcast] ${callUuid} → ${name} failed: ${err.message}`)
        return
    }
    // Tidy up the WAV after a generous delay — playback is async on the FS
    // side so we can't delete immediately. 60 s covers anything plausible
    // for a single TTS phrase.
    setTimeout(() => fs.promises.unlink(file).catch(() => {}), 60_000).unref()
}

// ── ESL persistent event listener: auto-start audio_fork on CHANNEL_ANSWER ─────
//
// Subscribes once to CHANNEL_ANSWER. For each ANSWER event landing on an
// extension listed in AUTO_FORK_EXTENSIONS, invokes uuid_audio_fork via a
// separate one-shot ESL connection. Reconnects on disconnect with backoff.

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
            // CHANNEL_ANSWER fires BEFORE dialplan exec — at that point
            // destination_number is still the SIP URI piece (e.g. "aeasqqif")
            // for `originate user/103 9999`. Use CHANNEL_PARK: after all
            // dialplan actions land, destination_number is the parked
            // extension (9999) and media is fully up.
            if (eventName !== 'CHANNEL_PARK') return

            const uuid = headers['Unique-ID'] || headers['Channel-Call-UUID']
            if (!uuid) return

            // For `originate user/103 9999 XML default`, the actually-dialed
            // dialplan extension lands in variable_dialed_extension /
            // variable_originate_called_number, while Caller-Destination-Number
            // shows the SIP user URI piece. Check every plausible field.
            const dialedExts = [
                headers['variable_dialed_extension'],
                headers['variable_originate_called_number'],
                headers['variable_destination_number'],
                headers['Caller-Destination-Number'],
            ].filter(Boolean)

            const matched = AUTO_FORK_EXTENSIONS.find(ext => dialedExts.includes(ext))
            console.log(`[esl] CHANNEL_ANSWER uuid=${uuid} dialed=[${dialedExts.join(',')}] matched=${matched ?? 'none'}`)

            if (!matched) return

            // Resolve the call to a CRM-side AI-call session (if any). For
            // live AI-calls created via /api/ai-calls/start, CRM stores the
            // mapping fsUuid → callId+scenario; the bridge fetches it here
            // and constructs a CallSession to drive the dialog.
            //
            // For ad-hoc test calls (extension 9998/9999 without CRM-side
            // session) resolveCallByUuid will return 404 — we still start
            // audio_fork so the operator can verify the audio path, the
            // session just stays null and PCM is logged-only.
            ensureSessionForCall(uuid)
                .catch(err => console.error(`[esl] session bind failed for ${uuid}: ${err.message}`))
                .finally(() => {
                    // Pass call UUID via fork_meta so the WS handler can
                    // route incoming PCM to the right CallSession.
                    const meta = `callUuid=${encodeURIComponent(uuid)}`
                    const forkUrl = `${FORK_WS_URL}?${meta}`
                    const cmd = `uuid_audio_fork ${uuid} start ${forkUrl} mixed 8000 ${meta}`
                    console.log(`[esl] auto-forking audio for ${uuid} (ext ${matched})`)
                    eslApi(cmd)
                        .then(out => console.log(`[esl] auto-fork: ${out}`))
                        .catch(err => console.error(`[esl] auto-fork FAILED: ${err.message}`))
                })
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
            console.log(`[esl-events] subscribed (auto-fork URL: ${FORK_WS_URL}, trigger: CHANNEL_PARK on ${AUTO_FORK_EXTENSIONS.join('/')})`)
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
