/**
 * verify-merge.ts — Verification script for ContactMergeService
 *
 * Tests all merge scenarios against the real database.
 * Uses test data created inside the script, cleaned up at the end.
 *
 * Run: npx tsx scripts/verify-merge.ts
 */

import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

// IDs to clean up at the end
const createdIds: {
  contacts: string[]
  phones: string[]
  identities: string[]
  chats: string[]
  merges: string[]
} = { contacts: [], phones: [], identities: [], chats: [], merges: [] }

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
    // Delete in correct order (respect FK constraints)
    if (createdIds.merges.length > 0) {
      await prisma.$queryRaw`DELETE FROM "ContactMerge" WHERE id = ANY(${createdIds.merges}::text[])`
    }
    if (createdIds.chats.length > 0) {
      await prisma.$queryRaw`DELETE FROM "Message" WHERE "chatId" = ANY(${createdIds.chats}::text[])`
      await prisma.$queryRaw`DELETE FROM "Chat" WHERE id = ANY(${createdIds.chats}::text[])`
    }
    if (createdIds.identities.length > 0) {
      await prisma.$queryRaw`DELETE FROM "ContactIdentity" WHERE id = ANY(${createdIds.identities}::text[])`
    }
    if (createdIds.phones.length > 0) {
      await prisma.$queryRaw`DELETE FROM "ContactPhone" WHERE id = ANY(${createdIds.phones}::text[])`
    }
    if (createdIds.contacts.length > 0) {
      // Must also clean up tasks referencing these contacts
      await prisma.$queryRaw`UPDATE "tasks" SET "contactId" = NULL WHERE "contactId" = ANY(${createdIds.contacts}::text[])`
      await prisma.$queryRaw`DELETE FROM "Contact" WHERE id = ANY(${createdIds.contacts}::text[])`
    }
    console.log('  Cleanup complete')
  } catch (e: any) {
    console.log('  Cleanup error:', e.message)
  }
}

// ── Helper: create test contact ──────────────────────────────────────────────

async function createTestContact(name: string, phone?: string, channel?: string, externalId?: string) {
  const contact = await prisma.contact.create({
    data: {
      displayName: name,
      displayNameSource: 'channel',
      masterSource: 'chat',
    },
  })
  createdIds.contacts.push(contact.id)

  let phoneId: string | null = null
  if (phone) {
    const cp = await prisma.contactPhone.create({
      data: { contactId: contact.id, phone, isPrimary: true, source: 'manual' },
    })
    createdIds.phones.push(cp.id)
    phoneId = cp.id
  }

  if (channel && externalId) {
    const ci = await prisma.contactIdentity.create({
      data: {
        contactId: contact.id,
        channel: channel as any,
        externalId,
        phoneId,
        source: 'auto',
        confidence: 1.0,
      },
    })
    createdIds.identities.push(ci.id)
  }

  return contact
}

async function createTestChat(contactId: string, identityId: string | null, channel: string, externalChatId: string) {
  const chat = await prisma.chat.create({
    data: {
      channel: channel as any,
      externalChatId,
      contactId,
      contactIdentityId: identityId,
      status: 'new',
    },
  })
  createdIds.chats.push(chat.id)
  return chat
}

// ── Import ContactMergeService dynamically ───────────────────────────────────

async function loadMergeService() {
  // Use dynamic import so we can use the same prisma instance
  const mod = await import('../src/lib/ContactMergeService')
  return mod.ContactMergeService
}

// ════════════════════════════════════════════════════════════════════════════
// TESTS
// ════════════════════════════════════════════════════════════════════════════

