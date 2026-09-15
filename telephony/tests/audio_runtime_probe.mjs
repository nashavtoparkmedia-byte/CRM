#!/usr/bin/env node
// Isolated audio-runtime probe for the CRM FreeSWITCH image and the AI audio bridge.
//
// Proves, against real containers and without any provider, trunk or phone:
//   A. the image runs FreeSWITCH 1.10.12 with mod_audio_fork loaded, uuid_audio_fork registered,
//      extensions 9999/9998 installed, existing telephony modules loaded, no new listeners;
//      real call audio reaches a WebSocket (8 kHz and 16 kHz), stop and hangup clean up;
//   B. malformed commands and malformed playAudio messages do not crash FreeSWITCH, nor do a
//      refused connection or a far end that closes mid-stream;
//   C. with the bridge code under test, a production-shaped originate
//      `originate {origination_uuid=X,...,execute_on_answer='record_session ...'}<callee> 9999 XML default`
//      forks exactly once and delivers the callee's audio to the bound CallSession whether or not the
//      callee sends early media, including a fast answer, a late CRM bind, a rejected call and
//      concurrent calls, alongside record_session, with full cleanup on hangup;
//   D. the image refuses to start without a real MEGAFON_SIP_PASSWORD.
//
// Safety: every container this probe creates is named probe-art-<run>-* and attached only to a
// fresh `docker network create --internal` network that is verified before FreeSWITCH starts. No
// port is published and DNS points at an unroutable resolver, so the Megafon gateway in the image can
// never reach the trunk. The ESL password and the trunk password are random per run and are never
// printed. No other container is inspected, executed into or modified.
//
// Usage (needs Docker; run from the repository root):
//   node telephony/tests/audio_runtime_probe.mjs --image <candidate> --out <dir>
//     [--bridge-dir tools/audio-bridge-day1] [--bridge-image crm/audio-bridge:latest]
//     [--control-image crm/freeswitch:latest] [--baseline-bridge-dir <dir>] [--keep]
//
// PROBE_MODE=sink and PROBE_MODE=bridge-stubs are internal modes used inside probe containers.

import { execFileSync, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'

const MODE = process.env.PROBE_MODE ?? 'run'
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

function sendHostile(ws, rec) {
    // Each of these reached strcmp(NULL) on the libwebsockets thread before patch 0002.
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

    // 1.0 s of 700 Hz, 8 kHz mono 16-bit: playback the fork must NOT hear in mono mode.
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
    const res = spawnSync('docker', ['logs', name], { encoding: 'utf8' })
    return res.status === 0 ? `${res.stdout}${res.stderr}` : ''
}

class Esl {
    constructor(host, password) { this.host = host; this.password = password }

    connect(onEvent) {
        return new Promise((resolve, reject) => {
            const sock = net.connect(8021, this.host)
            let buf = ''
            let authed = false
            const pending = []
            this.sock = sock
            this.pending = pending
            sock.setEncoding('utf8')
            sock.once('error', reject)
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
                    if (type === 'api/response' || type === 'command/reply') { pending.shift()?.(body || head['Reply-Text'] || ''); continue }
                    if (type === 'text/event-plain' && onEvent) onEvent(parseHeaders(body, true))
                }
            })
        })
    }

    send(line) {
        return new Promise(resolve => { this.pending.push(resolve); this.sock.write(`${line}\n\n`) })
    }

    api(command) { return this.send(`api ${command}`).then(out => String(out).trim()) }

    close() { this.sock?.destroy() }
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

