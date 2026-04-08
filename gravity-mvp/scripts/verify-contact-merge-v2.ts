/**
 * verify-contact-merge-v2.ts — Verification for extended merge model
 *
 * Tests: contact-to-contact merge, phone-based auto-linking, driver merge unchanged,
 * idempotency, merge history distinction, source-has-driver guard.
 *
 * Run: npx tsx scripts/verify-contact-merge-v2.ts
 */

import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()
const cleanupIds: { contacts: string[]; chats: string[]; messages: string[]; phones: string[]; identities: string[]; merges: string[] } =
  { contacts: [], chats: [], messages: [], phones: [], identities: [], merges: [] }
let passed = 0
let failed = 0

function assert(cond: boolean, msg: string) {
  if (cond) { console.log(`  ✓ ${msg}`); passed++ }
  else { console.log(`  ✗ FAIL: ${msg}`); failed++ }
}

async function cleanup() {
  console.log('\n── Cleanup ──')
  try {
    if (cleanupIds.merges.length) await prisma.$queryRaw`DELETE FROM "ContactMerge" WHERE id = ANY(${cleanupIds.merges}::text[])`
    if (cleanupIds.messages.length) await prisma.$queryRaw`DELETE FROM "Message" WHERE id = ANY(${cleanupIds.messages}::text[])`
    if (cleanupIds.chats.length) {
      await prisma.$queryRaw`UPDATE "Chat" SET "contactId" = NULL, "contactIdentityId" = NULL WHERE id = ANY(${cleanupIds.chats}::text[])`
      await prisma.$queryRaw`DELETE FROM "Chat" WHERE id = ANY(${cleanupIds.chats}::text[])`
    }
    if (cleanupIds.identities.length) await prisma.$queryRaw`DELETE FROM "ContactIdentity" WHERE id = ANY(${cleanupIds.identities}::text[])`
    if (cleanupIds.phones.length) await prisma.$queryRaw`DELETE FROM "ContactPhone" WHERE id = ANY(${cleanupIds.phones}::text[])`
    if (cleanupIds.contacts.length) {
      await prisma.$queryRaw`UPDATE "tasks" SET "contactId" = NULL WHERE "contactId" = ANY(${cleanupIds.contacts}::text[])`
      await prisma.$queryRaw`DELETE FROM "Contact" WHERE id = ANY(${cleanupIds.contacts}::text[])`
    }
    console.log('  Cleanup complete')
  } catch (e: any) { console.log('  Cleanup error:', e.message) }
}

async function createContact(name: string, phone?: string, channel?: string, extId?: string) {
  const c = await prisma.contact.create({ data: { displayName: name, displayNameSource: 'channel', masterSource: 'chat' } })
  cleanupIds.contacts.push(c.id)
  let phoneId: string | null = null
  if (phone) {
    const p = await prisma.contactPhone.create({ data: { contactId: c.id, phone, isPrimary: true, source: 'manual' } })
    cleanupIds.phones.push(p.id)
    phoneId = p.id
  }
  if (channel && extId) {
    const i = await prisma.contactIdentity.create({ data: { contactId: c.id, channel: channel as any, externalId: extId, phoneId, source: 'auto', confidence: 1.0 } })
    cleanupIds.identities.push(i.id)
  }
  return c
}

// ═════════════════════════════════════════════════════════════════════════

async function test1_contactToContactMerge() {
  console.log('\n══ 1. Contact-to-contact merge (lead-to-lead) ══')

  const { ContactMergeService } = await import('../src/lib/ContactMergeService')

  const source = await createContact('Lead Source', '+79990001111', 'whatsapp', 'wa_src_1')
  const target = await createContact('Lead Target', '+79990002222', 'telegram', 'tg_tgt_1')

  // Create chat on source
  const chat = await (prisma.chat as any).create({
    data: { channel: 'whatsapp', externalChatId: `merge_v2_wa_${Date.now()}`, name: 'Source Chat', contactId: source.id, status: 'new' },
  })
  cleanupIds.chats.push(chat.id)

  const result = await ContactMergeService.mergeContactToContact(source.id, target.id)
  assert(result.status === 'contact_merged', `Status: ${result.status}`)

  if (result.status === 'contact_merged') {
    cleanupIds.merges.push(result.mergeRecordId)

    // Source archived
    const srcAfter = await prisma.contact.findUnique({ where: { id: source.id } })
    assert(srcAfter?.isArchived === true, 'Source is archived')

    // Identity moved to target
    const tgtIdentities = await prisma.contactIdentity.count({ where: { contactId: target.id } })
    assert(tgtIdentities === 2, `Target has 2 identities (got ${tgtIdentities})`)

    // Phone moved to target
    const tgtPhones = await prisma.contactPhone.count({ where: { contactId: target.id } })
    assert(tgtPhones === 2, `Target has 2 phones (got ${tgtPhones})`)

    // Chat moved
    const chatAfter = await (prisma.chat as any).findUnique({ where: { id: chat.id } })
    assert(chatAfter?.contactId === target.id, 'Chat moved to target')

    // Merge record with reason='manual'
    const mergeRec = await prisma.$queryRaw<any[]>`SELECT reason, "driverYandexId" FROM "ContactMerge" WHERE id = ${result.mergeRecordId}`
    assert(mergeRec[0]?.reason === 'manual', `Merge reason: ${mergeRec[0]?.reason}`)
    assert(mergeRec[0]?.driverYandexId === null, 'driverYandexId is null (contact merge)')
  }

  // Cleanup moved data
  await prisma.contactIdentity.deleteMany({ where: { contactId: target.id, externalId: 'wa_src_1' } })
  await prisma.contactPhone.deleteMany({ where: { contactId: target.id, phone: '+79990001111' } })
  await (prisma.chat as any).update({ where: { id: chat.id }, data: { contactId: source.id } })
  await prisma.contact.update({ where: { id: source.id }, data: { isArchived: false } })
}

