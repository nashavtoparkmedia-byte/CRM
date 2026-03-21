require('dotenv').config()
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()
const fs = require('fs')

async function main() {
  const logFile = 'tg_conn_check.txt'
  const log = (msg) => fs.appendFileSync(logFile, msg + '\n')
  if (fs.existsSync(logFile)) fs.unlinkSync(logFile)

  log('--- TG CONNECTION CHECK ---')
  const conns = await prisma.telegramConnection.findMany({
    where: { isActive: true }
  })
  log(`Found ${conns.length} active connections`)
  
  for (const c of conns) {
    log(`ID: ${c.id} | Name: ${c.name} | Phone: ${c.phoneNumber}`)
    log(`  Session length: ${c.sessionString?.length || 0}`)
    log(`  IsDefault: ${c.isDefault}`)
  }

  log('--- TG CONNECTION CHECK END ---')
}

main().catch(e => fs.appendFileSync('tg_conn_check.txt', e.message)).finally(() => prisma.$disconnect())
