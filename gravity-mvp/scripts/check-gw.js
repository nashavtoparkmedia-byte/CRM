const esl = require('modesl')
const conn = new esl.Connection('127.0.0.1', 8021, 'ClueCon', () => {
  conn.api('sofia status gateway megafon', (res) => {
    console.log(res.getBody())
    conn.disconnect()
    process.exit(0)
  })
})
conn.on('esl::end', () => process.exit(0))
setTimeout(() => { console.error('ESL timeout'); process.exit(1) }, 5000)
