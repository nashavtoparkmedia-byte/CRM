/**
 * verify-workflow.ts — Verification for ConversationWorkflowService
 *
 * Run: npx tsx scripts/verify-workflow.ts
 */

import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

const cleanupIds: { chats: string[]; messages: string[] } = { chats: [], messages: [] }
let passed = 0
let failed = 0

function assert(condition: boolean, message: string) {
  if (condition) {
    console.log(`  ✓ ${message}`)
    passed++
  } else {
    console.log(`  ✗ FAIL: ${message}`)
    failed++
  }
}

async function cleanup() {
  console.log('\n── Cleanup ──')
  try {
    if (cleanupIds.messages.length > 0) {
      await prisma.$queryRaw`DELETE FROM "Message" WHERE id = ANY(${cleanupIds.messages}::text[])`
    }
    if (cleanupIds.chats.length > 0) {
      await prisma.$queryRaw`DELETE FROM "Chat" WHERE id = ANY(${cleanupIds.chats}::text[])`
    }
    console.log('  Cleanup complete')
  } catch (e: any) {
    console.log('  Cleanup error:', e.message)
  }
}

async function createTestChat(name: string, status = 'new') {
  const chat = await (prisma.chat as any).create({
    data: {
      channel: 'telegram',
      externalChatId: `test_wf_${Date.now()}_${Math.random().toString(36).substring(7)}`,
      name,
      status,
      lastMessageAt: new Date(),
    },
  })
  cleanupIds.chats.push(chat.id)
  return chat
}

async function loadWorkflowService() {
  const mod = await import('../src/lib/ConversationWorkflowService')
  return mod.ConversationWorkflowService
}

async function getChat(id: string) {
  // Use raw query to get all fields including those not in Prisma client types
  const rows = await prisma.$queryRaw<any[]>`
    SELECT id, status, "unreadCount", "requiresResponse",
           "assignedToUserId", "lastInboundAt", "lastOutboundAt",
           "contactId", "driverId"
    FROM "Chat" WHERE id = ${id}
  `
  return rows[0] || null
}

// ════════════════════════════════════════════════════════════════════════════
// TESTS
// ════════════════════════════════════════════════════════════════════════════

async function testBackfill() {
  console.log('\n══ Test 1: Backfill verification ══')

  const stats = await prisma.$queryRaw<any[]>`
    SELECT
      (SELECT count(*) FROM "Chat" WHERE status = 'active') as active_count,
      (SELECT count(*) FROM "Chat" WHERE status = 'open') as open_count,
      (SELECT count(*) FROM "Chat" WHERE "lastInboundAt" IS NOT NULL) as has_inbound,
      (SELECT count(*) FROM "Chat" WHERE "lastOutboundAt" IS NOT NULL) as has_outbound,
      (SELECT count(*) FROM "Chat" WHERE "requiresResponse" = true) as requires_response
  `
  const s = stats[0]
  assert(Number(s.active_count) === 0, `No chats with status='active' (got ${s.active_count})`)
  assert(Number(s.open_count) > 0, `Some chats with status='open' (got ${s.open_count})`)
  assert(Number(s.has_inbound) > 0, `lastInboundAt backfilled (${s.has_inbound} chats)`)
  assert(Number(s.has_outbound) > 0, `lastOutboundAt backfilled (${s.has_outbound} chats)`)
  assert(Number(s.requires_response) > 0, `requiresResponse backfilled (${s.requires_response} chats)`)
}

async function testInboundTransitions() {
  console.log('\n══ Test 2: onInboundMessage transitions ══')

  const WF = await loadWorkflowService()
  const now = new Date()

  // 2a. new → stays new, unread increments
  const chat1 = await createTestChat('Test Inbound New', 'new')
  await WF.onInboundMessage(chat1.id, now)
  const updated1 = await getChat(chat1.id)
  assert(updated1.status === 'new', 'new stays new on inbound')
  assert(updated1.unreadCount === 1, 'unreadCount incremented to 1')
  assert(updated1.requiresResponse === true, 'requiresResponse set to true')
  assert(updated1.lastInboundAt !== null, 'lastInboundAt set')

  // 2b. resolved → open
  const chat2 = await createTestChat('Test Inbound Resolved', 'resolved')
  await WF.onInboundMessage(chat2.id, now)
  const updated2 = await getChat(chat2.id)
  assert(updated2.status === 'open', 'resolved → open on inbound')

  // 2c. waiting_customer → open
  const chat3 = await createTestChat('Test Inbound WC', 'waiting_customer')
  await WF.onInboundMessage(chat3.id, now)
  const updated3 = await getChat(chat3.id)
  assert(updated3.status === 'open', 'waiting_customer → open on inbound')

  // 2d. open → stays open
  const chat4 = await createTestChat('Test Inbound Open', 'open')
  await WF.onInboundMessage(chat4.id, now)
  const updated4 = await getChat(chat4.id)
  assert(updated4.status === 'open', 'open stays open on inbound')

  // 2e. waiting_internal → stays waiting_internal
  const chat5 = await createTestChat('Test Inbound WI', 'waiting_internal')
  await WF.onInboundMessage(chat5.id, now)
  const updated5 = await getChat(chat5.id)
  assert(updated5.status === 'waiting_internal', 'waiting_internal stays on inbound')

  // 2f. Multiple inbound increments
  await WF.onInboundMessage(chat1.id, now)
  const updated1b = await getChat(chat1.id)
  assert(updated1b.unreadCount === 2, 'unreadCount incremented to 2 after second inbound')
}

