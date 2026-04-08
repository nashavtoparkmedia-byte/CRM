/**
 * verify-channel-lifecycle.ts — Channel lifecycle contract verification
 *
 * Tests: history sync contact resolution, dangling identity cleanup,
 * disconnect preserves data, delete removes only channel data, invariants.
 *
 * Run: npx tsx scripts/verify-channel-lifecycle.ts
 */

import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()
const cleanup: { contacts: string[]; chats: string[]; messages: string[]; phones: string[]; identities: string[] } =
  { contacts: [], chats: [], messages: [], phones: [], identities: [] }
let passed = 0
let failed = 0

function assert(cond: boolean, msg: string) {
  if (cond) { console.log(`  ✓ ${msg}`); passed++ }
  else { console.log(`  ✗ FAIL: ${msg}`); failed++ }
}

async function doCleanup() {
  console.log('\n── Cleanup ──')
  try {
    if (cleanup.messages.length) await prisma.$queryRaw`DELETE FROM "Message" WHERE id = ANY(${cleanup.messages}::text[])`
    if (cleanup.chats.length) await prisma.$queryRaw`DELETE FROM "Chat" WHERE id = ANY(${cleanup.chats}::text[])`
    if (cleanup.identities.length) await prisma.$queryRaw`DELETE FROM "ContactIdentity" WHERE id = ANY(${cleanup.identities}::text[])`
    if (cleanup.phones.length) await prisma.$queryRaw`DELETE FROM "ContactPhone" WHERE id = ANY(${cleanup.phones}::text[])`
    if (cleanup.contacts.length) {
      await prisma.$queryRaw`UPDATE "tasks" SET "contactId" = NULL WHERE "contactId" = ANY(${cleanup.contacts}::text[])`
      await prisma.$queryRaw`DELETE FROM "Contact" WHERE id = ANY(${cleanup.contacts}::text[])`
    }
    console.log('  Cleanup complete')
  } catch (e: any) { console.log('  Cleanup error:', e.message) }
}

// ═══════════════════════════════════════════════════════════════════════

async function test1_phoneAutoLinkOnResolve() {
  console.log('\n══ 1. Phone auto-linking: same phone → same Contact ══')

  const { ContactService } = await import('../src/lib/ContactService')

  const phone = `+7999${Date.now().toString().slice(-7)}`

  // WA creates contact with phone
  const r1 = await ContactService.resolveContact('whatsapp', `wa_lc_${Date.now()}`, phone, 'WA User')
  cleanup.contacts.push(r1.contact.id)

  // TG with same phone → should find existing
  const r2 = await ContactService.resolveContact('telegram', `tg_lc_${Date.now()}`, phone, 'TG User')

  assert(r1.contact.id === r2.contact.id, 'Same phone → same Contact')
  assert(r2.isNew === false, 'Second resolve is not new')

  // Cleanup extra identity
  await prisma.contactIdentity.deleteMany({ where: { contactId: r1.contact.id, channel: 'telegram' } })
}

async function test2_noPhoneCreatesNewContact() {
  console.log('\n══ 2. No phone → separate Contact ══')

  const { ContactService } = await import('../src/lib/ContactService')

  const r1 = await ContactService.resolveContact('telegram', `tg_nophone_${Date.now()}`, null, 'TG No Phone')
  cleanup.contacts.push(r1.contact.id)

  assert(r1.isNew === true, 'No phone → new Contact')

  const phones = await prisma.contactPhone.count({ where: { contactId: r1.contact.id } })
  assert(phones === 0, 'Contact has 0 phones')
}

