// Orchestrate sequential softphone playback for the issue #23 listening
// comparison. Fires originate() for each WAV in turn, waits long enough
// for the previous call to wrap (playback ends → FS hangs up the
// channel automatically because the &playback(...) app exits when the
// file is consumed), then moves to the next. Browser softphone
// auto-answers each via the P-CRM-Outbound-Bridge marker so the user
// just listens through the speakers.
//
// Usage: node scripts/run_softphone_sequence.js <wav1> <wav2> ...
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') })

const net = require('net')
const crypto = require('crypto')

const ESL_HOST = process.env.FS_ESL_HOST ?? '127.0.0.1'
const ESL_PORT = Number(process.env.FS_ESL_PORT ?? 8021)
const ESL_PASS = process.env.ESL_PASSWORD ?? 'ClueCon'

function eslApi(command, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
        const sock = net.connect(ESL_PORT, ESL_HOST)
        sock.setEncoding('utf8')
        let buf = ''
        let stage = 'connecting'
        const timer = setTimeout(() => { sock.destroy(); reject(new Error(`esl timeout (${stage})`)) }, timeoutMs)
        sock.on('data', chunk => {
            buf += chunk
            if (stage === 'connecting' && buf.includes('Content-Type: auth/request')) {
                stage = 'auth'; buf = ''; sock.write(`auth ${ESL_PASS}\n\n`); return
            }
            if (stage === 'auth' && buf.includes('+OK accepted')) {
                stage = 'sending'; buf = ''; sock.write(`api ${command}\n\n`); return
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

async function playOne(wavPath, label) {
    const callUuid = crypto.randomUUID()
    const recPath = `/var/lib/freeswitch/recordings/${callUuid}.wav`
    const vars = [
        `origination_uuid=${callUuid}`,
        `origination_caller_id_name='${label}'`,
        `origination_caller_id_number='${label}'`,
        `rtp_secure_media=false`,
        `RECORD_STEREO=true`,
        `recording_file=${recPath}`,
        `execute_on_answer='record_session ${recPath}'`,
        `sip_h_P-CRM-Outbound-Bridge=true`,
    ].join(',')
    const cmd = `originate {${vars}}user/103 &playback(${wavPath})`
    console.log(`\n[${new Date().toLocaleTimeString()}] ${label}  →  ${wavPath}`)
    console.log(`  uuid: ${callUuid}`)
    const r = await eslApi(cmd, 30000)
    console.log(`  fs:   ${r}`)
    return callUuid
}

async function main() {
    const files = process.argv.slice(2)
    if (files.length === 0) { console.error('usage: <wav1> [wav2 ...]'); process.exit(1) }

    // Gap between calls: 8.5 s phrase + 2 s buffer for ringing + 2 s
    // gap for the user to mentally tag the segment = 12.5 s per call.
    const GAP_MS = 13000
    for (let i = 0; i < files.length; i++) {
        const f = files[i]
        const label = `#${i + 1}-${f.split('/').pop().split('-')[0]}`
        try {
            await playOne(f, label)
        } catch (e) {
            console.error(`  FAIL: ${e.message}`)
        }
        if (i < files.length - 1) {
            console.log(`  ...waiting ${GAP_MS / 1000}s for next...`)
            await sleep(GAP_MS)
        }
    }
    console.log('\nall queued')
}

main().catch(e => { console.error('FATAL:', e); process.exit(1) })