async function testOutboundTransitions() {
  console.log('\n══ Test 3: onOutboundMessage transitions ══')

  const WF = await loadWorkflowService()
  const now = new Date()

  // 3a. new → open
  const chat1 = await createTestChat('Test Outbound New', 'new')
  await WF.onOutboundMessage(chat1.id, now)
  const updated1 = await getChat(chat1.id)
  assert(updated1.status === 'open', 'new → open on outbound')
  assert(updated1.requiresResponse === false, 'requiresResponse cleared on outbound')
  assert(updated1.lastOutboundAt !== null, 'lastOutboundAt set')

  // 3b. open → waiting_customer
  const chat2 = await createTestChat('Test Outbound Open', 'open')
  await WF.onOutboundMessage(chat2.id, now)
  const updated2 = await getChat(chat2.id)
  assert(updated2.status === 'waiting_customer', 'open → waiting_customer on outbound')

  // 3c. waiting_internal → waiting_customer
  const chat3 = await createTestChat('Test Outbound WI', 'waiting_internal')
  await WF.onOutboundMessage(chat3.id, now)
  const updated3 = await getChat(chat3.id)
  assert(updated3.status === 'waiting_customer', 'waiting_internal → waiting_customer on outbound')

  // 3d. resolved → open
  const chat4 = await createTestChat('Test Outbound Resolved', 'resolved')
  await WF.onOutboundMessage(chat4.id, now)
  const updated4 = await getChat(chat4.id)
  assert(updated4.status === 'open', 'resolved → open on outbound')

  // 3e. waiting_customer → stays
  const chat5 = await createTestChat('Test Outbound WC', 'waiting_customer')
  await WF.onOutboundMessage(chat5.id, now)
  const updated5 = await getChat(chat5.id)
  assert(updated5.status === 'waiting_customer', 'waiting_customer stays on outbound')
}

async function testAssignment() {
  console.log('\n══ Test 4: Assign / Unassign ══')

  const WF = await loadWorkflowService()

  // 4a. Assign to user
  const chat = await createTestChat('Test Assign', 'new')
  await WF.assignChat(chat.id, 'u1')
  const updated = await getChat(chat.id)
  assert(updated.assignedToUserId === 'u1', 'assignedToUserId set to u1')
  assert(updated.status === 'open', 'new → open on assign')

  // 4b. Unassign
  await WF.unassignChat(chat.id)
  const updated2 = await getChat(chat.id)
  assert(updated2.assignedToUserId === null, 'assignedToUserId cleared on unassign')

  // 4c. Assign open chat — status stays
  await WF.assignChat(chat.id, 'u2')
  const updated3 = await getChat(chat.id)
  assert(updated3.assignedToUserId === 'u2', 'Re-assigned to u2')
  assert(updated3.status === 'open', 'open stays open on assign')
}

async function testResolveReopen() {
  console.log('\n══ Test 5: Resolve / Reopen ══')

  const WF = await loadWorkflowService()
  const now = new Date()

  // 5a. Resolve
  const chat = await createTestChat('Test Resolve', 'open')
  // Set requiresResponse first
  await WF.onInboundMessage(chat.id, now)
  await WF.resolveChat(chat.id)
  const updated = await getChat(chat.id)
  assert(updated.status === 'resolved', 'status → resolved')
  assert(updated.requiresResponse === false, 'requiresResponse cleared on resolve')

  // 5b. Reopen
  await WF.reopenChat(chat.id)
  const updated2 = await getChat(chat.id)
  assert(updated2.status === 'open', 'status → open on reopen')

  // 5c. Inbound reopens resolved chat
  await WF.resolveChat(chat.id)
  await WF.onInboundMessage(chat.id, now)
  const updated3 = await getChat(chat.id)
  assert(updated3.status === 'open', 'resolved → open on inbound (reopen)')
}

async function testMarkRead() {
  console.log('\n══ Test 6: Mark Read ══')

  const WF = await loadWorkflowService()
  const now = new Date()

  const chat = await createTestChat('Test Read', 'new')
  await WF.onInboundMessage(chat.id, now)
  await WF.onInboundMessage(chat.id, now)
  const before = await getChat(chat.id)
  assert(before.unreadCount === 2, 'unreadCount is 2 before markRead')

  await WF.markRead(chat.id)
  const after = await getChat(chat.id)
  assert(after.unreadCount === 0, 'unreadCount is 0 after markRead')
}

