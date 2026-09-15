#!/usr/bin/env node
// Isolated audio-runtime probe for the CRM FreeSWITCH image and the AI audio bridge.
//
// Proves, against real containers and without any provider, trunk or phone:
//   S. the probe network is internal, has no host address (isolated gateway mode) and no container
//      on it can reach a host address, the internet or DNS — checked before FreeSWITCH starts;
//   D. the image refuses to start without a real MEGAFON_SIP_PASSWORD;
//   A. the image runs FreeSWITCH 1.10.12 with mod_audio_fork loaded, uuid_audio_fork registered,
//      extensions 9999/9998 installed, existing telephony modules loaded, the module opens no
//      listener, runtime unload is refused, the trunk password reaches FreeSWITCH from the environment; real call audio
//      reaches a WebSocket (8 kHz and 16 kHz), stop and hangup clean up;
//   B. the proven crash inputs (four-argument start, START without arguments, playAudio without a
//      string audioContentType), invalid start arguments, a refused connection and a far end that
//      closes mid-stream neither crash FreeSWITCH nor start anything; a valid playAudio still works;
//   C. with the bridge code under test, a production-shaped originate
//      `originate {origination_uuid=X,...,execute_on_answer='record_session ...'}<callee> 9999 XML default`
//      forks exactly once, after answer, and delivers the callee's own audio to the bound CallSession
//      whether or not the callee sends early media — including a fast answer, a late CRM bind, a
//      rejected call, a hangup while the CRM bind is in flight, an answer after the originating
//      client gave up (as the CRM does after 10 s) and concurrent calls — alongside record_session,
//      with one finalize per call and full cleanup;
//   N. (with --baseline-bridge-dir) the previous bridge never forks the no-early-media call.
//
// Safety: every container is named probe-art-<run>-* and attached only to a fresh internal network
// in isolated gateway mode, so containers have no route to the host or anywhere else. No port is
// published and DNS points at an unroutable resolver. The host talks to FreeSWITCH only through a
// driver container on that network, over `docker exec` stdin/stdout. The ESL and trunk passwords are
// random per run, reach containers through 0600 env files that are deleted at teardown, and are
// never printed. No production image is started and no other container is inspected or modified.
//
// Usage (needs Docker):
//   node telephony/tests/audio_runtime_probe.mjs --image <candidate> --out <dir outside the repo>
//     [--bridge-dir tools/audio-bridge-day1] [--bridge-image crm/audio-bridge:latest]
//     [--baseline-bridge-dir <dir>] [--keep]
//
// PROBE_MODE=sink, PROBE_MODE=bridge-stubs and PROBE_MODE=driver are internal modes used inside
// probe containers.

import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import crypto from 'node:crypto'
import dns from 'node:dns/promises'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'

const MODE = process.env.PROBE_MODE ?? 'run'
const PROBE_PATH = fileURLToPath(import.meta.url)
const REPO_ROOT = path.resolve(path.dirname(PROBE_PATH), '../..')
const CANDIDATE_TONES = [425, 440, 700, 880, 1234]
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// ---- PCM analysis (shared by sink and STT stub) ------------------------------------------------

function goertzelPower(samples, rate, freq) {
    const w = (2 * Math.PI * freq) / rate
    const c = 2 * Math.cos(w)
    let s1 = 0
    let s2 = 0
    for (let i = 0; i < samples.length; i++) {
        const s0 = samples[i] + c * s1 - s2
        s2 = s1
        s1 = s0
    }
    return samples.length ? (s1 * s1 + s2 * s2 - c * s1 * s2) / samples.length : 0
}

// A capture that spans whole periods of a synthetic tone has (numerically) zero energy at the other
// candidate frequencies, so the margin can be very large; the checks only require >= 20 dB.
function analysePcm(buf, rate) {
    const n = Math.floor(buf.length / 2)
    const samples = new Float64Array(n)
    let sumSq = 0
    let nonZero = 0
    for (let i = 0; i < n; i++) {
        const v = buf.readInt16LE(i * 2)
        samples[i] = v
        sumSq += v * v
        if (v !== 0) nonZero++
    }
    const powers = Object.fromEntries(CANDIDATE_TONES.map(f => [f, goertzelPower(samples, rate, f)]))
    const ranked = Object.entries(powers).sort((a, b) => b[1] - a[1])
    const [top, second] = ranked
    return {
        samples: n,
        rms: n ? Math.round(Math.sqrt(sumSq / n)) : 0,
        nonZeroSamples: nonZero,
        dominantHz: top && top[1] > 0 ? Number(top[0]) : null,
        dominantMarginDb: top && second && second[1] > 0 ? Math.round(10 * Math.log10(top[1] / second[1])) : null,
    }
}

// ---- Mode: WebSocket sink (inside a container on the probe network) -----------------------------

async function runSink() {
    const require = createRequire('/app/server.js')
    const { WebSocketServer } = require('ws')
    const outDir = process.env.PROBE_SINK_OUT
    const wss = new WebSocketServer({ port: 8080, path: '/audio' })
    let seq = 0
    wss.on('connection', (ws, req) => {
        const url = new URL(req.url, 'http://sink')
        const label = url.searchParams.get('label') ?? `conn${++seq}`
        const rate = Number(url.searchParams.get('rate') ?? 8000)
        const hostile = url.searchParams.get('hostile') === '1'
        const closeAfter = Number(url.searchParams.get('closeAfter') ?? 0)
        const closeCode = Number(url.searchParams.get('closeCode') ?? 1000)
        const rec = {
            label, url: req.url, callUuid: url.searchParams.get('callUuid'),
            protocolRequested: req.headers['sec-websocket-protocol'] ?? null, protocolNegotiated: ws.protocol || null,
            textFrames: [], binaryFrames: 0, bytes: 0, frameSizes: {}, firstAt: null, lastAt: null, close: null, sentHostile: 0,
        }
        const chunks = []
        ws.on('message', (data, isBinary) => {
            if (!isBinary) { rec.textFrames.push(String(data).slice(0, 200)); return }
            const now = Date.now()
            if (!rec.firstAt) {
                rec.firstAt = now
                if (hostile) sendHostile(ws, rec)
            }
            rec.lastAt = now
            rec.binaryFrames++
            rec.bytes += data.length
            rec.frameSizes[data.length] = (rec.frameSizes[data.length] ?? 0) + 1
            chunks.push(Buffer.from(data))
            if (closeAfter && rec.binaryFrames === closeAfter) ws.close(closeCode, 'probe close')
        })
        ws.on('close', code => {
            rec.close = { code, at: Date.now() }
            const secs = rec.firstAt ? (rec.lastAt - rec.firstAt) / 1000 : 0
            rec.bytesPerSecond = secs > 0 ? Math.round(rec.bytes / secs) : 0
            rec.analysis = analysePcm(Buffer.concat(chunks), rate)
            fs.writeFileSync(path.join(outDir, `${label}.json`), JSON.stringify(rec, null, 1))
        })
    })
    console.log('[probe-sink] listening :8080/audio')
}

// Messages 1-7 reached strcmp(NULL) on the libwebsockets thread before patch 0002 and must now be
// logged and ignored. Messages 8-10 exercise adjacent paths (no data, unknown type, unsupported type).
// Message 11 is a valid raw playAudio: the positive control that the module still writes its temp file.
const HOSTILE_GUARDED_MESSAGES = 7

