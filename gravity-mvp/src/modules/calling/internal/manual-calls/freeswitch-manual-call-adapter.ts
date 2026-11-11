import 'server-only'

import net from 'node:net'
import {
  ManualDialOutcomeUnknownError,
  ManualDialRejectedError,
  ManualDialUnavailableError,
  type ManualCallDialPort,
} from '../../application/manual-call'

// FreeSWITCH side of a manual click-to-call: the trunk leg dials the Contact's number, and the
// manager's own extension is bridged in once the trunk answers. Every value that enters the ESL
// command is validated on its own here, right before the command is assembled, so no channel
// variable can be injected through a number, an extension or an id.

const STRICT_E164 = /^\+[1-9]\d{7,14}$/
const EXTENSION = /^\d{2,6}$/
const FS_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const STAFF_USER_ID = /^[A-Za-z0-9_-]{1,64}$/
/** The callee has this long to answer; FreeSWITCH ends the attempt itself after that. */
export const MANUAL_CALL_ORIGINATE_TIMEOUT_SECONDS = 45
const ESL_REPLY_TIMEOUT_MS = 5_000

export type ManualOriginateInput = { fsUuid: string; e164: string; extension: string; staffUserId: string }

/** Pure, for tests: the exact bgapi command, or a ManualDialUnavailableError when any value is unsafe. */
export function buildManualOriginateCommandV1(input: ManualOriginateInput): string {
  if (!STRICT_E164.test(input.e164)) throw new ManualDialUnavailableError('destination is not a strict E.164 number')
  if (!EXTENSION.test(input.extension)) throw new ManualDialUnavailableError('extension is not a plain extension number')
  if (!FS_UUID.test(input.fsUuid)) throw new ManualDialUnavailableError('channel uuid is not a uuid')
  if (!STAFF_USER_ID.test(input.staffUserId)) throw new ManualDialUnavailableError('staff user id is not a plain identifier')
  const digits = input.e164.slice(1)
  const recording = `/var/lib/freeswitch/recordings/${input.fsUuid}.wav`
  const vars = [
    `origination_uuid=${input.fsUuid}`,
    `origination_caller_id_number=${digits}`,
    `origination_caller_id_name='${digits}'`,
    `crm_user_id=${input.staffUserId}`,
    `originate_timeout=${MANUAL_CALL_ORIGINATE_TIMEOUT_SECONDS}`,
    'ignore_early_media=true',
    'rtp_secure_media=false',
    'RECORD_STEREO=true',
    'recording_follow_transfer=true',
    `recording_file=${recording}`,
    `execute_on_answer='record_session ${recording}'`,
  ].join(',')
  return `bgapi originate {${vars}}sofia/gateway/megafon/${digits} &bridge([sip_h_P-CRM-Outbound-Bridge=true]user/${input.extension})`
}

export function buildManualCancelCommandV1(fsUuid: string): string {
  if (!FS_UUID.test(fsUuid)) throw new ManualDialUnavailableError('channel uuid is not a uuid')
  return `api uuid_kill ${fsUuid} ORIGINATOR_CANCEL`
}

type EslConnection = { host: string; port: number; password: string }

/** Explicit settings only: no default password is ever used for a dial. */
export function manualCallEslConnectionV1(env: Record<string, string | undefined> = process.env): EslConnection {
  const host = env.FS_ESL_HOST?.trim() ?? ''
  const port = Number(env.FS_ESL_PORT ?? '')
  const password = env.ESL_PASSWORD ?? ''
  if (!host) throw new ManualDialUnavailableError('ESL host is not configured')
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new ManualDialUnavailableError('ESL port is not configured')
  if (password.length < 16 || password === 'ClueCon') throw new ManualDialUnavailableError('ESL password is missing or a default')
  return { host, port, password }
}

/** One ESL round trip: authenticate, send one command, read its first reply. */
function sendOne(connection: EslConnection, command: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const socket = net.connect(connection.port, connection.host)
    socket.setEncoding('utf8')
    let buffer = ''
    let stage: 'connecting' | 'authenticating' | 'awaiting_reply' = 'connecting'
    const finish = (error: Error | null, reply?: string) => {
      clearTimeout(timer)
      socket.destroy()
      if (error) reject(error)
      else resolve(reply ?? '')
    }
    const timer = setTimeout(() => finish(stage === 'awaiting_reply'
      ? new ManualDialOutcomeUnknownError('no reply from the switch after the command was sent')
      : new ManualDialUnavailableError('the switch did not accept the connection in time')), ESL_REPLY_TIMEOUT_MS)
    socket.on('data', chunk => {
      buffer += chunk
      if (stage === 'connecting' && buffer.includes('auth/request')) {
        stage = 'authenticating'
        buffer = ''
        socket.write(`auth ${connection.password}\n\n`)
        return
      }
      if (stage === 'authenticating') {
        if (buffer.includes('+OK accepted')) {
          stage = 'awaiting_reply'
          buffer = ''
          socket.write(`${command}\n\n`)
        } else if (buffer.includes('-ERR')) {
          finish(new ManualDialUnavailableError('the switch refused the ESL login'))
        }
        return
      }
      if (stage === 'awaiting_reply' && /(\+OK|-ERR)[^\n]*\n/.test(buffer)) {
        finish(null, buffer)
      }
    })
    socket.on('error', () => finish(stage === 'awaiting_reply'
      ? new ManualDialOutcomeUnknownError('the connection broke after the command was sent')
      : new ManualDialUnavailableError('the switch is not reachable')))
    socket.on('close', () => finish(stage === 'awaiting_reply'
      ? new ManualDialOutcomeUnknownError('the connection closed after the command was sent')
      : new ManualDialUnavailableError('the switch closed the connection')))
  })
}

export const freeswitchManualCallDialPort: ManualCallDialPort = {
  async originate(input) {
    const command = buildManualOriginateCommandV1(input)
    const reply = await sendOne(manualCallEslConnectionV1(), command)
    if (!reply.includes('+OK')) throw new ManualDialRejectedError('the switch rejected the originate job')
  },
  async cancel(fsUuid) {
    const command = buildManualCancelCommandV1(fsUuid)
    await sendOne(manualCallEslConnectionV1(), command)
  },
}
