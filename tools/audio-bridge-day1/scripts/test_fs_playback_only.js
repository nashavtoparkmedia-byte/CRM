// Issue #23 step 3 — clean FreeSWITCH playback test, NO bridge involvement.
//
// What this does:
//   1. Originates an outbound call sofia/gateway/megafon/<number>.
//   2. When the trunk answers, FS runs `playback(<wav>)` on the channel.
//      No dialplan extension (and therefore NO bridge auto-fork), no LLM,
//      no STT, no live TTS, no audio_fork media bug, no uuid_broadcast.
//      Pure FS read-WAV → transcode → RTP path.
//   3. record_session captures the channel audio so we can analyse afterwards.
//
// What this tests:
//   - If the user hears the WAV as cleanly as they did locally → FS playback
//     and the SIP/RTP/trunk path are healthy. The choppy live-AI-call issue
//     lives in our bridge / audio_fork / call-orchestrator timing.
//   - If the user still hears choppy → the problem is downstream of the
//     bridge (FS playback engine, codec, RTP scheduling, trunk, handset).
//     Bridge changes won't fix it.
//
// Usage: node scripts/test_fs_playback_only.js <phoneNumber> <wavPathInsideWsl>
// e.g.:  node scripts/test_fs_playback_only.js +79222155750 /dev/shm/test-23/B-bridge-8k.wav
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
        const timer = setTimeout(() => {
            sock.destroy()
            reject(new Error(`esl timeout (stage=${stage})`))
        }, timeoutMs)
        sock.on('data', chunk => {
            buf += chunk
            if (stage === 'connecting' && buf.includes('Content-Type: auth/request')) {
                stage = 'auth'
                buf = ''
                sock.write(`auth ${ESL_PASS}\n\n`)
                return
            }
            if (stage === 'auth' && buf.includes('+OK accepted')) {
                stage = 'sending'
                buf = ''
                sock.write(`api ${command}\n\n`)
                return
            }
            if (stage === 'auth' && buf.includes('-ERR')) {
                clearTimeout(timer); sock.destroy()
                reject(new Error(`esl auth failed: ${buf.split('\n').find(l => l.includes('-ERR'))}`))
                return
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

async function main() {
    const phone = process.argv[2]
    const wavPath = process.argv[3]
    if (!phone || !wavPath) {
        console.error('usage: test_fs_playback_only.js <phoneNumber> <wavPathInsideWsl>')
        process.exit(1)
    }

    const callUuid = crypto.randomUUID()
    const recPath = `/var/lib/freeswitch/recordings/${callUuid}.wav`
    const dialNumber = phone.replace(/\D/g, '')

    // Channel vars:
    //   - origination_uuid pins the UUID so we know what to analyse later
    //   - RECORD_STEREO=true → L=trunk-in, R=trunk-out (our playback)
    //   - recording_file + execute_on_answer kicks off record_session the
    //     moment the trunk answers, BEFORE playback starts, so the recorded
    //     file captures the full playback window from the very first sample
    //   - ignore_early_media=true blocks Megafon's ringback tones from
    //     being treated as a 'real' answer
    const vars = [
        `origination_uuid=${callUuid}`,
        `origination_caller_id_name='AI Test 23'`,
        `ignore_early_media=true`,
        `RECORD_STEREO=true`,
        `recording_follow_transfer=true`,
        `recording_file=${recPath}`,
        `execute_on_answer='record_session ${recPath}'`,
    ].join(',')

    // &playback() runs the playback app on the originated channel once the
    // trunk side answers. NO dialplan extension is invoked → bridge's
    // CHANNEL_ANSWER handler sees no matched extension and returns early.
    // FS plays the WAV, then hangs up on its own when playback ends.
    const cmd = `originate {${vars}}sofia/gateway/megafon/${dialNumber} &playback(${wavPath})`

    console.log(`UUID:     ${callUuid}`)
    console.log(`WAV:      ${wavPath}`)
    console.log(`Recording: ${recPath} (host: \\\\wsl.localhost\\Ubuntu-24.04\\var\\lib\\freeswitch\\recordings\\${callUuid}.wav)`)
    console.log(`Dialing:  ${dialNumber}\n`)
    console.log(`originate command:\n  ${cmd}\n`)

    const reply = await eslApi(cmd, 30000)
    console.log(`FS response:\n  ${reply}`)
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1) })
