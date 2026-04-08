'use strict'

const { PrismaClient } = require('@prisma/client')
const http = require('http')

const prisma = new PrismaClient()

async function main() {
  const id = 'job_' + Date.now()
  const mode = 'available_history'
  const crmApiUrl = 'http://localhost:3002'

  await prisma.$executeRaw`
    INSERT INTO "HistoryImportJob" (id, channels, mode, "daysBack", status, "chatsScanned", "contactsFound", "messagesImported", "createdAt")
    VALUES (
      ${id},
      ARRAY['max']::text[],
      'available_history'::"AiImportMode",
      NULL,
      'queued'::"AiImportStatus",
      0, 0, 0,
      NOW()
    )
  `
  console.log('Job создан:', id)

  const body = JSON.stringify({ jobId: id, crmApiUrl, mode, daysBack: null })
  const req = http.request({
    hostname: 'localhost',
    port: 3005,
    path: '/import-history',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  }, res => {
    let data = ''
    res.on('data', d => data += d)
    res.on('end', () => {
      console.log('Scraper response:', data)
      process.exit(0)
    })
  })
  req.on('error', e => { console.error('Error:', e.message); process.exit(1) })
  req.write(body)
  req.end()
}

main().catch(e => { console.error(e.message); process.exit(1) })