async function testPreconditions() {
  console.log('\n══ Test 1: Precondition checks ══')

  const ContactMergeService = await loadMergeService()

  // 1a. Contact not found
  console.log('\n  --- 1a. Contact not found ---')
  try {
    await ContactMergeService.mergeContactToDriver('nonexistent_id', 'some_driver')
    assert(false, 'Should throw CONTACT_NOT_FOUND')
  } catch (e: any) {
    assert(e.code === 'CONTACT_NOT_FOUND', `Throws CONTACT_NOT_FOUND (got ${e.code})`)
  }

  // 1b. Driver not found
  console.log('\n  --- 1b. Driver not found ---')
  const testContact = await createTestContact('Test Precondition')
  try {
    await ContactMergeService.mergeContactToDriver(testContact.id, 'nonexistent_driver')
    assert(false, 'Should throw DRIVER_NOT_FOUND')
  } catch (e: any) {
    assert(e.code === 'DRIVER_NOT_FOUND', `Throws DRIVER_NOT_FOUND (got ${e.code})`)
  }

  // 1c. Contact archived
  console.log('\n  --- 1c. Contact archived ---')
  await prisma.contact.update({ where: { id: testContact.id }, data: { isArchived: true } })
  // Get a real driver id
  const realDriver = await prisma.driver.findFirst({ select: { id: true } })
  try {
    await ContactMergeService.mergeContactToDriver(testContact.id, realDriver!.id)
    assert(false, 'Should throw CONTACT_ARCHIVED')
  } catch (e: any) {
    assert(e.code === 'CONTACT_ARCHIVED', `Throws CONTACT_ARCHIVED (got ${e.code})`)
  }
  // Restore for cleanup
  await prisma.contact.update({ where: { id: testContact.id }, data: { isArchived: false } })
}

async function testSimpleLink() {
  console.log('\n══ Test 2: Simple link (Driver has no Contact) ══')

  const ContactMergeService = await loadMergeService()

  // Find a driver and temporarily unlink its contact
  const driverWithContact = await prisma.driver.findFirst({
    where: { contactProfile: { isNot: null } },
    include: { contactProfile: true },
  })

  if (!driverWithContact || !driverWithContact.contactProfile) {
    console.log('  SKIP: No suitable driver found for simple link test')
    return
  }

  // Save original yandexDriverId of that contact, then unlink
  const originalContactId = driverWithContact.contactProfile.id
  const originalYandexId = driverWithContact.yandexDriverId

  await prisma.contact.update({
    where: { id: originalContactId },
    data: { yandexDriverId: null, masterSource: 'chat' },
  })

  try {
    // Create a fresh test contact
    const testContact = await createTestContact(
      'Test Simple Link',
      '+79999999901',
      'telegram',
      'test_simple_link_9901',
    )

    // Create a chat for this contact
    const identity = await prisma.contactIdentity.findFirst({ where: { contactId: testContact.id } })
    const chat = await createTestChat(testContact.id, identity?.id || null, 'telegram', 'test_simple_link_chat_9901')

    // Execute simple link
    const result = await ContactMergeService.mergeContactToDriver(testContact.id, driverWithContact.id)

    assert(result.status === 'linked', `Status is 'linked' (got ${result.status})`)

    // Verify contact is linked
    const updatedContact = await prisma.contact.findUnique({ where: { id: testContact.id } })
    assert(updatedContact?.yandexDriverId === originalYandexId, 'Contact.yandexDriverId is set')
    assert(updatedContact?.masterSource === 'yandex', 'masterSource updated to yandex')
    assert(updatedContact?.displayName === driverWithContact.fullName, `displayName updated to driver name "${driverWithContact.fullName}"`)

    // Verify chat.driverId is set
    const updatedChat = await prisma.chat.findUnique({ where: { id: chat.id } })
    assert(updatedChat?.driverId === driverWithContact.id, 'Chat.driverId is set')

    // Test idempotent call
    console.log('\n  --- Idempotent re-call ---')
    const result2 = await ContactMergeService.mergeContactToDriver(testContact.id, driverWithContact.id)
    assert(result2.status === 'already_linked', `Second call returns already_linked (got ${result2.status})`)

    // Unlink test contact so cleanup can proceed, restore original
    await prisma.contact.update({
      where: { id: testContact.id },
      data: { yandexDriverId: null },
    })
  } finally {
    // Restore original link
    await prisma.contact.update({
      where: { id: originalContactId },
      data: { yandexDriverId: originalYandexId, masterSource: 'yandex' },
    })
  }
}

