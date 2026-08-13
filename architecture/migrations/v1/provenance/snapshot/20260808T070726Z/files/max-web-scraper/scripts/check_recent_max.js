'use strict'
require('dotenv').config({ path: require('path').join(__dirname, '../../gravity-mvp/.env') })
const { PrismaClient } = require('@prisma/client')
const p = new PrismaClient()

async function main() {
  const msgs = await p.message.findMany({
    where: { channel: 'max' },
    orderBy: { sentAt: 'desc' },
    take: 15,
    include: { attachments: { select: { id: true, type: true, url: true, mimeType: true, fileName: true } } }
  })
  for (const m of msgs) {
    const attSummary = m.attachments.map(a => `${a.type}:${(a.url || '').slice(0, 80)}`).join(' | ')
    console.log(`[${m.sentAt.toISOString().slice(11,19)}] ${m.type} ${m.direction} ${JSON.stringify(m.content).slice(0,50)} ${attSummary ? '→ ' + attSummary : ''}`)
  }
}
main().catch(console.error).finally(() => p.$disconnect())