function sendHostile(ws, rec) {
    const messages = [
        { type: 'playAudio', data: {} },
        { type: 'playAudio', data: { audioContent: 'AAAA', sampleRate: 8000 } },
        { type: 'playAudio', data: { audioContentType: null, audioContent: 'AAAA' } },
        { type: 'playAudio', data: { audioContentType: 8000, audioContent: 'AAAA' } },
        { type: 'playAudio', data: null },
        { type: 'playAudio', data: 'raw' },
        { type: 'playAudio', data: [{ audioContentType: 'raw' }] },
        { type: 'playAudio' },
        { type: 'PlayAudio', data: {} },
        { type: 'playAudio', data: { audioContentType: 'mp3', audioContent: 'AAAA' } },
        { type: 'playAudio', data: { audioContentType: 'raw', sampleRate: 8000, audioContent: Buffer.alloc(1600).toString('base64') } },
    ]
    messages.forEach((message, index) => {
        setTimeout(() => {
            if (ws.readyState === 1) { ws.send(JSON.stringify(message)); rec.sentHostile++ }
        }, 250 * (index + 1))
    })
}

// ---- Mode: bridge provider stubs (preloaded into the bridge process via --import) ---------------

function installBridgeStubs() {
    const require = createRequire('/app/server.js')
    const shared = process.env.PROBE_SHARED
    const stub = (name, exports) => {
        const resolved = require.resolve(`/app/${name}.js`)
        require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports, children: [], paths: [] }
    }
    const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null } }

    stub('crm-client', {
        fetchKeys: async () => ({}),
        resolveCallByUuid: async uuid => {
            const plan = readJson(path.join(shared, 'crm', `${uuid}.json`))
            if (!plan || !plan.bind) throw new Error('HTTP 404')
            if (plan.delayMs) await sleep(plan.delayMs)
            return {
                callId: `probe-${uuid.slice(0, 8)}`,
                scenario: { id: 'probe', name: 'probe', systemPrompt: 'probe', questions: [], greetingVariants: [{ id: 'v1', text: 'probe greeting' }] },
            }
        },
        appendTranscript: async () => {},
        postState: async () => {},
        finalize: async (callId, payload) => {
            fs.appendFileSync(path.join(shared, 'crm', 'finalize.jsonl'),
                JSON.stringify({ callId, callUuid: payload.callUuid, reason: payload.reason }) + '\n')
        },
    })

    stub('stt-router', {
        enabled: () => true,
        describeProvider: () => 'probe-stub',
        createSttSession: ({ callUuid }) => {
            const chunks = []
            let firstAt = null
            let stopped = false
            return {
                async start() {},
                send(buf) { if (!firstAt) firstAt = Date.now(); chunks.push(Buffer.from(buf)) },
                stop() {
                    if (stopped) return
                    stopped = true
                    const pcm = Buffer.concat(chunks)
                    fs.writeFileSync(path.join(shared, 'stt', `${callUuid}.json`),
                        JSON.stringify({ callUuid, bytes: pcm.length, firstAt, analysis: analysePcm(pcm, 8000) }))
                },
            }
        },
    })

    // 1.0 s of 700 Hz, 8 kHz mono 16-bit: the bot's own playback, on the write side of the call.
    const rate = 8000
    const pcm = Buffer.alloc(rate * 2)
    for (let i = 0; i < rate; i++) pcm.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 700 * i) / rate)), i * 2)
    const header = Buffer.alloc(44)
    header.write('RIFF', 0); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVE', 8); header.write('fmt ', 12)
    header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(rate, 24)
    header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36)
    header.writeUInt32LE(pcm.length, 40)
    const wav = Buffer.concat([header, pcm])
    stub('tts-router', { enabled: () => true, describeProvider: () => 'probe-stub', synthesize: async () => wav })

    stub('llm-client', {
        enabled: () => true,
        chatTurn: async () => ({ kind: 'empty' }),
        buildSystemMessage: () => 'probe',
        buildTools: () => [],
        TOOLS: [],
    })
    console.log('[probe] bridge provider stubs installed')
}

// ---- Mode: driver (inside a container on the probe network) ------------------------------------
// The host has no address on the isolated network, so ESL traffic runs here. JSON lines on stdin
// are requests; JSON lines on stdout are replies and forwarded events.

class EslClient {
    constructor(host, password) { this.host = host; this.password = password; this.pending = [] }

    connect(onEvent) {
        return new Promise((resolve, reject) => {
            const sock = net.connect(8021, this.host)
            let buf = ''
            let authed = false
            this.sock = sock
            const failAll = err => { for (const waiter of this.pending.splice(0)) waiter.reject(err) }
            sock.setEncoding('utf8')
            sock.on('error', err => { if (!authed) reject(err); failAll(err) })
            sock.on('close', () => { if (!authed) reject(new Error('ESL closed before auth')); failAll(new Error('ESL connection closed')) })
            sock.on('data', chunk => {
                buf += chunk
                for (;;) {
                    const end = buf.indexOf('\n\n')
                    if (end < 0) return
                    const head = parseHeaders(buf.slice(0, end), false)
                    const length = Number(head['Content-Length'] ?? 0)
                    if (Buffer.byteLength(buf.slice(end + 2)) < length) return
                    const body = buf.slice(end + 2, end + 2 + length)
                    buf = buf.slice(end + 2 + length)
                    const type = head['Content-Type']
                    if (type === 'auth/request') { sock.write(`auth ${this.password}\n\n`); continue }
                    if (type === 'command/reply' && !authed) {
                        if (String(head['Reply-Text']).startsWith('+OK')) { authed = true; resolve(this) } else reject(new Error('ESL auth failed'))
                        continue
                    }
                    if (type === 'api/response' || type === 'command/reply') { this.pending.shift()?.resolve(body || head['Reply-Text'] || ''); continue }
                    if (type === 'text/event-plain' && onEvent) onEvent(parseHeaders(body, true))
                }
            })
        })
    }

    send(line) {
        return new Promise((resolve, reject) => {
            if (!this.sock || this.sock.destroyed) { reject(new Error('ESL not connected')); return }
            this.pending.push({ resolve, reject })
            this.sock.write(`${line}\n\n`)
        })
    }

    close() { this.sock?.destroy() }
}

async function reachability(targets, hostnames) {
    const results = {}
    for (const target of targets) {
        const [host, port] = target.split(':')
        results[target] = await new Promise(resolve => {
            const sock = net.connect({ host, port: Number(port) })
            const timer = setTimeout(() => { sock.destroy(); resolve('TIMEOUT') }, 3000)
            sock.once('connect', () => { clearTimeout(timer); sock.destroy(); resolve('CONNECTED') })
            sock.once('error', err => { clearTimeout(timer); resolve(err.code ?? 'ERROR') })
        })
    }
    for (const hostname of hostnames) {
        try { await dns.lookup(hostname); results[`dns:${hostname}`] = 'RESOLVED' } catch (err) { results[`dns:${hostname}`] = err.code ?? 'ERROR' }
    }
    return results
}

async function runDriver() {
    const password = process.env.PROBE_ESL_PASSWORD
    const connections = new Map()
    const emit = obj => process.stdout.write(`${JSON.stringify(obj)}\n`)
    const input = readline.createInterface({ input: process.stdin })
    input.on('line', async line => {
        let msg
        try { msg = JSON.parse(line) } catch { return }
        const reply = (ok, value) => emit({ id: msg.id, ok, value })
        try {
            if (msg.op === 'connect') {
                const client = new EslClient(msg.host, password)
                await client.connect(msg.events ? headers => emit({ event: msg.conn, headers }) : null)
                connections.set(msg.conn, client)
                reply(true, 'connected')
            } else if (msg.op === 'send') {
                const client = connections.get(msg.conn)
                if (!client) throw new Error('unknown connection')
                reply(true, await client.send(msg.line))
            } else if (msg.op === 'send-abandon') {
                // Like the CRM's ESL client: stop waiting after ms and drop the connection.
                const client = connections.get(msg.conn)
                if (!client) throw new Error('unknown connection')
                const sent = client.send(msg.line)
                sent.catch(() => {})
                const result = await Promise.race([sent.then(value => ({ value })), sleep(msg.ms).then(() => null)])
                if (result) { reply(true, result.value); return }
                client.close()
                connections.delete(msg.conn)
                reply(true, 'ABANDONED')
            } else if (msg.op === 'close') {
                connections.get(msg.conn)?.close()
                connections.delete(msg.conn)
                reply(true, 'closed')
            } else if (msg.op === 'reach') {
                reply(true, await reachability(msg.targets ?? [], msg.hostnames ?? []))
            } else {
                throw new Error(`unknown op ${msg.op}`)
            }
        } catch (err) {
            reply(false, err.message)
        }
    })
    input.on('close', () => { for (const client of connections.values()) client.close(); process.exit(0) })
}