async function testFullMerge() {
  console.log('\n══ Test 3: Full merge (Driver already has Contact) ══')

  const ContactMergeService = await loadMergeService()

  // Find a driver with a linked contact
  const driver = await prisma.driver.findFirst({
    where: { contactProfile: { isNot: null } },
    include: {
      contactProfile: {
        include: { phones: true, identities: true },
      },
    },
  })

  if (!driver || !driver.contactProfile) {
    console.log('  SKIP: No suitable driver found')
    return
  }

  const survivorId = driver.contactProfile.id
  console.log(`  Survivor: ${survivorId} (${driver.contactProfile.displayName})`)
  console.log(`  Driver: ${driver.id} (${driver.fullName})`)

  // Create a "merged" contact with different identities
  const mergedContact = await createTestContact(
    'Test Merged Contact',
    '+79999999902',
    'whatsapp',
    'test_merge_wa_9902',
  )

  // Add a second identity (MAX) to merged contact
  const maxIdentity = await prisma.contactIdentity.create({
    data: {
      contactId: mergedContact.id,
      channel: 'max',
      externalId: 'test_merge_max_9902',
      source: 'auto',
      confidence: 1.0,
    },
  })
  createdIds.identities.push(maxIdentity.id)

  // Create chats for merged contact
  const waIdentity = await prisma.contactIdentity.findFirst({ where: { contactId: mergedContact.id, channel: 'whatsapp' } })
  const chat1 = await createTestChat(mergedContact.id, waIdentity?.id || null, 'whatsapp', 'test_merge_wa_chat_9902')
  const chat2 = await createTestChat(mergedContact.id, maxIdentity.id, 'max', 'test_merge_max_chat_9902')

  // Count survivor's identities/phones before merge
  const survivorIdentitiesBefore = await prisma.contactIdentity.count({ where: { contactId: survivorId } })
  const survivorPhonesBefore = await prisma.contactPhone.count({ where: { contactId: survivorId } })

  // Execute full merge
  const result = await ContactMergeService.mergeContactToDriver(mergedContact.id, driver.id)

  assert(result.status === 'merged', `Status is 'merged' (got ${result.status})`)
  if (result.status === 'merged') {
    assert(result.survivorId === survivorId, 'survivorId matches')
    assert(result.mergedId === mergedContact.id, 'mergedId matches')

    // Track merge record for cleanup
    createdIds.merges.push(result.mergeRecordId)

    // Verify identities moved to survivor
    const survivorIdentitiesAfter = await prisma.contactIdentity.count({ where: { contactId: survivorId } })
    assert(survivorIdentitiesAfter === survivorIdentitiesBefore + 2, `Survivor gained 2 identities (before=${survivorIdentitiesBefore}, after=${survivorIdentitiesAfter})`)

    // Verify no identities left on merged
    const mergedIdentitiesAfter = await prisma.contactIdentity.count({ where: { contactId: mergedContact.id } })
    assert(mergedIdentitiesAfter === 0, `Merged contact has 0 identities (got ${mergedIdentitiesAfter})`)

    // Verify phones moved (deduplicated)
    const survivorPhonesAfter = await prisma.contactPhone.count({ where: { contactId: survivorId } })
    assert(survivorPhonesAfter === survivorPhonesBefore + 1, `Survivor gained 1 phone (before=${survivorPhonesBefore}, after=${survivorPhonesAfter})`)

    // Verify chats moved to survivor
    const movedChat1 = await prisma.chat.findUnique({ where: { id: chat1.id } })
    const movedChat2 = await prisma.chat.findUnique({ where: { id: chat2.id } })
    assert(movedChat1?.contactId === survivorId, 'Chat 1 moved to survivor')
    assert(movedChat2?.contactId === survivorId, 'Chat 2 moved to survivor')
    assert(movedChat1?.driverId === driver.id, 'Chat 1 has driverId set')
    assert(movedChat2?.driverId === driver.id, 'Chat 2 has driverId set')

    // Verify merged contact is archived
    const archivedContact = await prisma.contact.findUnique({ where: { id: mergedContact.id } })
    assert(archivedContact?.isArchived === true, 'Merged contact is archived')

    // Verify merge record
    const mergeRecords = await prisma.$queryRaw<any[]>`
      SELECT * FROM "ContactMerge" WHERE id = ${result.mergeRecordId}
    `
    assert(mergeRecords.length === 1, 'Merge record created')
    if (mergeRecords.length > 0) {
      const mr = mergeRecords[0]
      assert(mr.survivorId === survivorId, 'Merge record survivorId correct')
      assert(mr.mergedId === mergedContact.id, 'Merge record mergedId correct')
      assert(mr.action === 'merge', 'Merge record action=merge')
      assert(mr.reason === 'yandex_link', 'Merge record reason=yandex_link')
      assert(mr.driverYandexId === driver.yandexDriverId, `Merge record driverYandexId correct (${mr.driverYandexId})`)
      assert(mr.snapshotBefore != null, 'Merge record has snapshotBefore')

      // Verify snapshot structure
      const snapshot = typeof mr.snapshotBefore === 'string' ? JSON.parse(mr.snapshotBefore) : mr.snapshotBefore
      assert(snapshot.contact?.id === mergedContact.id, 'Snapshot has contact.id')
      assert(Array.isArray(snapshot.phones), 'Snapshot has phones array')
      assert(Array.isArray(snapshot.identities), 'Snapshot has identities array')
      assert(Array.isArray(snapshot.chatIds), 'Snapshot has chatIds array')
      assert(snapshot.identities.length === 2, `Snapshot has 2 identities (got ${snapshot.identities?.length})`)
    }

    // Test idempotent: re-merge archived contact should fail
    console.log('\n  --- Re-merge archived contact ---')
    try {
      await ContactMergeService.mergeContactToDriver(mergedContact.id, driver.id)
      assert(false, 'Should throw CONTACT_ARCHIVED')
    } catch (e: any) {
      assert(e.code === 'CONTACT_ARCHIVED', `Throws CONTACT_ARCHIVED (got ${e.code})`)
    }

    // Clean up: move identities/phones back from survivor so we don't pollute real data
    // The test identities have known externalIds
    await prisma.contactIdentity.deleteMany({
      where: {
        contactId: survivorId,
        externalId: { in: ['test_merge_wa_9902', 'test_merge_max_9902'] },
      },
    })
    await prisma.contactPhone.deleteMany({
      where: {
        contactId: survivorId,
        phone: '+79999999902',
      },
    })
    // Move chats back so cleanup can delete them
    await prisma.chat.updateMany({
      where: { id: { in: [chat1.id, chat2.id] } },
      data: { contactId: mergedContact.id, driverId: null },
    })
    // Un-archive for cleanup
    await prisma.contact.update({
      where: { id: mergedContact.id },
      data: { isArchived: false },
    })
    // Remove from identity tracking since we already cleaned up
    createdIds.identities = createdIds.identities.filter(
      id => id !== waIdentity?.id && id !== maxIdentity.id
    )
  }
}