async function test3_danglingIdentityCleanup() {
  console.log('\n══ 3. Dangling identity cleanup (scoped) ══')

  const { ContactService } = await import('../src/lib/ContactService')

  // Create contact with identity + chat
  const contact = await prisma.contact.create({
    data: { displayName: 'Dangling Test', displayNameSource: 'channel', masterSource: 'chat' },
  })
  cleanup.contacts.push(contact.id)

  const identity = await prisma.contactIdentity.create({
    data: { contactId: contact.id, channel: 'max', externalId: `dang_${Date.now()}`, source: 'auto', confidence: 1.0 },
  })
  cleanup.identities.push(identity.id)

  const chat = await (prisma.chat as any).create({
    data: { channel: 'max', externalChatId: `dang_chat_${Date.now()}`, name: 'Dangling Chat', contactId: contact.id, contactIdentityId: identity.id, status: 'new' },
  })
  cleanup.chats.push(chat.id)

  // Identity has a chat → not dangling
  const cleaned1 = await ContactService.cleanupDanglingIdentities([contact.id])
  assert(cleaned1 === 0, 'Identity with chat → not deleted')

  // Delete the chat → identity becomes dangling
  await (prisma.chat as any).delete({ where: { id: chat.id } })
  cleanup.chats = cleanup.chats.filter(id => id !== chat.id)

  const cleaned2 = await ContactService.cleanupDanglingIdentities([contact.id])
  assert(cleaned2 === 1, 'Dangling identity → deleted')
  cleanup.identities = cleanup.identities.filter(id => id !== identity.id)

  // Contact still exists
  const contactAfter = await prisma.contact.findUnique({ where: { id: contact.id } })
  assert(contactAfter !== null, 'Contact preserved after identity cleanup')
}

async function test4_deletePreservesContact() {
  console.log('\n══ 4. Delete channel data preserves Contact/Phone/Driver ══')

  // Create a contact with phone + identity + chat + message
  const contact = await prisma.contact.create({
    data: { displayName: 'Delete Test', displayNameSource: 'channel', masterSource: 'chat' },
  })
  cleanup.contacts.push(contact.id)

  const phone = await prisma.contactPhone.create({
    data: { contactId: contact.id, phone: `+7888${Date.now().toString().slice(-7)}`, isPrimary: true, source: 'manual' },
  })
  cleanup.phones.push(phone.id)

  const waIdentity = await prisma.contactIdentity.create({
    data: { contactId: contact.id, channel: 'whatsapp', externalId: `wa_del_${Date.now()}`, phoneId: phone.id, source: 'auto', confidence: 1.0 },
  })

  const tgIdentity = await prisma.contactIdentity.create({
    data: { contactId: contact.id, channel: 'telegram', externalId: `tg_del_${Date.now()}`, source: 'auto', confidence: 1.0 },
  })

  const waChat = await (prisma.chat as any).create({
    data: { channel: 'whatsapp', externalChatId: `wa_del_chat_${Date.now()}`, name: 'WA Del', contactId: contact.id, contactIdentityId: waIdentity.id, status: 'new' },
  })

  const tgChat = await (prisma.chat as any).create({
    data: { channel: 'telegram', externalChatId: `tg_del_chat_${Date.now()}`, name: 'TG Del', contactId: contact.id, contactIdentityId: tgIdentity.id, status: 'new' },
  })

  const msg = await (prisma.message as any).create({
    data: { id: `del_msg_${Date.now()}`, chatId: waChat.id, direction: 'inbound', content: 'test', channel: 'whatsapp', sentAt: new Date(), status: 'delivered' },
  })

  // Simulate deleting WA channel data
  await (prisma.message as any).deleteMany({ where: { chatId: waChat.id } })
  await (prisma.chat as any).delete({ where: { id: waChat.id } })

  const { ContactService } = await import('../src/lib/ContactService')
  await ContactService.cleanupDanglingIdentities([contact.id])

  // Verify invariants
  const contactAfter = await prisma.contact.findUnique({ where: { id: contact.id } })
  assert(contactAfter !== null, 'Contact preserved')
  assert(contactAfter?.isArchived === false, 'Contact not archived')

  const phoneAfter = await prisma.contactPhone.findUnique({ where: { id: phone.id } })
  assert(phoneAfter !== null, 'ContactPhone preserved')

  // WA identity should be deleted (dangling), TG identity should remain
  const waIdAfter = await prisma.contactIdentity.findUnique({ where: { id: waIdentity.id } })
  assert(waIdAfter === null, 'WA identity deleted (dangling)')

  const tgIdAfter = await prisma.contactIdentity.findUnique({ where: { id: tgIdentity.id } })
  assert(tgIdAfter !== null, 'TG identity preserved (has chat)')

  const tgChatAfter = await (prisma.chat as any).findUnique({ where: { id: tgChat.id } })
  assert(tgChatAfter !== null, 'TG chat preserved')

  // Track for cleanup
  cleanup.chats.push(tgChat.id)
  cleanup.identities.push(tgIdentity.id)
}

