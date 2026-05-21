const { loadEnvConfig } = require('@next/env')
loadEnvConfig(process.cwd())

async function main() {
  // We need to bypass auth. Let's hit ESL directly and originate, then check Call row in 5s.
  const esl = require('modesl')
  const { randomUUID } = require('crypto')
  
  const channelUuid = randomUUID()
  console.log(`Originating with UUID: ${channelUuid}`)
  
  const conn = new esl.Connection('127.0.0.1', 8021, 'ClueCon', () => {
    // Need a real user/extension. Default = 102 (mixx).
    const cmd = `originate {origination_uuid=${channelUuid},origination_caller_id_number=79222155750,crm_user_id=cmnjf1ctd06trvp082hhyciz9,ignore_early_media=true,rtp_secure_media=false}sofia/gateway/megafon/79222155750 &bridge([sip_h_P-CRM-Outbound-Bridge=true]user/102)`
    conn.bgapi(cmd, (res) => {
      console.log('bgapi result:', res.getBody().trim())
      // Wait 3s, kill it, then check DB
      setTimeout(() => {
        conn.api(`uuid_kill ${channelUuid} ORIGINATOR_CANCEL`, () => {
          conn.disconnect()
          checkDb()
        })
      }, 3000)
    })
  })
  conn.on('error', e => console.error('ESL error:', e))
  
  async function checkDb() {
    const { PrismaClient } = require('@prisma/client')
    const prisma = new PrismaClient()
    
    // Wait for hangup event to propagate
    await new Promise(r => setTimeout(r, 2000))
    
    const call = await prisma.call.findUnique({ where: { fsUuid: channelUuid } })
    console.log('\nCall row for', channelUuid, ':')
    if (call) {
      console.log(`  ✓ FOUND id=${call.id} status=${call.status} from=${call.fromNumber} to=${call.toNumber}`)
    } else {
      console.log(`  ✗ NOT FOUND — ESL listener did not create Call row`)
    }
    await prisma.$disconnect()
    process.exit(0)
  }
}
main().catch(e => { console.error(e); process.exit(1) })