async function testConflict() {
  console.log('\n══ Test 4: Conflict — Contact linked to different Driver ══')

  const ContactMergeService = await loadMergeService()

  // Find two different drivers with contacts
  const drivers = await prisma.driver.findMany({
    where: { contactProfile: { isNot: null } },
    include: { contactProfile: true },
    take: 2,
  })

  if (drivers.length < 2) {
    console.log('  SKIP: Need at least 2 drivers with contacts')
    return
  }

  const driver1 = drivers[0]
  const driver2 = drivers[1]

  // Try to merge driver1's contact to driver2 — should conflict
  try {
    await ContactMergeService.mergeContactToDriver(driver1.contactProfile!.id, driver2.id)
    assert(false, 'Should throw CONTACT_LINKED_TO_OTHER_DRIVER')
  } catch (e: any) {
    assert(e.code === 'CONTACT_LINKED_TO_OTHER_DRIVER', `Throws CONTACT_LINKED_TO_OTHER_DRIVER (got ${e.code})`)
  }
}

async function testDuplicateIdentityHandling() {
  console.log('\n══ Test 5: Duplicate identity handling during merge ══')

  const ContactMergeService = await loadMergeService()

  // Find a driver with contact that has a telegram identity
  const driver = await prisma.driver.findFirst({
    where: {
      contactProfile: {
        identities: { some: { channel: 'telegram' } },
      },
    },
    include: {
      contactProfile: {
        include: { identities: true, phones: true },
      },
    },
  })

  if (!driver || !driver.contactProfile) {
    console.log('  SKIP: No driver with telegram identity found')
    return
  }

  const survivorId = driver.contactProfile.id
  const survivorTgIdentity = driver.contactProfile.identities.find(i => i.channel === 'telegram')
  if (!survivorTgIdentity) {
    console.log('  SKIP: No telegram identity on survivor')
    return
  }

  console.log(`  Survivor has TG identity: ${survivorTgIdentity.externalId}`)

  // Create merged contact with a UNIQUE telegram identity (different externalId)
  const mergedContact = await createTestContact('Test Duplicate Identity')

  // Add a unique telegram identity (no conflict)
  const uniqueTgIdentity = await prisma.contactIdentity.create({
    data: {
      contactId: mergedContact.id,
      channel: 'telegram',
      externalId: 'test_dup_tg_unique_9903',
      source: 'auto',
      confidence: 1.0,
    },
  })
  createdIds.identities.push(uniqueTgIdentity.id)

  // Create a chat pointing to this identity
  const chat = await createTestChat(mergedContact.id, uniqueTgIdentity.id, 'telegram', 'test_dup_tg_chat_9903')

  // Execute merge
  const result = await ContactMergeService.mergeContactToDriver(mergedContact.id, driver.id)
  assert(result.status === 'merged', 'Merge succeeded')

  if (result.status === 'merged') {
    createdIds.merges.push(result.mergeRecordId)

    // Verify unique identity was moved (not deleted)
    const movedIdentity = await prisma.contactIdentity.findUnique({ where: { id: uniqueTgIdentity.id } })
    assert(movedIdentity?.contactId === survivorId, 'Unique identity moved to survivor')

    // Verify chat was moved and still points to the correct identity
    const movedChat = await prisma.chat.findUnique({ where: { id: chat.id } })
    assert(movedChat?.contactId === survivorId, 'Chat moved to survivor')
    assert(movedChat?.contactIdentityId === uniqueTgIdentity.id, 'Chat still points to correct identity')

    // Clean up
    await prisma.contactIdentity.deleteMany({
      where: { contactId: survivorId, externalId: 'test_dup_tg_unique_9903' },
    })
    await prisma.chat.updateMany({
      where: { id: chat.id },
      data: { contactId: mergedContact.id, driverId: null },
    })
    await prisma.contact.update({
      where: { id: mergedContact.id },
      data: { isArchived: false },
    })
    createdIds.identities = createdIds.identities.filter(id => id !== uniqueTgIdentity.id)
  }
}

async function testAlreadyLinked() {
  console.log('\n══ Test 6: Already linked — idempotent ══')

  const ContactMergeService = await loadMergeService()

  // Find a driver with contact
  const driver = await prisma.driver.findFirst({
    where: { contactProfile: { isNot: null } },
    include: { contactProfile: true },
  })

  if (!driver || !driver.contactProfile) {
    console.log('  SKIP: No suitable driver found')
    return
  }

  const result = await ContactMergeService.mergeContactToDriver(driver.contactProfile.id, driver.id)
  assert(result.status === 'already_linked', `Returns already_linked (got ${result.status})`)
}

// ════════════════════════════════════════════════════════════════════════════

async function main() {
  console.log('════════════════════════════════════════════════════════════')
  console.log('  ContactMergeService Verification')
  console.log('════════════════════════════════════════════════════════════')

  try {
    await testPreconditions()
    await testSimpleLink()
    await testFullMerge()
    await testConflict()
    await testDuplicateIdentityHandling()
    await testAlreadyLinked()
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