function parseArgs(argv) {
    const args = { bridgeDir: 'tools/audio-bridge-day1', bridgeImage: 'crm/audio-bridge:latest', controlImage: 'crm/freeswitch:latest', keep: false }
    for (let i = 0; i < argv.length; i++) {
        const key = argv[i]
        const next = () => argv[++i]
        if (key === '--image') args.image = next()
        else if (key === '--out') args.out = next()
        else if (key === '--bridge-dir') args.bridgeDir = next()
        else if (key === '--bridge-image') args.bridgeImage = next()
        else if (key === '--control-image') args.controlImage = next()
        else if (key === '--baseline-bridge-dir') args.baselineBridgeDir = next()
        else if (key === '--keep') args.keep = true
        else throw new Error(`unknown argument ${key}`)
    }
    if (!args.image || !args.out) throw new Error('--image and --out are required')
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
</include>
`

async function runProbe() {
    const args = parseArgs(process.argv.slice(2))
    const run = crypto.randomBytes(3).toString('hex')
    const prefix = `probe-art-${run}`
    const out = path.resolve(args.out)
    const shared = path.join(out, 'shared')
    for (const dir of ['crm', 'stt', 'tts', 'sink']) fs.mkdirSync(path.join(shared, dir), { recursive: true })
    fs.chmodSync(shared, 0o777)
    for (const dir of ['crm', 'stt', 'tts', 'sink']) fs.chmodSync(path.join(shared, dir), 0o777)
    const eslPassword = crypto.randomBytes(24).toString('hex')
    const trunkPassword = `probe${crypto.randomBytes(12).toString('hex')}`
    const results = []
    const created = []
    const check = (id, name, pass, detail = '') => {
        results.push({ id, name, pass: Boolean(pass), detail })
        console.log(`${pass ? 'PASS' : 'FAIL'} ${id} ${name}${detail ? ` — ${detail}` : ''}`)
    }

    const network = `${prefix}-net`
    let subnet = null
    for (let third = 240; third < 255 && !subnet; third++) {
        const candidate = `172.31.${third}.0/24`
        if (docker(['network', 'create', '--internal', '--subnet', candidate, '--label', 'io.yoko.probe=audio-runtime', network], { allowFail: true }) !== null) subnet = candidate
    }
    if (!subnet) throw new Error('could not create an isolated network')
    const base = subnet.replace('.0/24', '')
    const ip = { fs: `${base}.10`, control: `${base}.11`, sink: `${base}.20`, bridge: `${base}.30` }
    const netInfo = JSON.parse(docker(['network', 'inspect', network]))[0]
    check('S1', 'probe network is internal (no egress)', netInfo.Internal === true, subnet)
    if (!netInfo.Internal) throw new Error('refusing to continue without an internal network')

    const runContainer = (name, extra) => {
        docker(['run', '-d', '--name', name, '--label', 'io.yoko.probe=audio-runtime', '--network', network, '--dns', '127.0.0.254', ...extra])
        created.push(name)
    }
    const fsName = `${prefix}-fs`
    const teardown = () => {
        if (args.keep) return
        for (const name of created) docker(['rm', '-f', name], { allowFail: true })
        docker(['network', 'rm', network], { allowFail: true })
    }

    try {
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
        runContainer(fsName, ['--ip', ip.fs, '--memory', '768m', '-e', `ESL_PASSWORD=${eslPassword}`, '-e', `MEGAFON_SIP_PASSWORD=${trunkPassword}`,
            '-v', `${shared}:/shared`, args.image])
        const esl = new Esl(ip.fs, eslPassword)
        let up = false
        for (let i = 0; i < 90 && !up; i++) {
            try { await esl.connect(); up = (await esl.api('status')).includes('UP') } catch { await sleep(1000) }
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

        const listeners = name => new Set(docker(['exec', name, 'busybox', 'netstat', '-lntu']).split('\n')
            .filter(l => /^(tcp|udp)/.test(l)).map(l => l.split(/\s+/)).map(p => `${p[0]} ${p[3]}`).filter(l => !l.includes('127.0.0.11:')))
        runContainer(`${prefix}-control`, ['--ip', ip.control, '--memory', '512m', '-e', `ESL_PASSWORD=${eslPassword}`, args.controlImage])
        let controlUp = false
        const controlEsl = new Esl(ip.control, eslPassword)
        for (let i = 0; i < 90 && !controlUp; i++) {
            try { await controlEsl.connect(); controlUp = (await controlEsl.api('status')).includes('UP') } catch { await sleep(1000) }
        }
        controlEsl.close()
        const candidateListeners = listeners(fsName)
        const controlListeners = controlUp ? listeners(`${prefix}-control`) : new Set()
        const added = [...candidateListeners].filter(l => !controlListeners.has(l))
        check('A8', 'no listener beyond the unmodified control image', controlUp && added.length === 0, added.join(',') || `${candidateListeners.size} listeners`)
        docker(['rm', '-f', `${prefix}-control`], { allowFail: true })

        docker(['cp', callees, `${fsName}:/etc/freeswitch/dialplan/default/97_probe_callees.xml`])
        await esl.api('reloadxml')

        runContainer(`${prefix}-sink`, ['--ip', ip.sink, '--memory', '256m', '-e', 'PROBE_MODE=sink', '-e', 'PROBE_SINK_OUT=/shared/sink',
            '-v', `${shared}:/shared`, '-v', `${path.resolve('telephony/tests/audio_runtime_probe.mjs')}:/probe/probe.mjs:ro`,
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
                r && `frames=${r.binaryFrames} B/s=${r.bytesPerSecond} dominant=${r.analysis.dominantHz}Hz +${r.analysis.dominantMarginDb}dB`)
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
        {
            const { a, b } = await toneCall(9999, 440, 20000)
            const four = await esl.api(`uuid_audio_fork ${b} start ${sinkUrl}?callUuid=${b}&label=b4 mono`)
            await sleep(2000)
            const fourBugs = await bugs(b)
            await esl.api(`uuid_audio_fork ${b} stop`)
            await sleep(800)
            check('B1', 'four-argument start does not crash and defaults to 8000 Hz',
                four.startsWith('+OK') && fourBugs.includes('audio_fork') && await alive() && (await esl.api(`uuid_exists ${b}`)) === 'true')
            const upper = await esl.api(`uuid_audio_fork ${b} START ${sinkUrl}`)
            const upper2 = await esl.api(`uuid_audio_fork ${b} Start`)
            check('B2', 'START with too few arguments returns usage instead of crashing',
                upper.startsWith('-USAGE') && upper2.startsWith('-USAGE') && await alive())
            await esl.api(`uuid_audio_fork ${b} start ${sinkUrl}?callUuid=${b}&label=bh&hostile=1 mono 8000 hostile`)
            await sleep(4500)
            const hostileAlive = await alive()
            const stillStreaming = (await bugs(b)).includes('hostile')
            await esl.api(`uuid_audio_fork ${b} stop hostile`)
            await sleep(800)
            const tempFiles = docker(['exec', fsName, 'sh', '-c', `ls /tmp/${b}_* 2>/dev/null | wc -l`], { allowFail: true })
            const r = await sinkResult('bh')
            check('B3', 'malformed playAudio messages do not crash FreeSWITCH or write files',
                hostileAlive && stillStreaming && r?.sentHostile >= 9 && r.binaryFrames > 100 && (tempFiles === null || tempFiles === '0'),
                r && `sent=${r.sentHostile} frames=${r.binaryFrames}`)
            await esl.api(`uuid_audio_fork ${b} start ws://${ip.sink}:9/audio mono 8000 refused`)
            await sleep(3000)
            check('B4', 'a refused connection does not crash FreeSWITCH', await alive() && (await esl.api(`uuid_exists ${b}`)) === 'true')
            await esl.api(`uuid_audio_fork ${b} stop refused`).catch(() => '')
            for (const code of [1000, 1011]) {
                await esl.api(`uuid_audio_fork ${b} start ${sinkUrl}?callUuid=${b}&label=bc${code}&closeAfter=50&closeCode=${code} mono 8000 close${code}`)
                await sleep(2500)
            }
            check('B5', 'a far end closing mid-stream (1000 and 1011) does not crash FreeSWITCH',
                await alive() && (await esl.api(`uuid_exists ${b}`)) === 'true')
            await hangup(a, b)
        }

        // ---- C: call lifecycle with the bridge code under test ---------------------------------------
        const lifecycle = await runLifecycle({ args, esl, fsName, shared, ip, prefix, network, runContainer, bugs, channelCount, forkConnections, check, alive, created, bridgeDir: args.bridgeDir, idPrefix: 'C', eslPassword })
        if (args.baselineBridgeDir) {
            await runLifecycle({ args, esl, fsName, shared, ip, prefix, network, runContainer, bugs, channelCount, forkConnections, check, alive, created, bridgeDir: args.baselineBridgeDir, idPrefix: 'N', eslPassword, negativeControl: true })
        }
        check('Z1', 'FreeSWITCH never restarted during the probe', await alive())
        esl.close()
        void lifecycle
    } catch (err) {
        check('X', 'probe aborted', false, err.message)
    } finally {
        fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ run, subnet, results }, null, 1))
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
    const { args, esl, fsName, shared, ip, prefix, runContainer, bugs, channelCount, forkConnections, check, alive, bridgeDir, idPrefix, eslPassword, negativeControl } = ctx
    const bridgeName = `${prefix}-bridge-${idPrefix.toLowerCase()}`
    const mounts = fs.readdirSync(path.resolve(bridgeDir)).filter(f => f.endsWith('.js'))
        .flatMap(f => ['-v', `${path.resolve(bridgeDir, f)}:/app/${f}:ro`])
    runContainer(bridgeName, ['--ip', ip.bridge, '--memory', '384m', ...mounts,
        '-v', `${shared}:/shared`, '-v', `${path.resolve('telephony/tests/audio_runtime_probe.mjs')}:/probe/probe.mjs:ro`,
        '-e', 'PROBE_MODE=bridge-stubs', '-e', 'PROBE_SHARED=/shared',
        '-e', `FS_ESL_HOST=${ip.fs}`, '-e', 'FS_ESL_PORT=8021', '-e', `ESL_PASSWORD=${eslPassword}`,
        '-e', 'AUDIO_BRIDGE_PORT=3030', '-e', `BRIDGE_LAN_IP=${ip.bridge}`,
        '-e', 'BRIDGE_AUDIO_DIR=/shared/tts', '-e', 'BRIDGE_AUDIO_DIR_FS=/shared/tts', '-e', 'CRM_BASE_URL=http://127.0.0.254:9',
        '--entrypoint', 'node', args.bridgeImage, '--import', '/probe/probe.mjs', '/app/server.js'])
    for (let i = 0; i < 40; i++) {
        if (dockerLogs(bridgeName).includes('[esl-events] subscribed')) break
        await sleep(500)
    }
    const events = []
    const observer = new Esl(ip.fs, eslPassword)
    await observer.connect(e => events.push({ ...e, seenAt: Date.now() }))
    await observer.send('event plain CHANNEL_PARK CHANNEL_ANSWER CHANNEL_HANGUP_COMPLETE MEDIA_BUG_START PLAYBACK_START')

    const originate = async (callee, { bind = true, delayMs = 0 } = {}) => {
        const x = crypto.randomUUID()
        fs.writeFileSync(path.join(shared, 'crm', `${x}.json`), JSON.stringify({ bind, delayMs }))
        const vars = `origination_uuid=${x},origination_caller_id_name='AI Assistant',RECORD_STEREO=true,recording_follow_transfer=true,`
            + `recording_file=/var/lib/freeswitch/recordings/${x}.wav,execute_on_answer='record_session /var/lib/freeswitch/recordings/${x}.wav'`
        const t0 = Date.now()
        const reply = await esl.api(`originate {${vars}}loopback/${callee}/default 9999 XML default`)
        return { x, reply, originateMs: Date.now() - t0 }
    }
    const waitForHangup = async (x, timeoutMs = 20000) => {
        const until = Date.now() + timeoutMs
        while (Date.now() < until) {
            if (events.some(e => e['Event-Name'] === 'CHANNEL_HANGUP_COMPLETE' && e['Unique-ID'] === x)) return true
            await sleep(250)
        }
        return false
    }
    const bridgeLog = () => dockerLogs(bridgeName)
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

    const lifecycleCase = async (id, name, callee, options, expect) => {
        const { x, reply, originateMs } = await originate(callee, options)
        await sleep(expect.observeAfterMs ?? 6000)
        const midBugs = reply.startsWith('+OK') ? await bugs(x) : []
        const hung = await waitForHangup(x)
        await sleep(2500)
        const forks = forkLines(x)
        const stt = sttResult(x)
        const fin = finalizes(x)
        const order = eventOrder(x)
        const result = { x, reply: reply.slice(0, 40), originateMs, order, forks: forks.length, midBugs, stt, finalizes: fin.length, recordingBytes: recordingBytes(x) }
        const pass = expect.check(result)
        check(id, name, pass, `originate=${originateMs}ms order=[${order}] forks=${forks.length} bugs=[${midBugs.join(',')}] stt=${stt ? `${stt.analysis.dominantHz}Hz/${stt.bytes}B` : 'none'} finalize=${fin.length} rec=${result.recordingBytes}B`)
        return result
    }

    if (negativeControl) {
        await lifecycleCase(`${idPrefix}1`, 'negative control: baseline bridge never forks a no-early-media call', 5557, { bind: true },
            { check: r => r.reply.startsWith('+OK') && r.forks === 0 && !r.midBugs.some(b => b.startsWith('callUuid=')) })
    } else {
        const audioReachedSession = r => r.stt && r.stt.bytes > 8000 && r.stt.analysis.dominantHz === 1234 && r.stt.analysis.dominantMarginDb >= 20
        const exactlyOneFork = r => r.forks === 1 && r.midBugs.filter(b => b === `callUuid=${r.x}`).length === 1
        const common = r => r.reply.startsWith('+OK') && exactlyOneFork(r) && r.midBugs.includes('session_record') && audioReachedSession(r) && r.finalizes === 1 && r.recordingBytes > 44
        await lifecycleCase(`${idPrefix}1`, 'early media: one fork via CHANNEL_ANSWER, callee audio reaches the bound session', 5556, { bind: true },
            { check: r => common(r) && r.order.startsWith('PARK(9999,early) ANSWER(9999,answered)') && r.originateMs < 2000 && bridgeLog().includes(`auto-forking audio for ${r.x}`) && forkLines(r.x)[0].includes('via CHANNEL_ANSWER') })
        await lifecycleCase(`${idPrefix}2`, 'no early media: one fork via the answered CHANNEL_PARK, callee audio reaches the bound session', 5557, { bind: true },
            { check: r => common(r) && r.order.startsWith('ANSWER(5557,answered) PARK(9999,answered)') && r.originateMs < 5000 && forkLines(r.x)[0].includes('via CHANNEL_PARK') })
        await lifecycleCase(`${idPrefix}3`, 'fast answer inside the dialplan sleeps: exactly one fork', 5558, { bind: true },
            { check: r => common(r) })
        await lifecycleCase(`${idPrefix}4`, 'late CRM bind: the socket binds its session after connecting', 5557, { bind: true, delayMs: 3000 },
            { check: r => common(r) && new RegExp(`${r.x} session bound after \\d+ frame`).test(bridgeLog()) })
        await lifecycleCase(`${idPrefix}5`, 'rejected call: no fork, session finalized once', 5559, { bind: true },
            { observeAfterMs: 1500, check: r => r.forks === 0 && r.finalizes === 1 })
        {
            const calls = await Promise.all([5556, 5557, 5557].map(c => originate(c, { bind: true })))
            await sleep(6000)
            const mid = await Promise.all(calls.map(c => bugs(c.x)))
            for (const c of calls) await waitForHangup(c.x)
            await sleep(3000)
            const ok = calls.every((c, i) => forkLines(c.x).length === 1 && mid[i].filter(b => b === `callUuid=${c.x}`).length === 1
                && audioReachedSession({ stt: sttResult(c.x) }) && finalizes(c.x).length === 1)
            check(`${idPrefix}6`, 'three concurrent calls: each forked exactly once with its own callee audio', ok,
                calls.map((c, i) => `${c.x.slice(0, 8)}:forks=${forkLines(c.x).length},bugs=${mid[i].length}`).join(' '))
        }
        check(`${idPrefix}7`, 'after all calls: no channel, no fork connection, FreeSWITCH alive',
            (await channelCount()) === 0 && (await forkConnections(3030)) === 0 && await alive())
    }
    observer.close()
    fs.writeFileSync(path.join(shared, `${bridgeName}.log`), bridgeLog())
    docker(['rm', '-f', bridgeName], { allowFail: true })
    return true
}

if (MODE === 'sink') await runSink()
else if (MODE === 'bridge-stubs') installBridgeStubs()
else await runProbe()