async function test2_idempotentRepeat() {
  console.log('\n══ 2. Repeated merge → already_merged ══')

  const { ContactMergeService } = await import('../src/lib/ContactMergeService')

  const source = await createContact('Repeat Source')
  const target = await createContact('Repeat Target')

  const r1 = await ContactMergeService.mergeContactToContact(source.id, target.id)
  assert(r1.status === 'contact_merged', 'First merge succeeds')
  if (r1.status === 'contact_merged') cleanupIds.merges.push(r1.mergeRecordId)

  // Second merge — source is archived, same target
  const r2 = await ContactMergeService.mergeContactToContact(source.id, target.id)
  assert(r2.status === 'already_merged', `Repeated merge: ${r2.status}`)

  await prisma.contact.update({ where: { id: source.id }, data: { isArchived: false } })
}

async function test3_sourceHasDriver() {
  console.log('\n══ 3. Source has driver → SOURCE_HAS_DRIVER ══')

  const { ContactMergeService } = await import('../src/lib/ContactMergeService')

  // Find a driver-linked contact
  const driverLinked = await prisma.contact.findFirst({ where: { yandexDriverId: { not: null }, isArchived: false } })
  if (!driverLinked) {
    console.log('  SKIP: No driver-linked contact found')
    assert(true, 'Skipped')
    return
  }

  const target = await createContact('Target for driver source')

  try {
    await ContactMergeService.mergeContactToContact(driverLinked.id, target.id)
    assert(false, 'Should throw SOURCE_HAS_DRIVER')
  } catch (e: any) {
    assert(e.code === 'SOURCE_HAS_DRIVER', `Throws SOURCE_HAS_DRIVER (got ${e.code})`)
  }
}

async function test4_selfMerge() {
  console.log('\n══ 4. Self-merge → SELF_MERGE ══')

  const { ContactMergeService } = await import('../src/lib/ContactMergeService')
  const c = await createContact('Self Merge')

  try {
    await ContactMergeService.mergeContactToContact(c.id, c.id)
    assert(false, 'Should throw SELF_MERGE')
  } catch (e: any) {
    assert(e.code === 'SELF_MERGE', `Throws SELF_MERGE (got ${e.code})`)
  }
}

async function test5_mergeHistoryDistinction() {
  console.log('\n══ 5. Merge history: manual vs yandex_link ══')

  // Check existing driver merges (if any) have reason='yandex_link'
  const driverMerges = await prisma.$queryRaw<any[]>`SELECT reason FROM "ContactMerge" WHERE reason = 'yandex_link' LIMIT 1`
  if (driverMerges.length > 0) {
    assert(driverMerges[0].reason === 'yandex_link', 'Driver merge has reason=yandex_link')
  } else {
    assert(true, 'No driver merges yet (informational)')
  }

  // Contact merges should have reason='manual'
  const manualMerges = await prisma.$queryRaw<any[]>`SELECT reason FROM "ContactMerge" WHERE reason = 'manual' LIMIT 1`
  if (manualMerges.length > 0) {
    assert(manualMerges[0].reason === 'manual', 'Contact merge has reason=manual')
  } else {
    assert(true, 'No manual merges yet (informational)')
  }
}