// ---- Host orchestration -----------------------------------------------------------------------------

function docker(args, { allowFail = false, input } = {}) {
    try {
        return execFileSync('docker', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], input }).trim()
    } catch (err) {
        if (allowFail) return null
        throw new Error(`docker ${args[0]} failed: ${String(err.stderr || err.message).trim().slice(0, 300)}`)
    }
}

// Container output: the guard and the bridge write to both stdout and stderr.
function dockerLogs(name) {
    const res = spawnSync('docker', ['logs', name], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
    return res.status === 0 ? `${res.stdout}${res.stderr}` : ''
}

class Driver {
    constructor(container) {
        this.proc = spawn('docker', ['exec', '-i', '-e', 'PROBE_MODE=driver', container, 'node', '/probe/probe.mjs'], { stdio: ['pipe', 'pipe', 'pipe'] })
        this.seq = 0
        this.waiters = new Map()
        this.listeners = new Map()
        this.stderr = ''
        readline.createInterface({ input: this.proc.stdout }).on('line', line => {
            let msg
            try { msg = JSON.parse(line) } catch { return }
            if (msg.event) { this.listeners.get(msg.event)?.(msg.headers); return }
            const waiter = this.waiters.get(msg.id)
            if (!waiter) return
            this.waiters.delete(msg.id)
            clearTimeout(waiter.timer)
            if (msg.ok) waiter.resolve(msg.value)
            else waiter.reject(new Error(msg.value))
        })
        this.proc.stderr.on('data', data => { this.stderr = `${this.stderr}${data}`.slice(-4000) })
        this.proc.on('exit', () => {
            for (const waiter of this.waiters.values()) { clearTimeout(waiter.timer); waiter.reject(new Error('probe driver exited')) }
            this.waiters.clear()
        })
    }

    request(op, payload = {}, timeoutMs = 30000) {
        return new Promise((resolve, reject) => {
            const id = ++this.seq
            const timer = setTimeout(() => { this.waiters.delete(id); reject(new Error(`driver ${op} timed out after ${timeoutMs} ms`)) }, timeoutMs)
            this.waiters.set(id, { resolve, reject, timer })
            this.proc.stdin.write(`${JSON.stringify({ id, op, ...payload })}\n`)
        })
    }

    close() {
        try { this.proc.stdin.end() } catch {}
        try { this.proc.kill() } catch {}
    }
}

class Esl {
    constructor(driver, host) { this.driver = driver; this.host = host; this.conn = `c${crypto.randomBytes(4).toString('hex')}` }

    async connect(onEvent) {
        if (onEvent) this.driver.listeners.set(this.conn, onEvent)
        await this.driver.request('connect', { conn: this.conn, host: this.host, events: Boolean(onEvent) }, 10000)
        return this
    }

    send(line, timeoutMs = 30000) { return this.driver.request('send', { conn: this.conn, line }, timeoutMs) }

    api(command, timeoutMs = 30000) { return this.send(`api ${command}`, timeoutMs).then(out => String(out).trim()) }

    apiAbandonAfter(command, ms) {
        return this.driver.request('send-abandon', { conn: this.conn, line: `api ${command}`, ms }, ms + 30000).then(out => String(out).trim())
    }

    close() {
        this.driver.listeners.delete(this.conn)
        return this.driver.request('close', { conn: this.conn }, 5000).catch(() => {})
    }
}

function parseHeaders(text, decode) {
    const out = {}
    for (const line of String(text).split('\n')) {
        const i = line.indexOf(': ')
        if (i > 0) out[line.slice(0, i)] = decode ? safeDecode(line.slice(i + 2)) : line.slice(i + 2)
    }
    return out
}

function safeDecode(value) { try { return decodeURIComponent(value) } catch { return value } }

function sha256File(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') }

function bridgeFiles(dir) {
    return Object.fromEntries(fs.readdirSync(dir).filter(f => f.endsWith('.js')).sort().map(f => [f, sha256File(path.join(dir, f))]))
}

function parseArgs(argv) {
    const args = { bridgeDir: 'tools/audio-bridge-day1', bridgeImage: 'crm/audio-bridge:latest', keep: false }
    for (let i = 0; i < argv.length; i++) {
        const key = argv[i]
        const next = () => argv[++i]
        if (key === '--image') args.image = next()
        else if (key === '--out') args.out = next()
        else if (key === '--bridge-dir') args.bridgeDir = next()
        else if (key === '--bridge-image') args.bridgeImage = next()
        else if (key === '--baseline-bridge-dir') args.baselineBridgeDir = next()
        else if (key === '--keep') args.keep = true
        else throw new Error(`unknown argument ${key}`)
    }
    if (!args.image || !args.out) throw new Error('--image and --out are required')
    args.out = path.resolve(args.out)
    const insideRepo = path.relative(REPO_ROOT, args.out)
    if (!insideRepo.startsWith('..') && !path.isAbsolute(insideRepo)) throw new Error('--out must be outside the repository')
    args.bridgeDir = path.resolve(REPO_ROOT, args.bridgeDir)
    if (args.baselineBridgeDir) args.baselineBridgeDir = path.resolve(args.baselineBridgeDir)
    return args
}

const CALLEE_DIALPLAN = `<include>
  <!-- probe-only simulated callees; the B-leg inherits originate variables, so unset record_session -->
  <extension name="probe_callee_early_media"><condition field="destination_number" expression="^5556$">
    <action application="unset" data="execute_on_answer"/>
    <action application="pre_answer"/>
    <action application="playback" data="tone_stream://%(400,200,425);loops=6"/>
    <action application="answer"/>
    <action application="playback" data="tone_stream://%(9000,0,1234)"/>
    <action application="hangup"/>
  </condition></extension>
  <extension name="probe_callee_no_early_media"><condition field="destination_number" expression="^5557$">
    <action application="unset" data="execute_on_answer"/>
    <action application="sleep" data="2000"/>
    <action application="answer"/>
    <action application="playback" data="tone_stream://%(9000,0,1234)"/>
    <action application="hangup"/>
  </condition></extension>
  <extension name="probe_callee_fast_answer"><condition field="destination_number" expression="^5558$">
    <action application="unset" data="execute_on_answer"/>
    <action application="pre_answer"/>
    <action application="sleep" data="200"/>
    <action application="answer"/>
    <action application="playback" data="tone_stream://%(9000,0,1234)"/>
    <action application="hangup"/>
  </condition></extension>
  <extension name="probe_callee_rejects"><condition field="destination_number" expression="^5559$">
    <action application="unset" data="execute_on_answer"/>
    <action application="pre_answer"/>
    <action application="playback" data="tone_stream://%(400,200,425);loops=3"/>
    <action application="hangup" data="CALL_REJECTED"/>
  </condition></extension>
  <extension name="probe_callee_slow_no_early_media"><condition field="destination_number" expression="^5560$">
    <action application="unset" data="execute_on_answer"/>
    <action application="sleep" data="12000"/>
    <action application="answer"/>
    <action application="playback" data="tone_stream://%(9000,0,1234)"/>
    <action application="hangup"/>
  </condition></extension>
  <extension name="probe_callee_no_early_media_880"><condition field="destination_number" expression="^5561$">
    <action application="unset" data="execute_on_answer"/>
    <action application="sleep" data="1500"/>
    <action application="answer"/>
    <action application="playback" data="tone_stream://%(9000,0,880)"/>
    <action application="hangup"/>
  </condition></extension>
  <extension name="probe_callee_no_early_media_440"><condition field="destination_number" expression="^5562$">
    <action application="unset" data="execute_on_answer"/>
    <action application="sleep" data="1000"/>
    <action application="answer"/>
    <action application="playback" data="tone_stream://%(9000,0,440)"/>
    <action application="hangup"/>
  </condition></extension>
</include>
`

function megafonHostnames() {
    const text = fs.readFileSync(path.join(REPO_ROOT, 'telephony/conf/sip_profiles/external/megafon.xml'), 'utf8')
    const names = new Set()
    for (const param of ['proxy', 'realm', 'outbound-proxy']) {
        const match = text.match(new RegExp(`<param\\s+name="${param}"\\s+value="([^"]+)"`))
        if (match) names.add(match[1].replace(/^sips?:/, '').split(/[:;]/)[0])
    }
    return [...names].filter(name => /[a-z]/i.test(name))
}

async function runProbe() {
    const args = parseArgs(process.argv.slice(2))
    const run = crypto.randomBytes(3).toString('hex')
    const prefix = `probe-art-${run}`
    const out = args.out
    const shared = path.join(out, 'shared')
    for (const dir of ['crm', 'stt', 'tts', 'sink']) fs.mkdirSync(path.join(shared, dir), { recursive: true })
    fs.chmodSync(shared, 0o777)
    for (const dir of ['crm', 'stt', 'tts', 'sink']) fs.chmodSync(path.join(shared, dir), 0o777)
    const eslPassword = crypto.randomBytes(24).toString('hex')
    const trunkPassword = `probe${crypto.randomBytes(12).toString('hex')}`
    const secretDir = fs.mkdtempSync(path.join(out, '.probe-secrets-'))
    fs.chmodSync(secretDir, 0o700)
    const envFile = (name, entries) => {
        const file = path.join(secretDir, name)
        fs.writeFileSync(file, entries.map(([k, v]) => `${k}=${v}\n`).join(''), { mode: 0o600 })
        return file
    }
    const fsEnv = envFile('fs.env', [['ESL_PASSWORD', eslPassword], ['MEGAFON_SIP_PASSWORD', trunkPassword]])
    const eslEnv = envFile('esl.env', [['ESL_PASSWORD', eslPassword], ['PROBE_ESL_PASSWORD', eslPassword]])

    const results = []
    const created = []
    const provenance = {
        started_at: new Date().toISOString(),
        node: process.version,
        probe_sha256: sha256File(PROBE_PATH),
        git_head: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).stdout.trim() || null,
        git_dirty_paths: spawnSync('git', ['status', '--porcelain'], { cwd: REPO_ROOT, encoding: 'utf8' }).stdout.split('\n').filter(Boolean).length,
        candidate_image: args.image,
        candidate_image_id: docker(['image', 'inspect', args.image, '--format', '{{.Id}}'], { allowFail: true }),
        bridge_image: args.bridgeImage,
        bridge_image_id: docker(['image', 'inspect', args.bridgeImage, '--format', '{{.Id}}'], { allowFail: true }),
        bridge_dir_files: bridgeFiles(args.bridgeDir),
        baseline_bridge_dir_files: args.baselineBridgeDir ? bridgeFiles(args.baselineBridgeDir) : null,
    }
    const check = (id, name, pass, detail = '') => {
        results.push({ id, name, pass: Boolean(pass), detail })
        console.log(`${pass ? 'PASS' : 'FAIL'} ${id} ${name}${detail ? ` — ${detail}` : ''}`)
    }

    const network = `${prefix}-net`
    let driver = null
    let tornDown = false
    const teardown = () => {
        if (tornDown) return
        tornDown = true
        driver?.close()
        fs.rmSync(secretDir, { recursive: true, force: true })
        if (args.keep) return
        for (const name of [...created].reverse()) docker(['rm', '-f', name], { allowFail: true })
        docker(['network', 'rm', network], { allowFail: true })
    }
    const onSignal = signal => { console.log(`probe interrupted by ${signal}; tearing down`); teardown(); process.exit(130) }
    process.once('SIGINT', onSignal)
    process.once('SIGTERM', onSignal)

    const runContainer = (name, extra) => {
        created.push(name)
        docker(['run', '-d', '--name', name, '--label', 'io.yoko.probe=audio-runtime', '--network', network, '--dns', '127.0.0.254', ...extra])
    }
    const fsName = `${prefix}-fs`

    try {
        // ---- S: isolation, proven before any FreeSWITCH container starts ----------------------------
        let subnet = null
        for (let third = 240; third < 255 && !subnet; third++) {
            const candidate = `172.31.${third}.0/24`
            if (docker(['network', 'create', '--internal', '-o', 'com.docker.network.bridge.gateway_mode_ipv4=isolated',
                '--subnet', candidate, '--label', 'io.yoko.probe=audio-runtime', network], { allowFail: true }) !== null) subnet = candidate
        }
        if (!subnet) throw new Error('could not create an isolated network')
        const base = subnet.replace('.0/24', '')
        const ip = { fs: `${base}.10`, control: `${base}.11`, sink: `${base}.20`, bridge: `${base}.30`, driver: `${base}.40` }
        const netInfo = JSON.parse(docker(['network', 'inspect', network]))[0]
        const bridgeIface = `br-${netInfo.Id.slice(0, 12)}`
        const hostAddr = spawnSync('ip', ['-4', '-o', 'addr', 'show', 'dev', bridgeIface], { encoding: 'utf8' }).stdout.trim()
        provenance.network = { subnet, internal: netInfo.Internal, options: netInfo.Options, host_ipv4_on_bridge: hostAddr !== '' }
        const isolated = netInfo.Internal === true && netInfo.Options?.['com.docker.network.bridge.gateway_mode_ipv4'] === 'isolated' && hostAddr === ''
        check('S1', 'probe network is internal with no host address (isolated gateway)', isolated, `${subnet} ${bridgeIface}`)
        if (!isolated) throw new Error('refusing to continue without an isolated network')

        runContainer(`${prefix}-driver`, ['--ip', ip.driver, '--memory', '256m', '--env-file', eslEnv,
            '-v', `${PROBE_PATH}:/probe/probe.mjs:ro`, '--entrypoint', 'sleep', args.bridgeImage, 'infinity'])
        driver = new Driver(`${prefix}-driver`)
        const offSubnet = ['172.17.0.1:8021', '172.17.0.1:5060', '1.1.1.1:443', '8.8.8.8:53']
        const gateway = [`${base}.1:8021`, `${base}.1:5060`, `${base}.1:5080`, `${base}.1:7080`, `${base}.1:22`]
        const hostnames = megafonHostnames()
        const reach = await driver.request('reach', { targets: [...gateway, ...offSubnet], hostnames: [...hostnames, 'example.com'] }, 60000)
        const unreachable = code => ['ENETUNREACH', 'EHOSTUNREACH', 'TIMEOUT'].includes(code)
        const reachOk = Object.values(reach).every(v => v !== 'CONNECTED' && v !== 'RESOLVED')
            && offSubnet.every(t => unreachable(reach[t])) && hostnames.length > 0
        provenance.reachability = reach
        check('S2', 'no probe container can reach the host, the internet or the trunk hostname', reachOk,
            Object.entries(reach).map(([k, v]) => `${k}=${v}`).join(' '))
        if (!reachOk) throw new Error('refusing to continue: the probe network is not isolated')

        // ---- D: the image refuses to start without a real trunk password -------------------------
        for (const [id, label, value] of [['D1', 'missing', null], ['D2', 'placeholder', '__FILL_LATER__']]) {
            const name = `${prefix}-guard-${label}`
            const env = value === null ? [] : ['-e', `MEGAFON_SIP_PASSWORD=${value}`]
            runContainer(name, ['--memory', '256m', ...env, args.image])
            let state = null
            for (let i = 0; i < 40; i++) {
                state = JSON.parse(docker(['inspect', name]))[0].State
                if (state.Status === 'exited') break
                await sleep(250)
            }
            const logs = dockerLogs(name)
            check(id, `image refuses to start with a ${label} MEGAFON_SIP_PASSWORD`,
                state.Status === 'exited' && state.ExitCode === 64 && logs.includes('refusing to start') && (value === null || !logs.includes(value)),
                `status=${state.Status} exit=${state.ExitCode}`)
        }

        // ---- A: runtime ------------------------------------------------------------------------------
        const callees = path.join(out, '97_probe_callees.xml')
        fs.writeFileSync(callees, CALLEE_DIALPLAN)
        runContainer(fsName, ['--ip', ip.fs, '--memory', '768m', '--env-file', fsEnv, '-v', `${shared}:/shared`, args.image])
        let esl = null
        let up = false
        for (let i = 0; i < 90 && !up; i++) {
            try {
                const attempt = new Esl(driver, ip.fs)
                await attempt.connect()
                up = (await attempt.api('status')).includes('UP')
                if (up) esl = attempt
                else await attempt.close()
            } catch { await sleep(1000) }
        }
        check('A1', 'FreeSWITCH starts and answers ESL', up)
        if (!up) throw new Error('FreeSWITCH did not start')
        const startedAt = () => JSON.parse(docker(['inspect', fsName]))[0].State
        const initialState = startedAt()
        const alive = async () => {
            const s = startedAt()
            const status = await esl.api('status').catch(() => '')
            return s.Running && s.StartedAt === initialState.StartedAt && s.RestartCount === initialState.RestartCount && status.includes('UP')
        }
        const version = await esl.api('version')
        check('A2', 'FreeSWITCH is 1.10.12 a88d069d', version.includes('1.10.12') && version.includes('a88d069'), version.split('\n')[0])
        check('A3', 'mod_audio_fork is loaded', (await esl.api('module_exists mod_audio_fork')) === 'true')
        const showApi = await esl.api('show api')
        check('A4', 'uuid_audio_fork is registered with the expected grammar',
            showApi.includes('uuid_audio_fork,audio_fork API,<uuid> [start | stop | send_text | pause | resume | graceful-shutdown ]'))
        const dialplan = await esl.api('xml_locate dialplan')
        check('A5', 'extensions 9999 and 9998 are loaded', dialplan.includes('expression="^9999$"') && dialplan.includes('expression="^9998$"'))
        const required = ['mod_sofia', 'mod_event_socket', 'mod_loopback', 'mod_dptools', 'mod_commands', 'mod_dialplan_xml', 'mod_tone_stream', 'mod_sndfile', 'mod_native_file']
        const missing = []
        for (const m of required) if ((await esl.api(`module_exists ${m}`)) !== 'true') missing.push(m)
        check('A6', 'existing telephony modules still load', missing.length === 0, missing.join(',') || `${required.length} modules`)
        const label = JSON.parse(docker(['inspect', args.image]))[0].Config.Labels['io.yoko.telephony.mod_audio_fork.sha256']
        const installed = docker(['exec', fsName, 'sha256sum', '/usr/lib/freeswitch/mod/mod_audio_fork.so']).split(/\s+/)[0]
        check('A7', 'installed module matches the image provenance label', label && installed === label, installed)

        // Control: the same image with the pinned base image's modules.conf.xml, i.e. without mod_audio_fork.
        // Docker's embedded DNS (127.0.0.11) listens on random ports per container; it is not FreeSWITCH.
        const listeners = name => new Set(docker(['exec', name, 'busybox', 'netstat', '-lntu']).split('\n')
            .filter(l => /^(tcp|udp)/.test(l)).map(l => l.split(/\s+/)).map(p => `${p[0]} ${p[3]}`).filter(l => !l.includes('127.0.0.11:')))
        const runtimeRef = fs.readFileSync(path.join(REPO_ROOT, 'telephony/Dockerfile'), 'utf8').match(/^ARG FREESWITCH_RUNTIME="([^"]+)"$/m)[1]
        const controlModules = path.join(out, 'control-modules.conf.xml')
        fs.writeFileSync(controlModules, `${docker(['run', '--rm', '--network', 'none', '--entrypoint', 'cat', runtimeRef,
            '/usr/share/freeswitch/conf/vanilla/autoload_configs/modules.conf.xml'])}\n`)
        fs.chmodSync(controlModules, 0o644)
        runContainer(`${prefix}-control`, ['--ip', ip.control, '--memory', '512m', '--env-file', fsEnv,
            '-v', `${controlModules}:/usr/share/freeswitch/conf/vanilla/autoload_configs/modules.conf.xml:ro`, args.image])
        let control = null
        for (let i = 0; i < 90 && !control; i++) {
            try {
                const attempt = new Esl(driver, ip.control)
                await attempt.connect()
                if ((await attempt.api('status')).includes('UP')) control = attempt
                else await attempt.close()
            } catch { await sleep(1000) }
        }
        const controlWithoutModule = control ? (await control.api('module_exists mod_audio_fork')) === 'false' : false
        await control?.close()
        const candidateListeners = listeners(fsName)
        const controlListeners = control ? listeners(`${prefix}-control`) : new Set()
        const added = [...candidateListeners].filter(l => !controlListeners.has(l))
        check('A8', 'mod_audio_fork opens no listener (same sockets as the image without the module)',
            Boolean(control) && controlWithoutModule && !fs.readFileSync(controlModules, 'utf8').includes('mod_audio_fork') && added.length === 0,
            added.join(',') || `${candidateListeners.size} listeners, control without module=${controlWithoutModule}`)
        docker(['rm', '-f', `${prefix}-control`], { allowFail: true })

        const unload = await esl.api('unload mod_audio_fork')
        const reload = await esl.api('reload mod_audio_fork')
        await sleep(1000)
        // "reload" reports "+OK Reloading XML" even though its unload step is refused; what matters is
        // that the module was never torn down and FreeSWITCH did not abort.
        check('A14', 'unload of mod_audio_fork is refused, reload does not tear it down, FreeSWITCH stays up (upstream teardown aborts)',
            unload.startsWith('-ERR') && unload.includes('not unloadable')
                && (await esl.api('module_exists mod_audio_fork')) === 'true' && await alive(),
            `unload=${unload.slice(0, 40)} reload=${reload.slice(0, 40)}`)

        const trunkGlobal = await esl.api('global_getvar megafon_password')
        const gatewayStatus = await esl.api('sofia status gateway megafon')
        check('A13', 'the trunk password reaches FreeSWITCH from MEGAFON_SIP_PASSWORD (compared, never printed)',
            trunkGlobal === trunkPassword && /Password\s+yes/.test(gatewayStatus))

        docker(['cp', callees, `${fsName}:/etc/freeswitch/dialplan/default/97_probe_callees.xml`])
        await esl.api('reloadxml')

        runContainer(`${prefix}-sink`, ['--ip', ip.sink, '--memory', '256m', '-e', 'PROBE_MODE=sink', '-e', 'PROBE_SINK_OUT=/shared/sink',
            '-v', `${shared}:/shared`, '-v', `${PROBE_PATH}:/probe/probe.mjs:ro`,
            '--entrypoint', 'node', args.bridgeImage, '/probe/probe.mjs'])
        await sleep(1500)
        const sinkUrl = `ws://${ip.sink}:8080/audio`
        const sinkResult = async name => {
            for (let i = 0; i < 40; i++) {
                const file = path.join(shared, 'sink', `${name}.json`)
                if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'))
                await sleep(250)
            }
            return null
        }

        // A loopback call whose leg in <ext> READS a tone, as a PSTN leg reads the remote party.
        const toneCall = async (ext, hz, ms) => {
            const a = crypto.randomUUID()
            await esl.api(`bgapi originate {origination_uuid=${a},loopback_bowout=false}loopback/${ext}/default &playback(tone_stream://%(${ms},0,${hz}))`)
            for (let i = 0; i < 50; i++) {
                const rows = JSON.parse(extractJson(await esl.api('show channels as json'))).rows ?? []
                const b = rows.find(r => r.uuid !== a && r.dest === String(ext))
                if (b) { await sleep(1200); return { a, b: b.uuid } }
                await sleep(100)
            }
            throw new Error(`no ${ext} leg appeared`)
        }
        const bugs = async uuid => [...(await esl.api(`uuid_buglist ${uuid}`)).matchAll(/<function>([^<]*)<\/function>/g)].map(m => m[1])
        const hangup = async (...uuids) => { for (const u of uuids) await esl.api(`uuid_kill ${u}`); await sleep(1500) }
        const channelCount = async () => Number((await esl.api('show channels count')).match(/(\d+) total/)?.[1] ?? -1)
        const forkConnections = async port => docker(['exec', fsName, 'busybox', 'netstat', '-nt']).split('\n').filter(l => l.includes(`:${port} `) && l.includes('ESTABLISHED')).length

        {
            const { a, b } = await toneCall(9999, 440, 9000)
            const reply = await esl.api(`uuid_audio_fork ${b} start ${sinkUrl}?callUuid=${b}&label=m1 mono 8000 callUuid=${b}`)
            await sleep(3000)
            const during = await bugs(b)
            const stop = await esl.api(`uuid_audio_fork ${b} stop callUuid=${b}`)
            await sleep(1000)
            const after = await bugs(b)
            const stillUp = (await esl.api(`uuid_exists ${b}`)) === 'true'
            await hangup(a, b)
            const r = await sinkResult('m1')
            const sizesOk = r && Object.keys(r.frameSizes).every(size => Number(size) % 320 === 0)
            check('A9', 'bridge fork grammar streams real 8 kHz mono PCM of the call',
                reply.startsWith('+OK') && r && r.binaryFrames > 50 && sizesOk && r.analysis.nonZeroSamples > 0.9 * r.analysis.samples
                    && r.analysis.dominantHz === 440 && r.analysis.dominantMarginDb >= 20 && Math.abs(r.bytesPerSecond - 16000) < 1000
                    && r.protocolNegotiated === 'audio.drachtio.org' && r.callUuid === b,
                r && `frames=${r.binaryFrames} B/s=${r.bytesPerSecond} dominant=${r.analysis.dominantHz}Hz margin>=20dB:${r.analysis.dominantMarginDb >= 20}`)
            check('A10', 'stop by bug name removes the fork, keeps the call and closes the socket cleanly',
                during.includes(`callUuid=${b}`) && stop.startsWith('+OK') && after.length === 0 && stillUp && r?.close?.code === 1000)
        }
        {
            const { a, b } = await toneCall(9999, 440, 9000)
            await esl.api(`uuid_audio_fork ${b} start ${sinkUrl}?callUuid=${b}&label=m16&rate=16000 mono 16000 callUuid=${b}`)
            await sleep(3000)
            await hangup(a, b)
            const r = await sinkResult('m16')
            check('A11', '16 kHz resampler path delivers 16 kHz PCM of the call',
                r && r.analysis.dominantHz === 440 && Math.abs(r.bytesPerSecond - 32000) < 2000 && Object.keys(r.frameSizes).every(s => Number(s) % 640 === 0),
                r && `B/s=${r.bytesPerSecond} dominant=${r.analysis.dominantHz}Hz`)
        }
        {
            const { a, b } = await toneCall(9999, 440, 9000)
            await esl.api(`uuid_audio_fork ${b} start ${sinkUrl}?callUuid=${b}&label=mh mono 8000 callUuid=${b}`)
            await sleep(2000)
            const during = await forkConnections(8080)
            await hangup(b)
            await hangup(a)
            const r = await sinkResult('mh')
            check('A12', 'hangup without stop closes the socket and leaves no channel or connection',
                during >= 1 && r?.close?.code === 1000 && (await channelCount()) === 0 && (await forkConnections(8080)) === 0)
        }

        // ---- B: crash hardening --------------------------------------------------------------------
        const fsLogCount = needle => {
            const consoleCount = dockerLogs(fsName).split(needle).length - 1
            const fileCount = Number(docker(['exec', fsName, 'sh', '-c', `grep -c '${needle}' /var/log/freeswitch/freeswitch.log 2>/dev/null; true`], { allowFail: true }) ?? 0) || 0
            return Math.max(consoleCount, fileCount)
        }
        const tempDir = await esl.api('global_getvar temp_dir')
        const tempFileCount = uuid => docker(['exec', fsName, 'sh', '-c', `ls ${tempDir}/${uuid}_*.tmp.r8 2>/dev/null | wc -l`], { allowFail: true })
        {
            const { a, b } = await toneCall(9999, 440, 30000)
            const four = await esl.api(`uuid_audio_fork ${b} start ${sinkUrl}?callUuid=${b}&label=b4 mono`)
            await sleep(2000)
            const fourBugs = await bugs(b)
            await esl.api(`uuid_audio_fork ${b} stop`)
            await sleep(800)
            const b4 = await sinkResult('b4')
            check('B1', 'four-argument start does not crash and streams at the default 8000 Hz',
                four.startsWith('+OK') && fourBugs.includes('audio_fork') && await alive() && (await esl.api(`uuid_exists ${b}`)) === 'true'
                    && b4 && Math.abs(b4.bytesPerSecond - 16000) < 1000,
                b4 && `B/s=${b4.bytesPerSecond}`)
            const upper = await esl.api(`uuid_audio_fork ${b} START ${sinkUrl}`)
            const upper2 = await esl.api(`uuid_audio_fork ${b} Start`)
            check('B2', 'START with too few arguments returns usage instead of crashing',
                upper.startsWith('-USAGE') && upper2.startsWith('-USAGE') && await alive())
            const guardNeedle = 'playAudio request has no string audioContentType, ignoring'
            const guardedBefore = fsLogCount(guardNeedle)
            await esl.api(`uuid_audio_fork ${b} start ${sinkUrl}?callUuid=${b}&label=bh&hostile=1 mono 8000 hostile`)
            await sleep(4500)
            const hostileAlive = await alive()
            const stillStreaming = (await bugs(b)).includes('hostile')
            const filesDuring = tempFileCount(b)
            await esl.api(`uuid_audio_fork ${b} stop hostile`)
            await sleep(800)
            const filesAfter = tempFileCount(b)
            const guarded = fsLogCount(guardNeedle) - guardedBefore
            const r = await sinkResult('bh')
            check('B3', 'playAudio without a string audioContentType is logged and ignored; a valid playAudio still writes its file, removed on stop',
                hostileAlive && stillStreaming && r?.sentHostile === 11 && r.binaryFrames > 100 && guarded >= HOSTILE_GUARDED_MESSAGES
                    && filesDuring !== null && Number(filesDuring) >= 1 && filesAfter === '0',
                r && `sent=${r.sentHostile} guardedLogLines=${guarded} tempFiles=${filesDuring}->${filesAfter} frames=${r.binaryFrames}`)
            await esl.api(`uuid_audio_fork ${b} start ws://${ip.sink}:9/audio mono 8000 refused`)
            await sleep(3000)
            check('B4', 'a refused connection does not crash FreeSWITCH', await alive() && (await esl.api(`uuid_exists ${b}`)) === 'true')
            await esl.api(`uuid_audio_fork ${b} stop refused`).catch(() => '')
            for (const code of [1000, 1011]) {
                await esl.api(`uuid_audio_fork ${b} start ${sinkUrl}?callUuid=${b}&label=bc${code}&closeAfter=50&closeCode=${code} mono 8000 close${code}`)
                await sleep(2500)
            }
            const closes = [await sinkResult('bc1000'), await sinkResult('bc1011')]
            check('B5', 'a far end closing mid-stream (1000 and 1011) does not crash FreeSWITCH',
                await alive() && (await esl.api(`uuid_exists ${b}`)) === 'true' && closes[0]?.close?.code === 1000 && closes[1]?.close?.code === 1011,
                `close=${closes.map(c => c?.close?.code).join('/')}`)
            const invalid = [
                ['neg', `${sinkUrl}?label=neg mono -8000 neg`],
                ['big', `${sinkUrl}?label=big mono 2147480000 big`],
                ['zero', `${sinkUrl}?label=zero mono abc zero`],
                ['badurl', 'not-a-url mono 8000 badurl'],
            ]
            const replies = []
            for (const [tag, rest] of invalid) replies.push([tag, await esl.api(`uuid_audio_fork ${b} start ${rest}`)])
            await sleep(1500)
            const afterInvalid = await bugs(b)
            check('B6', 'start with an invalid sampling rate or URL returns -ERR and starts nothing',
                replies.every(([, reply]) => reply.startsWith('-ERR')) && !afterInvalid.some(n => invalid.some(([tag]) => tag === n))
                    && await alive() && (await esl.api(`uuid_exists ${b}`)) === 'true',
                replies.map(([tag, reply]) => `${tag}:${reply.slice(0, 4)}`).join(' '))
            await hangup(a, b)
        }

        // ---- C: call lifecycle with the bridge code under test ---------------------------------------
        const shared_ = { args, esl, driver, fsName, shared, ip, prefix, runContainer, bugs, channelCount, forkConnections, check, alive, eslEnv }
        await runLifecycle({ ...shared_, bridgeDir: args.bridgeDir, idPrefix: 'C' })
        if (args.baselineBridgeDir) await runLifecycle({ ...shared_, bridgeDir: args.baselineBridgeDir, idPrefix: 'N', negativeControl: true })
        check('Z1', 'FreeSWITCH never restarted during the probe', await alive())
        await esl.close()
    } catch (err) {
        check('X', 'probe aborted', false, err.message)
    } finally {
        provenance.finished_at = new Date().toISOString()
        fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ run, provenance, results }, null, 1))
        teardown()
    }
    const failed = results.filter(r => !r.pass)
    console.log(`${results.length - failed.length}/${results.length} PASS`)
    process.exitCode = failed.length ? 1 : 0
}

