'use strict'
// Gracefully stop the scraper process by PID
const pid = parseInt(process.argv[2])
if (!pid) { console.error('Usage: node scripts/stop_process.js <pid>'); process.exit(1) }
try {
  process.kill(pid, 'SIGTERM')
  console.log(`Sent SIGTERM to PID ${pid}`)
} catch (e) {
  console.error(`Failed: ${e.message}`)
}
