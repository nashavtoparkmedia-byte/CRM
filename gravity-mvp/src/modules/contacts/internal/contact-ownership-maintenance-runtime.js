/* eslint-disable @typescript-eslint/no-require-imports */

/**
 * CommonJS bridge for legacy one-shot repair scripts that execute directly
 * under Node (and therefore cannot import the TypeScript application graph).
 * It uses the exact CNT1 admission key and lock order owned by the coordinator;
 * it is not a second planner or a generally exportable transaction helper.
 */
const { Prisma, PrismaClient } = require('@prisma/client')

const CLASS_ID = 0x594f4b4f // ASCII YOKO
const OBJECT_ID = 0x434e5431 // ASCII CNT1
const MAX_ROWS = 64

function assertRows(name, rows) {
  if (rows.length > MAX_ROWS) throw new Error(`${name} maintenance scope overflow`)
}

function bounded(values, name) {
  const unique = [...new Set((values || []).filter(Boolean))]
  if (unique.length > MAX_ROWS || unique.some(value => typeof value !== 'string' || value.length > 512)) {
    throw new TypeError(`${name} exceeds the bounded Contacts maintenance scope`)
  }
  return unique.sort()
}

function inList(values) {
  return Prisma.join(values.map(value => Prisma.sql`${value}`))
}

async function lockRows(transaction, input) {
  const contactIds = new Set(bounded(input.contactIds, 'contactIds'))
  const phoneIds = bounded(input.phoneIds, 'phoneIds')
  const identityIds = bounded(input.identityIds, 'identityIds')
  const identitySelectors = input.identities || []
  if (identitySelectors.length > MAX_ROWS) throw new TypeError('identities exceeds maintenance scope')
  const [phones, identities, selectedIdentities] = await Promise.all([
    phoneIds.length
      ? transaction.contactPhone.findMany({
          where: { id: { in: phoneIds } },
          select: { id: true, contactId: true, phone: true },
          take: MAX_ROWS + 1,
        })
      : [],
    identityIds.length
      ? transaction.contactIdentity.findMany({
          where: { id: { in: identityIds } },
          select: { id: true, contactId: true, phoneId: true },
          take: MAX_ROWS + 1,
        })
      : [],
    identitySelectors.length
      ? transaction.contactIdentity.findMany({
          where: {
            OR: identitySelectors.map(identity => ({
              channel: identity.channel,
              externalId: identity.externalId,
              ...(identity.contactId ? { contactId: identity.contactId } : {}),
            })),
          },
          select: { id: true, contactId: true, phoneId: true },
          take: MAX_ROWS + 1,
        })
      : [],
  ])
  assertRows('ContactPhone discovery', phones)
  assertRows('ContactIdentity discovery', identities)
  assertRows('ContactIdentity selector discovery', selectedIdentities)
  for (const row of phones) contactIds.add(row.contactId)
  for (const row of [...identities, ...selectedIdentities]) {
    contactIds.add(row.contactId)
    identityIds.push(row.id)
  }
  identityIds.sort()
  const contacts = [...contactIds].sort()

  if (contacts.length) {
    await transaction.$queryRaw`
      SELECT id FROM "Contact" WHERE id IN (${inList(contacts)}) ORDER BY id FOR UPDATE
    `
  }
  let allPhoneIds = [...new Set([...phoneIds, ...phones.map(row => row.id)])].sort()
  if (contacts.length || allPhoneIds.length) {
    const predicates = []
    if (contacts.length) predicates.push(Prisma.sql`"contactId" IN (${inList(contacts)})`)
    if (allPhoneIds.length) predicates.push(Prisma.sql`id IN (${inList(allPhoneIds)})`)
    const lockedPhones = await transaction.$queryRaw`
      SELECT id FROM "ContactPhone"
      WHERE ${Prisma.join(predicates, ' OR ')}
      ORDER BY id
      LIMIT ${MAX_ROWS + 1}
      FOR UPDATE
    `
    assertRows('ContactPhone', lockedPhones)
    allPhoneIds = [...new Set([...allPhoneIds, ...lockedPhones.map(row => row.id)])].sort()
  }
  if (contacts.length || identityIds.length || allPhoneIds.length) {
    const predicates = []
    if (contacts.length) predicates.push(Prisma.sql`"contactId" IN (${inList(contacts)})`)
    if (identityIds.length) predicates.push(Prisma.sql`id IN (${inList(identityIds)})`)
    if (allPhoneIds.length) predicates.push(Prisma.sql`"phoneId" IN (${inList(allPhoneIds)})`)
    const lockedIdentities = await transaction.$queryRaw`
      SELECT id FROM "ContactIdentity"
      WHERE ${Prisma.join(predicates, ' OR ')}
      ORDER BY id
      LIMIT ${MAX_ROWS + 1}
      FOR UPDATE
    `
    assertRows('ContactIdentity', lockedIdentities)
  }
  if (contacts.length) {
    const lockedMerges = await transaction.$queryRaw`
      SELECT id FROM "ContactMerge"
      WHERE "survivorId" IN (${inList(contacts)}) OR "mergedId" IN (${inList(contacts)})
      ORDER BY id
      LIMIT ${MAX_ROWS + 1}
      FOR UPDATE
    `
    assertRows('ContactMerge', lockedMerges)
  }
  return { contactIds: contacts, phoneIds: allPhoneIds, identityIds }
}

