const esl = require('modesl')
const conn = new esl.Connection('127.0.0.1', 8021, 'ClueCon', () => {
  // Show recent channels (last 5 in FS history) + dialplan-level errors via console_loglevel
  conn.api('show channels count', (r) => {
    console.log('show channels count:\n' + r.getBody())
    conn.api('show calls count', (r2) => {
      console.log('show calls count:\n' + r2.getBody())
      // Get the most recent CDR-like info via show channels — but FS doesn't store after-hangup. We need fs_cli console log.
      // Let's see how many ESL listeners are subscribed (status command).
      conn.api('status', (r3) => {
        console.log('status:\n' + r3.getBody().slice(0, 500))
        conn.disconnect()
        process.exit(0)
      })
    })
  })
})
setTimeout(() => { console.error('ESL timeout'); process.exit(1) }, 5000)
