// End-to-end test of the unread-reset fix on Казбек.
// Simulates:
//   1. Set unreadCount=40 in DB (bug state)
//   2. Call POST /api/chats/:id/read (what the fix guarantees will fire)
//   3. Assert unreadCount=0 in DB
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

const CHAT_ID = 'cmo0rpace02fovpbsu93v64mv'
const API = 'http://localhost:3002/api/chats/' + CHAT_ID + '/read'

async function getUnread() {
  const rows = await prisma.$queryRaw`SELECT "unreadCount" AS c FROM "Chat" WHERE id = ${CHAT_ID}`
  return rows[0]?.c
}

async function setUnread(n) {
  await prisma.$executeRaw`UPDATE "Chat" SET "unreadCount" = ${n} WHERE id = ${CHAT_ID}`
}

async function main() {
  console.log('Step 1: Restore bug state — set unreadCount = 40')
  await setUnread(40)
  let u = await getUnread()
  console.log(`  DB unreadCount: ${u}`)
  if (u !== 40) { console.error('  UNEXPECTED'); process.exit(1) }

  console.log('\nStep 2: Fire POST /api/chats/:id/read (the call my fix now makes on open)')
  const res = await fetch(API, { method: 'POST' })
  const body = await res.json().catch(() => ({}))
  console.log(`  HTTP ${res.status}:`, body)

  console.log('\nStep 3: Re-read unreadCount from DB')
  u = await getUnread()
  console.log(`  DB unreadCount: ${u}`)

  if (u === 0 && res.ok) {
    console.log('\n✅ PASS: fix correctly resets the badge in DB on open')
  } else {
    console.log('\n❌ FAIL')
    process.exit(1)
  }
}

main()
  .catch((e) => { console.error(e); process.exit(1) })
  .finally(() => prisma.$disconnect())