async function verify(transaction, scope) {
  const contacts = scope.contactIds.length
    ? await transaction.contact.findMany({
        where: { id: { in: scope.contactIds } },
      select: { id: true, primaryPhoneId: true },
      take: MAX_ROWS + 1,
    })
    : []
  assertRows('Contact verification', contacts)
  const duplicatePrimary = scope.contactIds.length
    ? await transaction.$queryRaw`
        SELECT "contactId" FROM "ContactPhone"
        WHERE "contactId" IN (${inList(scope.contactIds)})
          AND "isActive" = true
          AND "isPrimary" = true
        GROUP BY "contactId"
        HAVING COUNT(*) > 1
        ORDER BY "contactId"
        LIMIT 1
      `
    : []
  if (duplicatePrimary.length > 0) {
    throw new Error(`Contact ${duplicatePrimary[0].contactId} has multiple active primary phones`)
  }
  const unpointedPrimary = scope.contactIds.length
    ? await transaction.$queryRaw`
        SELECT phone.id, phone."contactId" FROM "ContactPhone" AS phone
        JOIN "Contact" AS contact ON contact.id = phone."contactId"
        WHERE contact.id IN (${inList(scope.contactIds)})
          AND phone."isActive" = true
          AND phone."isPrimary" = true
          AND (contact."primaryPhoneId" IS NULL OR contact."primaryPhoneId" <> phone.id)
        ORDER BY phone.id
        LIMIT 1
      `
    : []
  if (unpointedPrimary.length > 0) {
    throw new Error(
      `Primary phone ${unpointedPrimary[0].id} is not selected by Contact ${unpointedPrimary[0].contactId}`,
    )
  }
  for (const contact of contacts) {
    if (!contact.primaryPhoneId) continue
    const primary = await transaction.contactPhone.findFirst({
      where: {
        id: contact.primaryPhoneId,
        contactId: contact.id,
        isActive: true,
        isPrimary: true,
      },
      select: { id: true },
    })
    if (!primary) throw new Error(`Invalid primaryPhoneId for ${contact.id}`)
  }
  const identities = scope.contactIds.length
    ? await transaction.contactIdentity.findMany({
        where: { contactId: { in: scope.contactIds }, phoneId: { not: null } },
      select: { id: true, contactId: true, phoneId: true },
      take: MAX_ROWS + 1,
    })
    : []
  assertRows('ContactIdentity verification', identities)
  for (const identity of identities) {
    const phone = await transaction.contactPhone.findUnique({
      where: { id: identity.phoneId },
      select: { contactId: true },
    })
    if (!phone || phone.contactId !== identity.contactId) {
      throw new Error(`Identity ${identity.id} points outside its Contact`)
    }
  }
}

async function runContactOwnershipMaintenance(input, operation) {
  const client = new PrismaClient()
  try {
    return await client.$transaction(async transaction => {
      // First DB operation: bounded timeout setup plus CNT1 xact admission.
      await transaction.$queryRaw`
        WITH policy AS MATERIALIZED (
          SELECT set_config('lock_timeout', '2000ms', true) AS configured
        )
        SELECT pg_advisory_xact_lock(
          CAST(${CLASS_ID} AS integer) + octet_length(configured) * 0,
          CAST(${OBJECT_ID} AS integer)
        ) IS NULL AS admitted
        FROM policy
      `
      const scope = await lockRows(transaction, input)
      const result = await operation(transaction)
      await verify(transaction, scope)
      return result
    }, { isolationLevel: 'ReadCommitted', maxWait: 2000, timeout: 10000 })
  } finally {
    await client.$disconnect()
  }
}

async function updateIdentity(identityId, phoneId, data) {
  return runContactOwnershipMaintenance(
    { identityIds: [identityId], phoneIds: phoneId ? [phoneId] : [] },
    async transaction => {
      const identity = await transaction.contactIdentity.findUnique({ where: { id: identityId } })
      if (!identity) throw new Error(`Identity ${identityId} not found`)
      if (phoneId) {
        const phone = await transaction.contactPhone.findUnique({ where: { id: phoneId } })
        if (!phone || phone.contactId !== identity.contactId) {
          throw new Error(`Phone ${phoneId} is not owned by identity Contact ${identity.contactId}`)
        }
      }
      return transaction.contactIdentity.update({ where: { id: identityId }, data })
    },
  )
}

async function deactivatePhone(phoneId) {
  return runContactOwnershipMaintenance({ phoneIds: [phoneId] }, async transaction => {
    const phone = await transaction.contactPhone.findUnique({ where: { id: phoneId } })
    if (!phone) return null
    const result = await transaction.contactPhone.update({
      where: { id: phoneId },
      data: { isActive: false, isPrimary: false },
    })
    await transaction.contact.updateMany({
      where: { id: phone.contactId, primaryPhoneId: phone.id },
      data: { primaryPhoneId: null },
    })
    return result
  })
}

module.exports = {
  deactivatePhone,
  runContactOwnershipMaintenance,
  updateIdentity,
}
