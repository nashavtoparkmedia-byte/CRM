const { loadEnvConfig } = require('@next/env')
loadEnvConfig(process.cwd())
const net = require('net')

async function pingEsl() {
  return new Promise(resolve => {
    const sock = net.createConnection({ host: '127.0.0.1', port: 8021 })
    sock.setTimeout(2000)
    sock.on('connect', () => { sock.end(); resolve('OK') })
    sock.on('error', e => resolve(`FAIL: ${e.message}`))
    sock.on('timeout', () => { sock.destroy(); resolve('TIMEOUT') })
  })
}

async function main() {
  console.log('ESL 8021:', await pingEsl())
  
  const { PrismaClient } = require('@prisma/client')
  const prisma = new PrismaClient()
  
  // All calls today (since midnight)
  const today = new Date(); today.setHours(0,0,0,0)
  const todayCalls = await prisma.call.count({ where: { startedAt: { gte: today } } })
  console.log(`Calls since midnight: ${todayCalls}`)
  
  // Most recent call regardless of time
  const last = await prisma.call.findFirst({
    orderBy: { startedAt: 'desc' },
    select: { id: true, startedAt: true, fromNumber: true, toNumber: true, status: true, direction: true, fsUuid: true, contactId: true },
  })
  console.log('Last call:', last)
  
  await prisma.$disconnect()
}
main().catch(e => { console.error(e); process.exit(1) })
