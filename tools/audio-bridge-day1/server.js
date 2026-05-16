/**
 * Day 1 AudioBridge — minimal audio roundtrip for AI-call MVP.
 *
 *   FreeSWITCH (mod_audio_fork)  →  WS /audio  (binary PCM in, JSON metadata first)
 *   FreeSWITCH (uuid_broadcast)  ←  HTTP /play/<name>.wav   (playback source)
 *
 * Also exposes control endpoints to drive ESL from a browser/curl during the test:
 *   GET  /test-play/:uuid    — uuid_broadcast <uuid> http://127.0.0.1:3030/play/test.wav aleg
 *   GET  /test-break/:uuid   — uuid_break <uuid>
 *
 * No STT, LLM or TTS in Day 1. Goal: confirm PCM 8kHz mono frames arrive every
 * ~20 ms and that uuid_broadcast plays HTTP-WAV back into the call.
 */

const http = require('http')
const fs = require('fs')
const path = require('path')
const net = require('net')
const { WebSocketServer } = require('ws')

const PORT = Number(process.env.AUDIO_BRIDGE_PORT ?? 3030)
const ESL_HOST = process.env.FS_ESL_HOST ?? '127.0.0.1'
const ESL_PORT = Number(process.env.FS_ESL_PORT ?? 8021)
const ESL_PASS = process.env.ESL_PASSWORD ?? 'ClueCon'
const AUDIO_DIR = path.join(__dirname, 'audio')

// ── HTTP server: serves WAV for uuid_broadcast + control endpoints ─────────────

const httpServer = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url.startsWith('/play/')) {
        const name = path.basename(req.url)
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

httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`[http] listening on :${PORT}`)
})

// ── WebSocket server: receives PCM from mod_audio_fork ─────────────────────────

const wss = new WebSocketServer({ server: httpServer, path: '/audio' })

wss.on('connection', (ws, req) => {
    const remote = `${req.socket.remoteAddress}:${req.socket.remotePort}`
    console.log(`[ws] connected from ${remote}`)

    let metaSeen = false
    let frames = 0
    let bytes = 0
    let firstFrameAt = null
    let lastFrameAt = null
    let lastLogAt = Date.now()
    let warnedSlow = false

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
            console.log(`[ws] first PCM frame: ${data.length} bytes`)
        } else if (!warnedSlow && lastFrameAt && now - lastFrameAt > 50) {
            console.warn(`[ws] WARN slow frame: ${now - lastFrameAt}ms gap (expected ~20ms)`)
            warnedSlow = true
        }
        lastFrameAt = now
        frames++
        bytes += data.length

        // Throttle stats to ~1/sec
        if (now - lastLogAt >= 1000) {
            const elapsedSec = (now - firstFrameAt) / 1000
            console.log(
                `[ws] frames=${frames} bytes=${bytes} ` +
                `fps=${(frames / elapsedSec).toFixed(1)} ` +
                `avg=${(bytes / frames).toFixed(0)}B/frame ` +
                `elapsed=${elapsedSec.toFixed(1)}s`,
            )
            lastLogAt = now
        }
    })

    ws.on('close', code => {
        const elapsedSec = firstFrameAt ? (Date.now() - firstFrameAt) / 1000 : 0
        console.log(
            `[ws] closed code=${code} frames=${frames} bytes=${bytes} ` +
            `dur=${elapsedSec.toFixed(1)}s`,
        )
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

            if (stage === 'authenticating' && buf.includes('+OK accepted')) {
                stage = 'sending'
                buf = ''
                sock.write(`api ${command}\n\n`)
                return
            }

            if (stage === 'sending' && buf.includes('Content-Type: api/response')) {
                // Body comes after Content-Length header + blank line; we wait for it.
                const m = buf.match(/Content-Length: (\d+)\r?\n\r?\n([\s\S]*)/)
                if (m) {
                    const expectedLen = Number(m[1])
                    const body = m[2]
                    if (Buffer.byteLength(body, 'utf8') >= expectedLen) {
                        clearTimeout(timer)
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

// ── Graceful shutdown ──────────────────────────────────────────────────────────

function shutdown(signal) {
    console.log(`[main] ${signal} — shutting down`)
    wss.close(() => {})
    httpServer.close(() => process.exit(0))
    setTimeout(() => process.exit(1), 3000).unref()
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
