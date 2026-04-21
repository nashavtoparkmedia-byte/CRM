// TEMPORARY — file-based logging for telephony debugging
// Remove after collecting heartbeat logs
import fs from 'fs'
import path from 'path'

const LOG_PATH = path.join(process.cwd(), 'telephony-debug.log')

export function telephonyFileLog(line: string) {
  const ts = new Date().toISOString()
  fs.appendFileSync(LOG_PATH, `${ts} ${line}\n`)
}