function extractJson(text) {
    const i = text.indexOf('{')
    return i >= 0 ? text.slice(i) : '{}'
}

async function runLifecycle(ctx) {
    const { args, esl, driver, fsName, shared, ip, prefix, runContainer, bugs, channelCount, forkConnections, check, alive, bridgeDir, idPrefix, eslEnv, negativeControl } = ctx
    const bridgeName = `${prefix}-bridge-${idPrefix.toLowerCase()}`
    const mounts = fs.readdirSync(bridgeDir).filter(f => f.endsWith('.js'))
        .flatMap(f => ['-v', `${path.join(bridgeDir, f)}:/app/${f}:ro`])
    runContainer(bridgeName, ['--ip', ip.bridge, '--memory', '384m', ...mounts, '--env-file', eslEnv,
        '-v', `${shared}:/shared`, '-v', `${PROBE_PATH}:/probe/probe.mjs:ro`,
        '-e', 'PROBE_MODE=bridge-stubs', '-e', 'PROBE_SHARED=/shared',
        '-e', `FS_ESL_HOST=${ip.fs}`, '-e', 'FS_ESL_PORT=8021',
        '-e', 'AUDIO_BRIDGE_PORT=3030', '-e', `BRIDGE_LAN_IP=${ip.bridge}`,
        '-e', 'BRIDGE_AUDIO_DIR=/shared/tts', '-e', 'BRIDGE_AUDIO_DIR_FS=/shared/tts', '-e', 'CRM_BASE_URL=http://127.0.0.254:9',
        '--entrypoint', 'node', args.bridgeImage, '--import', '/probe/probe.mjs', '/app/server.js'])
    let subscribed = false
    for (let i = 0; i < 40 && !subscribed; i++) {
        subscribed = dockerLogs(bridgeName).includes('[esl-events] subscribed')
        if (!subscribed) await sleep(500)
    }
    const bridgeLog = () => dockerLogs(bridgeName)
    check(`${idPrefix}0`, 'bridge under test starts and subscribes to FreeSWITCH events', subscribed)
    if (!subscribed) {
        fs.writeFileSync(path.join(shared, `${bridgeName}.log`), bridgeLog())
        docker(['rm', '-f', bridgeName], { allowFail: true })
        return
    }
    const events = []
    const observer = new Esl(driver, ip.fs)
    await observer.connect(e => events.push({ ...e, seenAt: Date.now() }))
    await observer.send('event plain CHANNEL_PARK CHANNEL_ANSWER CHANNEL_HANGUP_COMPLETE MEDIA_BUG_START PLAYBACK_START')

    const originate = async (callee, { bind = true, delayMs = 0, abandonAfterMs = 0 } = {}) => {
        const x = crypto.randomUUID()
        fs.writeFileSync(path.join(shared, 'crm', `${x}.json`), JSON.stringify({ bind, delayMs }))
        const vars = `origination_uuid=${x},origination_caller_id_name='AI Assistant',RECORD_STEREO=true,recording_follow_transfer=true,`
            + `recording_file=/var/lib/freeswitch/recordings/${x}.wav,execute_on_answer='record_session /var/lib/freeswitch/recordings/${x}.wav'`
        const command = `originate {${vars}}loopback/${callee}/default 9999 XML default`
        const t0 = Date.now()
        let reply
        if (abandonAfterMs) {
            const client = new Esl(driver, ip.fs)
            await client.connect()
            reply = await client.apiAbandonAfter(command, abandonAfterMs)
        } else {
            reply = await esl.api(command, 45000)
        }
        return { x, reply, originateMs: Date.now() - t0 }
    }
    const waitForHangup = async (x, timeoutMs = 25000) => {
        const until = Date.now() + timeoutMs
        while (Date.now() < until) {
            if (events.some(e => e['Event-Name'] === 'CHANNEL_HANGUP_COMPLETE' && e['Unique-ID'] === x)) return true
            await sleep(250)
        }
        return false
    }
    const forkLines = x => bridgeLog().split('\n').filter(l => l.includes(`auto-forking audio for ${x}`))
    const finalizes = x => {
        const file = path.join(shared, 'crm', 'finalize.jsonl')
        if (!fs.existsSync(file)) return []
        return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(f => f.callUuid === x)
    }
    const sttResult = x => { try { return JSON.parse(fs.readFileSync(path.join(shared, 'stt', `${x}.json`), 'utf8')) } catch { return null } }
    const recordingBytes = x => Number(docker(['exec', fsName, 'sh', '-c', `stat -c %s /var/lib/freeswitch/recordings/${x}.wav 2>/dev/null || echo 0`], { allowFail: true }) ?? 0)
    const eventOrder = x => events.filter(e => e['Unique-ID'] === x && ['CHANNEL_PARK', 'CHANNEL_ANSWER'].includes(e['Event-Name']))
        .map(e => `${e['Event-Name'].replace('CHANNEL_', '')}(${e['Caller-Destination-Number']},${e['Answer-State']})`).join(' ')
    // Gating from FreeSWITCH's own events, independent of the bridge's log: exactly one media bug named
    // callUuid=<x> started, not before the channel was answered, and no playback before answer.
    const stamp = e => Number(e['Event-Date-Timestamp'] ?? 0)
    const gating = x => {
        const answer = events.find(e => e['Event-Name'] === 'CHANNEL_ANSWER' && e['Unique-ID'] === x)
        const forkBugs = events.filter(e => e['Event-Name'] === 'MEDIA_BUG_START' && e['Unique-ID'] === x && Object.values(e).includes(`callUuid=${x}`))
        const playbacks = events.filter(e => e['Event-Name'] === 'PLAYBACK_START' && e['Unique-ID'] === x)
        const answeredAt = answer ? stamp(answer) : null
        return {
            forkBugStarts: forkBugs.length,
            playbacks: playbacks.length,
            afterAnswer: answeredAt !== null && forkBugs.every(e => stamp(e) >= answeredAt) && playbacks.every(e => stamp(e) >= answeredAt),
        }
    }
    const caseUuids = []

    const lifecycleCase = async (id, name, callee, options, expect) => {
        const { x, reply, originateMs } = await originate(callee, options)
        caseUuids.push(x)
        await sleep(expect.observeAfterMs ?? 6000)
        const midBugs = reply.startsWith('+OK') || reply === 'ABANDONED' ? await bugs(x) : []
        const hung = await waitForHangup(x)
        await sleep(expect.settleMs ?? 2500)
        const forks = forkLines(x)
        const stt = sttResult(x)
        const fin = finalizes(x)
        const order = eventOrder(x)
        const gate = gating(x)
        const result = { x, reply: reply.slice(0, 40), originateMs, order, forks: forks.length, midBugs, stt, finalizes: fin.length,
            finalReason: fin[0]?.reason ?? null, recordingBytes: recordingBytes(x), hung, gate }
        const pass = expect.check(result)
        check(id, name, pass, `originate=${originateMs}ms reply=${result.reply.slice(0, 12)} order=[${order}] forks=${forks.length} bugs=[${midBugs.join(',')}] `
            + `bugStarts=${gate.forkBugStarts} playbacks=${gate.playbacks} afterAnswer=${gate.afterAnswer} `
            + `stt=${stt ? `${stt.analysis.dominantHz}Hz/${stt.bytes}B` : 'none'} finalize=${fin.length}${fin[0] ? `(${fin[0].reason})` : ''} rec=${result.recordingBytes}B`)
        return result
    }

    if (negativeControl) {
        await lifecycleCase(`${idPrefix}1`, 'negative control: baseline bridge binds but never forks a no-early-media call', 5557, { bind: true },
            { check: r => r.reply.startsWith('+OK') && r.forks === 0 && r.gate.forkBugStarts === 0 && !r.midBugs.some(b => b.startsWith('callUuid='))
                && bridgeLog().includes(`[session] bind ${r.x}`) })
    } else {
        const audioReached = (r, hz = 1234) => r.stt && r.stt.bytes > 8000 && r.stt.analysis.dominantHz === hz && r.stt.analysis.dominantMarginDb >= 20
        const exactlyOneFork = r => r.forks === 1 && r.midBugs.filter(b => b === `callUuid=${r.x}`).length === 1 && r.gate.forkBugStarts === 1
        const common = r => exactlyOneFork(r) && r.gate.afterAnswer && r.gate.playbacks >= 1 && r.midBugs.includes('session_record')
            && audioReached(r) && r.finalizes === 1 && r.recordingBytes > 44
        await lifecycleCase(`${idPrefix}1`, 'early media: one fork via CHANNEL_ANSWER after answer, callee audio reaches the bound session', 5556, { bind: true },
            { check: r => r.reply.startsWith('+OK') && common(r) && r.order.startsWith('PARK(9999,early) ANSWER(9999,answered)') && r.originateMs < 2000
                && forkLines(r.x)[0].includes('via CHANNEL_ANSWER') })
        await lifecycleCase(`${idPrefix}2`, 'no early media: one fork via the answered CHANNEL_PARK, callee audio reaches the bound session', 5557, { bind: true },
            { check: r => r.reply.startsWith('+OK') && common(r) && r.order.startsWith('ANSWER(5557,answered) PARK(9999,answered)') && r.originateMs < 5000
                && forkLines(r.x)[0].includes('via CHANNEL_PARK') })
        await lifecycleCase(`${idPrefix}3`, 'fast answer inside the dialplan sleeps: exactly one fork', 5558, { bind: true },
            { check: r => r.reply.startsWith('+OK') && common(r) })
        await lifecycleCase(`${idPrefix}4`, 'late CRM bind: the socket binds its session after connecting', 5557, { bind: true, delayMs: 3000 },
            { check: r => r.reply.startsWith('+OK') && common(r) && new RegExp(`${r.x} session bound after \\d+ frame`).test(bridgeLog()) })
        await lifecycleCase(`${idPrefix}5`, 'rejected call: no fork, session finalized once', 5559, { bind: true },
            { observeAfterMs: 1500, check: r => r.forks === 0 && r.gate.forkBugStarts === 0 && r.finalizes === 1 })
        await lifecycleCase(`${idPrefix}8`, 'hangup while the CRM bind is in flight: finalized once as closed, nothing played or streamed', 5559, { bind: true, delayMs: 4000 },
            { observeAfterMs: 1500, settleMs: 5000, check: r => r.forks === 0 && r.gate.forkBugStarts === 0 && r.gate.playbacks === 0
                && r.finalizes === 1 && r.finalReason === 'closed' && (!r.stt || r.stt.bytes === 0)
                && bridgeLog().includes(`[session] ${r.x} hung up during CRM bind`) })
        await lifecycleCase(`${idPrefix}9`, 'answer after the originating client gave up at 10 s (as the CRM does): one fork, audio reaches the session', 5560, { bind: true, abandonAfterMs: 10000 },
            { observeAfterMs: 6000, check: r => r.reply === 'ABANDONED' && r.originateMs >= 9500 && common(r)
                && r.order.startsWith('ANSWER(5560,answered) PARK(9999,answered)') })
        {
            const plan = [[5556, 1234], [5561, 880], [5562, 440]]
            const calls = await Promise.all(plan.map(([callee]) => originate(callee, { bind: true })))
            caseUuids.push(...calls.map(c => c.x))
            await sleep(6000)
            const mid = await Promise.all(calls.map(c => bugs(c.x)))
            for (const c of calls) await waitForHangup(c.x)
            await sleep(3000)
            const rows = calls.map((c, i) => ({ c, hz: plan[i][1], forks: forkLines(c.x).length, bugsOfCall: mid[i].filter(b => b === `callUuid=${c.x}`).length,
                stt: sttResult(c.x), fin: finalizes(c.x).length, gate: gating(c.x) }))
            const ok = rows.every(row => row.forks === 1 && row.bugsOfCall === 1 && row.gate.forkBugStarts === 1 && row.gate.afterAnswer
                && audioReached({ stt: row.stt }, row.hz) && row.fin === 1)
            check(`${idPrefix}6`, 'three concurrent calls: each forked exactly once and its session hears its own callee tone', ok,
                rows.map(row => `${row.c.x.slice(0, 8)}:forks=${row.forks},tone=${row.stt?.analysis?.dominantHz ?? 'none'}/${row.hz}`).join(' '))
        }
        await sleep(3000)
        const finalizedOnce = caseUuids.every(x => finalizes(x).length === 1)
        check(`${idPrefix}7`, 'after all calls: no channel, no fork connection, every call finalized exactly once, FreeSWITCH alive',
            (await channelCount()) === 0 && (await forkConnections(3030)) === 0 && finalizedOnce && await alive(),
            `calls=${caseUuids.length} finalizedOnce=${finalizedOnce}`)
    }
    await observer.close()
    fs.writeFileSync(path.join(shared, `${bridgeName}.log`), bridgeLog())
    docker(['rm', '-f', bridgeName], { allowFail: true })
}

if (MODE === 'sink') await runSink()
else if (MODE === 'bridge-stubs') installBridgeStubs()
else if (MODE === 'driver') await runDriver()
else await runProbe()
