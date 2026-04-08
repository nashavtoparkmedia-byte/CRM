// Graceful restart: sends SIGTERM to existing process, then exits
// The caller should start a new instance after this
const pid = parseInt(process.argv[2])
if (!pid) { console.error('Usage: node restart-graceful.js <PID>'); process.exit(1) }

try {
  process.kill(pid, 'SIGTERM')
  console.log(`Sent SIGTERM to PID ${pid}`)
} catch (e) {
  console.log(`Process ${pid} already stopped or inaccessible: ${e.message}`)
}
