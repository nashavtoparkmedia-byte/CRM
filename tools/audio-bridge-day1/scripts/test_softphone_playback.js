// Issue #23 α-test — play a WAV directly to the manager softphone (user/103)
// via FreeSWITCH, no trunk involved.
//
// Same playback() app as test_fs_playback_only.js but the destination is the
// internal-profile SIP user instead of the Megafon trunk gateway. Goal:
// isolate the choppy-bot-voice symptom from anything that lives on the
// trunk side (SBC, cellular, handset). If user/103 hears the WAV cleanly
// → trunk-side is the issue. If user/103 hears the same choppy →
// problem is upstream of the trunk, possibly inside FS playback /
// codec / WebRTC encode.
//
// Usage: node scripts/test_softphone_playback.js <wavPathInsideWsl>
// e.g.:  node scripts/test_softphone_playback.js /dev/shm/test-23/B-bridge-8k.wav
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
            if (stage === 'auth' && buf.includes('-ERR')) {
                clearTimeout(timer); sock.destroy()
                reject(new Error(`esl auth failed`)); return
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
    const wavPath = process.argv[2]
    if (!wavPath) { console.error('usage: test_softphone_playback.js <wavPathInsideWsl>'); process.exit(1) }
    const ext = process.argv[3] ?? '103'

    const callUuid = crypto.randomUUID()
    const recPath = `/var/lib/freeswitch/recordings/${callUuid}.wav`

    // Channel vars:
    //   - origination_uuid pins the UUID for later analysis
    //   - rtp_secure_media=false: same override as production manager
    //     outbound (see EslClient.ts:447). Without it FS demands SRTP on
    //     legs that can't do crypto and the call dies on media setup. The
    //     WebRTC b-leg negotiates DTLS-SRTP regardless; this var keeps
    //     the path open even if intermediate states briefly fail crypto.
    //   - RECORD_STEREO + recording_file + execute_on_answer: same as the
    //     trunk test — captures the channel media so we can compare what
    //     FS internally sent against the source WAV after the call.
    //   - sip_h_P-CRM-Outbound-Bridge marker tells the CRM browser to
    //     auto-answer (skips Accept/Decline popup, matches how production
    //     manager-outbound bridges land).
    // Optional --timer=<name> override (default: keep profile default).
    // Lets us A/B FS's soft-timer vs timerfd at the per-channel level
    // without editing sip_profiles/*.xml and restarting sofia.
    const timerName = process.env.RTP_TIMER ?? null
    const playbackBuf = process.env.PLAYBACK_BUF_LEN ?? null
    const vars = [
        `origination_uuid=${callUuid}`,
        `origination_caller_id_name='AI Test 23 SP'`,
        `origination_caller_id_number='Test'`,
        `rtp_secure_media=false`,
        `RECORD_STEREO=true`,
        `recording_follow_transfer=true`,
        `recording_file=${recPath}`,
        `execute_on_answer='record_session ${recPath}'`,
        `sip_h_P-CRM-Outbound-Bridge=true`,
        ...(timerName ? [`rtp_timer_name=${timerName}`] : []),
        ...(playbackBuf ? [`playback_buffer_len=${playbackBuf}`] : []),
    ].join(',')

    const cmd = `originate {${vars}}user/${ext} &playback(${wavPath})`

    console.log(`UUID:     ${callUuid}`)
    console.log(`WAV:      ${wavPath}`)
    console.log(`Recording: ${recPath}`)
    console.log(`Dialing:  user/${ext}\n`)
    console.log(`originate command:\n  ${cmd}\n`)

    const reply = await eslApi(cmd, 30000)
    console.log(`FS response:\n  ${reply}`)
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1) })