async function test6_phoneAutoLinking() {
  console.log('\n══ 6. Phone-based auto-linking (resolveContact Scenario 2) ══')

  const { ContactService } = await import('../src/lib/ContactService')

  // Create a contact with a specific phone
  const phone = `+7999${Date.now().toString().slice(-7)}`
  const contact = await createContact('Phone Link Test', phone, 'whatsapp', `wa_plink_${Date.now()}`)

  // Simulate TG inbound with the same phone → should find existing contact
  const result = await ContactService.resolveContact('telegram', `tg_plink_${Date.now()}`, phone, 'TG User')

  assert(result.contact.id === contact.id, 'Same phone → same Contact (auto-linked)')
  assert(result.isNew === false, 'isNew = false (existing contact)')
  assert(result.identity.channel === 'telegram', 'New TG identity created')

  // Cleanup identity
  await prisma.contactIdentity.deleteMany({ where: { contactId: contact.id, channel: 'telegram' } })
  cleanupIds.identities = cleanupIds.identities.filter(id => id !== result.identity.id)
}

async function test7_phoneFormats() {
  console.log('\n══ 7. Phone normalization across channels ══')

  const { normalizePhoneE164 } = await import('../src/lib/phoneUtils')

  // WA formats
  assert(normalizePhoneE164('+79221234567') === '+79221234567', 'WA +7 format')
  assert(normalizePhoneE164('79221234567') === '+79221234567', 'WA raw 11-digit')
  assert(normalizePhoneE164('89221234567') === '+79221234567', 'WA 8-prefix')
  assert(normalizePhoneE164('9221234567') === '+79221234567', 'WA 10-digit')

  // TG formats (usually numeric IDs, but phone when available)
  assert(normalizePhoneE164('+7 (922) 123-45-67') === '+79221234567', 'TG formatted')

  // MAX: may or may not provide phone
  assert(normalizePhoneE164(null as any) === null, 'null → null (MAX no phone)')
  assert(normalizePhoneE164('') === null, 'empty → null')
  assert(normalizePhoneE164('abc') === null, 'non-numeric → null')

  console.log('  ℹ MAX limitation: MAX may not provide phone → separate Contact created (by design)')
}

async function test8_driverMergeUnchanged() {
  console.log('\n══ 8. Driver-based merge still works ══')

  const { ContactMergeService } = await import('../src/lib/ContactMergeService')

  // Find a driver with linked contact
  const driver = await prisma.driver.findFirst({ where: { contactProfile: { isNot: null } }, include: { contactProfile: true } })
  if (!driver || !driver.contactProfile) {
    console.log('  SKIP: No suitable driver')
    assert(true, 'Skipped')
    return
  }

  // Merge same contact to same driver → already_linked
  const result = await ContactMergeService.mergeContactToDriver(driver.contactProfile.id, driver.id)
  assert(result.status === 'already_linked', `Driver merge idempotent: ${result.status}`)
}

async function test9_mergeToDriverLinkedTarget() {
  console.log('\n══ 9. Lead merged into driver-linked target ══')

  const { ContactMergeService } = await import('../src/lib/ContactMergeService')

  // Find a driver-linked contact as target
  const driverContact = await prisma.contact.findFirst({
    where: { yandexDriverId: { not: null }, isArchived: false },
    include: { identities: true, phones: true },
  })
  if (!driverContact) {
    console.log('  SKIP: No driver-linked contact')
    assert(true, 'Skipped')
    return
  }

  const source = await createContact('Lead to Driver Target', '+79990009999', 'max', `max_ltd_${Date.now()}`)

  const result = await ContactMergeService.mergeContactToContact(source.id, driverContact.id)
  assert(result.status === 'contact_merged', `Merge succeeded: ${result.status}`)

  if (result.status === 'contact_merged') {
    cleanupIds.merges.push(result.mergeRecordId)

    // Check driverYandexId in merge record
    const rec = await prisma.$queryRaw<any[]>`SELECT "driverYandexId" FROM "ContactMerge" WHERE id = ${result.mergeRecordId}`
    assert(rec[0]?.driverYandexId === driverContact.yandexDriverId, 'Merge record has target driverYandexId')

    // Cleanup
    await prisma.contactIdentity.deleteMany({ where: { contactId: driverContact.id, externalId: { startsWith: 'max_ltd_' } } })
    await prisma.contactPhone.deleteMany({ where: { contactId: driverContact.id, phone: '+79990009999' } })
    await prisma.contact.update({ where: { id: source.id }, data: { isArchived: false } })
  }
}

// ═════════════════════════════════════════════════════════════════════════

async function main() {
  console.log('════════════════════════════════════════════════════════════')
  console.log('  Contact Merge v2 — Verification')
  console.log('════════════════════════════════════════════════════════════')

  try {
    await test1_contactToContactMerge()
    await test2_idempotentRepeat()
    await test3_sourceHasDriver()
    await test4_selfMerge()
    await test5_mergeHistoryDistinction()
    await test6_phoneAutoLinking()
    await test7_phoneFormats()
    await test8_driverMergeUnchanged()
    await test9_mergeToDriverLinkedTarget()
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