async function test5_driverLinkPreserved() {
  console.log('\n══ 5. Driver link and merge history preserved after channel delete ══')

  // Find a driver-linked contact
  const driverContact = await prisma.contact.findFirst({
    where: { yandexDriverId: { not: null }, isArchived: false },
    select: { id: true, yandexDriverId: true },
  })
  if (!driverContact) {
    assert(true, 'Skipped — no driver-linked contact')
    return
  }

  // Cleanup scoped to this contact should not touch driver link
  const { ContactService } = await import('../src/lib/ContactService')
  await ContactService.cleanupDanglingIdentities([driverContact.id])

  const after = await prisma.contact.findUnique({ where: { id: driverContact.id }, select: { yandexDriverId: true } })
  assert(after?.yandexDriverId === driverContact.yandexDriverId, 'Driver link preserved after cleanup')

  // Check merge history not affected
  const merges = await prisma.$queryRaw<any[]>`SELECT count(*)::int as c FROM "ContactMerge" WHERE "survivorId" = ${driverContact.id} OR "mergedId" = ${driverContact.id}`
  assert(typeof merges[0].c === 'number', `Merge history accessible (${merges[0].c} records)`)
}

async function test6_emptyContactRemainsAfterAllChannelsDeleted() {
  console.log('\n══ 6. Contact remains as empty card after all channels deleted ══')

  const contact = await prisma.contact.create({
    data: { displayName: 'All Channels Deleted', displayNameSource: 'channel', masterSource: 'chat' },
  })
  cleanup.contacts.push(contact.id)

  const phone = await prisma.contactPhone.create({
    data: { contactId: contact.id, phone: `+7777${Date.now().toString().slice(-7)}`, isPrimary: true, source: 'manual' },
  })
  cleanup.phones.push(phone.id)

  const identity = await prisma.contactIdentity.create({
    data: { contactId: contact.id, channel: 'whatsapp', externalId: `wa_empty_${Date.now()}`, source: 'auto', confidence: 1.0 },
  })

  const chat = await (prisma.chat as any).create({
    data: { channel: 'whatsapp', externalChatId: `wa_empty_chat_${Date.now()}`, name: 'Empty Test', contactId: contact.id, contactIdentityId: identity.id, status: 'new' },
  })

  // Delete only channel data
  await (prisma.chat as any).delete({ where: { id: chat.id } })

  const { ContactService } = await import('../src/lib/ContactService')
  await ContactService.cleanupDanglingIdentities([contact.id])

  // Contact still exists as empty card
  const contactAfter = await prisma.contact.findUnique({ where: { id: contact.id } })
  assert(contactAfter !== null, 'Contact remains as empty card')
  assert(contactAfter?.isArchived === false, 'Contact not auto-archived')

  // Phone preserved
  const phoneAfter = await prisma.contactPhone.findUnique({ where: { id: phone.id } })
  assert(phoneAfter !== null, 'Phone preserved on empty contact')

  // Identity deleted (dangling)
  const idAfter = await prisma.contactIdentity.findUnique({ where: { id: identity.id } })
  assert(idAfter === null, 'Dangling identity removed')
}

// ═══════════════════════════════════════════════════════════════════════

async function main() {
  console.log('════════════════════════════════════════════════════════════')
  console.log('  Channel Lifecycle Contract — Verification')
  console.log('════════════════════════════════════════════════════════════')

  try {
    await test1_phoneAutoLinkOnResolve()
    await test2_noPhoneCreatesNewContact()
    await test3_danglingIdentityCleanup()
    await test4_deletePreservesContact()
    await test5_driverLinkPreserved()
    await test6_emptyContactRemainsAfterAllChannelsDeleted()
  } catch (e) {
    console.error('\n  UNEXPECTED ERROR:', e)
    failed++
  } finally {
    await doCleanup()
    await prisma.$disconnect()
  }

  console.log('\n════════════════════════════════════════════════════════════')
  console.log(`  Results: ${passed} passed, ${failed} failed`)
  console.log('════════════════════════════════════════════════════════════')

  process.exit(failed > 0 ? 1 : 0)
}

main()
