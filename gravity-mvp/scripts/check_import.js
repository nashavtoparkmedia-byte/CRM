'use strict'

const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

async function main() {
  const jobs = await prisma.$queryRaw`
    SELECT id, status, "messagesImported", "chatsScanned", "contactsFound",
           "coveredPeriodFrom", "coveredPeriodTo", "startedAt", "finishedAt"
    FROM "HistoryImportJob"
    ORDER BY "createdAt" DESC
    LIMIT 3
  `
  for (const j of jobs) {
    console.log(`
Job: ${j.id}
  status:   ${j.status}
  messages: ${j.messagesImported}
  chats:    ${j.chatsScanned}
  contacts: ${j.contactsFound}
  period:   ${j.coveredPeriodFrom ? new Date(j.coveredPeriodFrom).toLocaleDateString('ru') : '—'} → ${j.coveredPeriodTo ? new Date(j.coveredPeriodTo).toLocaleDateString('ru') : '—'}
  started:  ${j.startedAt}
  finished: ${j.finishedAt}
    `)
  }
  process.exit(0)
}

main().catch(e => { console.error(e.message); process.exit(1) })