async function testGroupOperations() {
  console.log('\n══ Test 7: Group operations (multi-channel) ══')

  const WF = await loadWorkflowService()

  // Create two chats sharing same contactId
  const contact = await prisma.contact.create({
    data: { displayName: 'Test Group', displayNameSource: 'channel', masterSource: 'chat' },
  })

  const chat1 = await (prisma.chat as any).create({
    data: {
      channel: 'telegram',
      externalChatId: `test_grp_tg_${Date.now()}`,
      name: 'Test Group TG',
      status: 'new',
      contactId: contact.id,
    },
  })
  cleanupIds.chats.push(chat1.id)

  const chat2 = await (prisma.chat as any).create({
    data: {
      channel: 'whatsapp',
      externalChatId: `test_grp_wa_${Date.now()}`,
      name: 'Test Group WA',
      status: 'new',
      contactId: contact.id,
    },
  })
  cleanupIds.chats.push(chat2.id)

  // Assign via chat1 — should affect both
  await WF.assignChat(chat1.id, 'u1')
  const c1 = await getChat(chat1.id)
  const c2 = await getChat(chat2.id)
  assert(c1.assignedToUserId === 'u1', 'Chat1 assigned to u1')
  assert(c2.assignedToUserId === 'u1', 'Chat2 also assigned to u1 (group)')

  // Resolve via chat2 — should affect both
  await WF.resolveChat(chat2.id)
  const c1r = await getChat(chat1.id)
  const c2r = await getChat(chat2.id)
  assert(c1r.status === 'resolved', 'Chat1 resolved (group)')
  assert(c2r.status === 'resolved', 'Chat2 resolved (group)')

  // markRead via chat1
  await WF.onInboundMessage(chat1.id, new Date())
  await WF.markRead(chat1.id)
  const c1m = await getChat(chat1.id)
  const c2m = await getChat(chat2.id)
  assert(c1m.unreadCount === 0, 'Chat1 unread=0 after markRead')
  assert(c2m.unreadCount === 0, 'Chat2 unread=0 (group markRead)')

  // Cleanup contact
  await prisma.$queryRaw`DELETE FROM "Contact" WHERE id = ${contact.id}`
}

async function testFullCycle() {
  console.log('\n══ Test 8: Full conversation lifecycle ══')

  const WF = await loadWorkflowService()

  // Simulate: new chat → inbound → assign → outbound → inbound → resolve → inbound (reopen)
  const chat = await createTestChat('Test Lifecycle', 'new')

  // Step 1: Inbound message
  await WF.onInboundMessage(chat.id, new Date())
  let state = await getChat(chat.id)
  assert(state.status === 'new', '1. Still new after first inbound')
  assert(state.unreadCount === 1, '1. unread=1')
  assert(state.requiresResponse === true, '1. requiresResponse=true')

  // Step 2: Operator assigns
  await WF.assignChat(chat.id, 'u1')
  state = await getChat(chat.id)
  assert(state.status === 'open', '2. new→open on assign')
  assert(state.assignedToUserId === 'u1', '2. assigned to u1')

  // Step 3: Operator reads
  await WF.markRead(chat.id)
  state = await getChat(chat.id)
  assert(state.unreadCount === 0, '3. unread=0 after markRead')

  // Step 4: Operator sends reply
  await WF.onOutboundMessage(chat.id, new Date())
  state = await getChat(chat.id)
  assert(state.status === 'waiting_customer', '4. open→waiting_customer')
  assert(state.requiresResponse === false, '4. requiresResponse cleared')

  // Step 5: Customer replies
  await WF.onInboundMessage(chat.id, new Date())
  state = await getChat(chat.id)
  assert(state.status === 'open', '5. waiting_customer→open')
  assert(state.unreadCount === 1, '5. unread=1')
  assert(state.requiresResponse === true, '5. requiresResponse=true')

  // Step 6: Resolve
  await WF.resolveChat(chat.id)
  state = await getChat(chat.id)
  assert(state.status === 'resolved', '6. resolved')

  // Step 7: Customer writes again (reopen)
  await WF.onInboundMessage(chat.id, new Date())
  state = await getChat(chat.id)
  assert(state.status === 'open', '7. resolved→open (reopen)')
  assert(state.unreadCount === 2, '7. unread=2')
  assert(state.assignedToUserId === 'u1', '7. assignment preserved after reopen')
}

// ════════════════════════════════════════════════════════════════════════════

async function main() {
  console.log('════════════════════════════════════════════════════════════')
  console.log('  ConversationWorkflowService Verification')
  console.log('════════════════════════════════════════════════════════════')

  try {
    await testBackfill()
    await testInboundTransitions()
    await testOutboundTransitions()
    await testAssignment()
    await testResolveReopen()
    await testMarkRead()
    await testGroupOperations()
    await testFullCycle()
  } catch (e) {
    console.error('\n  UNEXPECTED ERROR:', e)
    failed++
  } finally {
    await cleanup()
    await prisma.$disconnect()
  }

  console.log('\n════════════════════════════════════════════════════════════')
  console.log(`  Results: ${passed} passed, ${failed} failed`)
  console.log('════════════════════════════════════════════════════════════')

  process.exit(failed > 0 ? 1 : 0)
}

main()
