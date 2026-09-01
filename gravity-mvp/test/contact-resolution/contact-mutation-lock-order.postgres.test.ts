import { ContactPhoneSource, PrismaClient, type Prisma } from '@prisma/client'
import { createRequire } from 'node:module'
import { NextRequest } from 'next/server'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'

import { DELETE, PATCH } from '@/app/api/contacts/[id]/phones/[phoneId]/route'
import { POST as ADD_PHONE } from '@/app/api/contacts/[id]/phones/route'
import {
  ContactRetentionEligibilityChangedError,
  DELETE_CONTACT_FOR_RETENTION_COMMAND_V1,
} from '@/contracts/contacts/v1'
import { ContactMergeService } from '@/lib/ContactMergeService'
import { ContactService } from '@/lib/ContactService'
import {
  CONTACT_OWNERSHIP_ADVISORY_CLASS_ID,
  CONTACT_OWNERSHIP_ADVISORY_OBJECT_ID,
  ContactOwnershipBusyError,
  ContactOwnershipInvariantError,
  assertContactOwnershipPostconditions,
  lockContactOwnershipRows,
  runContactOwnershipTransaction,
} from '@/modules/contacts/internal/contact-ownership-coordinator'
import {
  deleteContactForRetentionV1,
  expireTemporaryContactPhonesV1,
  reconcileFleetContactOwnershipV1,
} from '@/modules/contacts/public/v1'
import { prisma } from '@/lib/prisma'

const TEST_DATABASE_URL = process.env.CONTACT_RESOLUTION_TEST_DATABASE_URL
const REQUIRE_DATABASE = process.env.REQUIRE_CONTACT_RESOLUTION_DB_TESTS === '1'
const TEST_GATE_OBJECT_ID = 0x54455354 // ASCII TEST
const PHONE = '+79997770001'
const OTHER_PHONE = '+79997770002'
const require = createRequire(import.meta.url)
const { runContactOwnershipMaintenance } = require(
  '../../src/modules/contacts/internal/contact-ownership-maintenance-runtime.js',
) as {
  runContactOwnershipMaintenance: (
    input: { contactIds: string[] },
    operation: (transaction: Prisma.TransactionClient) => Promise<unknown>,
  ) => Promise<unknown>
}

if (REQUIRE_DATABASE && !TEST_DATABASE_URL) {
  throw new Error('CONTACT_RESOLUTION_TEST_DATABASE_URL is required for the coordinator suite')
}
const describeWithDatabase = TEST_DATABASE_URL ? describe : describe.skip

function clientUrl(applicationName: string): string | undefined {
  if (!TEST_DATABASE_URL) return undefined
  const value = new URL(TEST_DATABASE_URL)
  value.searchParams.set('application_name', applicationName)
  return value.toString()
}

const gate = TEST_DATABASE_URL
  ? new PrismaClient({ datasourceUrl: clientUrl('contact-coordinator-gate') })
  : null
const observer = TEST_DATABASE_URL
  ? new PrismaClient({ datasourceUrl: clientUrl('contact-coordinator-observer') })
  : null
const inversionA = TEST_DATABASE_URL
  ? new PrismaClient({ datasourceUrl: clientUrl('contact-inversion-a') })
  : null
const inversionB = TEST_DATABASE_URL
  ? new PrismaClient({ datasourceUrl: clientUrl('contact-inversion-b') })
  : null

type Deferred = { promise: Promise<void>; resolve: () => void }
function deferred(): Deferred {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
async function pollUntil<T>(probe: () => Promise<T | null>, description: string, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = await probe()
    if (result !== null) return result
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`Timed out waiting for ${description}`)
}
async function within<T>(task: Promise<T>, description: string, timeoutMs = 10_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      task,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${description}`)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function createContact(id: string, displayName = id, extra: Record<string, unknown> = {}) {
  await prisma.contact.create({ data: { id, displayName, ...extra } })
}
async function createPhone(
  id: string,
  contactId: string,
  phone = PHONE,
  extra: Record<string, unknown> = {},
) {
  const created = await prisma.contactPhone.create({
    data: {
      id,
      contactId,
      phone,
      source: ContactPhoneSource.manual,
      isPrimary: true,
      ...extra,
    },
  })
  if (created.isPrimary && created.isActive) {
    await prisma.contact.update({ where: { id: contactId }, data: { primaryPhoneId: id } })
  }
  return created
}
async function createIdentity(id: string, contactId: string, phoneId: string | null = null) {
  return prisma.contactIdentity.create({
    data: {
      id,
      contactId,
      channel: 'telegram',
      externalId: `existing-${id}`,
      phoneId,
    },
  })
}
async function markContactOldAndArchived(id: string) {
  await prisma.$executeRaw`
    UPDATE "Contact"
    SET "isArchived" = true,
        "updatedAt" = (NOW() AT TIME ZONE 'UTC') - INTERVAL '400 days'
    WHERE id = ${id}
  `
}
function resolver(externalId: string, phone = PHONE) {
  return ContactService.resolveContact('telegram', externalId, phone, externalId, {
    chatKind: 'private',
    phoneEvidence: { source: 'provider_profile', trustedForAutomaticResolution: true },
  })
}
function addRoute(contactId: string, phone = PHONE) {
  const request = new NextRequest(`http://localhost/api/contacts/${contactId}/phones`, {
    method: 'POST',
    body: JSON.stringify({ phone, isPrimary: true }),
    headers: { 'content-type': 'application/json' },
  })
  return ADD_PHONE(request, { params: Promise.resolve({ id: contactId }) })
}
function patchRoute(contactId: string, phoneId: string) {
  const request = new NextRequest(
    `http://localhost/api/contacts/${contactId}/phones/${phoneId}`,
    {
      method: 'PATCH',
      body: JSON.stringify({ isPrimary: true }),
      headers: { 'content-type': 'application/json' },
    },
  )
  return PATCH(request, { params: Promise.resolve({ id: contactId, phoneId }) })
}
function deleteRoute(contactId: string, phoneId: string) {
  return DELETE(
    new NextRequest(`http://localhost/api/contacts/${contactId}/phones/${phoneId}`),
    { params: Promise.resolve({ id: contactId, phoneId }) },
  )
}

async function holdTestGate(): Promise<{ release: () => void; task: Promise<void> }> {
  const acquired = deferred()
  const release = deferred()
  const task = gate!.$transaction(async transaction => {
    await transaction.$queryRaw`
      SELECT pg_advisory_xact_lock(
        CAST(${CONTACT_OWNERSHIP_ADVISORY_CLASS_ID} AS integer),
        CAST(${TEST_GATE_OBJECT_ID} AS integer)
      ) IS NULL AS acquired
    `
    acquired.resolve()
    await release.promise
  }, { timeout: 30_000 })
  await acquired.promise
  return { release: release.resolve, task }
}
async function waitForAdvisoryObject(objectId: number): Promise<number> {
  return pollUntil(async () => {
    const rows = await observer!.$queryRaw<Array<{ pid: number }>>`
      SELECT activity.pid
      FROM pg_stat_activity AS activity
      JOIN pg_locks AS waiting
        ON waiting.pid = activity.pid
       AND waiting.locktype = 'advisory'
       AND waiting.granted = false
      WHERE activity.datname = current_database()
        AND waiting.classid = ${CONTACT_OWNERSHIP_ADVISORY_CLASS_ID}::oid
        AND waiting.objid = ${objectId}::oid
      LIMIT 1
    `
    return rows[0]?.pid ?? null
  }, `advisory object ${objectId}`)
}

async function assertGlobalSerialValidity() {
  const duplicateOwners = await prisma.$queryRaw<Array<{ phone: string }>>`
    SELECT phone FROM "ContactPhone" WHERE "isActive" = true
    GROUP BY phone HAVING COUNT(DISTINCT "contactId") > 1
  `
  const invalidPrimary = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT contact.id FROM "Contact" AS contact
    LEFT JOIN "ContactPhone" AS phone ON phone.id = contact."primaryPhoneId"
    WHERE contact."primaryPhoneId" IS NOT NULL
      AND (phone.id IS NULL OR phone."contactId" <> contact.id
        OR phone."isActive" = false OR phone."isPrimary" = false)
  `
  const duplicatePrimary = await prisma.$queryRaw<Array<{ contactId: string }>>`
    SELECT "contactId" FROM "ContactPhone"
    WHERE "isActive" = true AND "isPrimary" = true
    GROUP BY "contactId" HAVING COUNT(*) > 1
  `
  const unpointedPrimary = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT phone.id FROM "ContactPhone" AS phone
    JOIN "Contact" AS contact ON contact.id = phone."contactId"
    WHERE phone."isActive" = true
      AND phone."isPrimary" = true
      AND (contact."primaryPhoneId" IS NULL OR contact."primaryPhoneId" <> phone.id)
  `
  const crossOwnerIdentity = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT identity.id FROM "ContactIdentity" AS identity
    JOIN "ContactPhone" AS phone ON phone.id = identity."phoneId"
    WHERE identity."phoneId" IS NOT NULL AND identity."contactId" <> phone."contactId"
  `
  const dirtyArchive = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT contact.id FROM "Contact" AS contact
    WHERE contact."isArchived" = true AND (
      NOT EXISTS (SELECT 1 FROM "ContactMerge" AS edge
        WHERE edge."mergedId" = contact.id AND edge.action = 'merge')
      OR EXISTS (SELECT 1 FROM "ContactPhone" AS phone WHERE phone."contactId" = contact.id)
      OR EXISTS (SELECT 1 FROM "ContactIdentity" AS identity WHERE identity."contactId" = contact.id)
    )
  `
  expect({
    duplicateOwners,
    duplicatePrimary,
    invalidPrimary,
    unpointedPrimary,
    crossOwnerIdentity,
    dirtyArchive,
  }).toEqual({
    duplicateOwners: [],
    duplicatePrimary: [],
    invalidPrimary: [],
    unpointedPrimary: [],
    crossOwnerIdentity: [],
    dirtyArchive: [],
  })
}

async function runSerializedPair(
  name: string,
  first: () => Promise<unknown>,
  second: () => Promise<unknown>,
) {
  const held = await holdTestGate()
  const firstTask = first()
  let secondTask: Promise<unknown> | null = null
  try {
    const firstPid = await waitForAdvisoryObject(TEST_GATE_OBJECT_ID)
    secondTask = second()
    const secondPid = await waitForAdvisoryObject(CONTACT_OWNERSHIP_ADVISORY_OBJECT_ID)
    const observerPid = await observer!.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`
    expect(new Set([firstPid, secondPid, observerPid[0].pid]).size).toBe(3)
  } finally {
    held.release()
    await held.task
  }
  const outcomes = await within(Promise.allSettled([firstTask, secondTask!]), `${name} operations`)
  const rejected = outcomes.filter(outcome => outcome.status === 'rejected')
  if (rejected.length > 0) throw (rejected[0] as PromiseRejectedResult).reason
  expect(JSON.stringify(outcomes)).not.toMatch(/40P01|deadlock detected/i)
  await assertGlobalSerialValidity()
}

function merge(sourceId: string, targetId: string) {
  return ContactMergeService.mergeContactToContact(sourceId, targetId, 'matrix')
}

describeWithDatabase.sequential('Contact ownership coordinator real PostgreSQL matrix', () => {
  beforeAll(async () => {
    if (process.env.DATABASE_URL !== TEST_DATABASE_URL) {
      throw new Error('DATABASE_URL must equal CONTACT_RESOLUTION_TEST_DATABASE_URL')
    }
    const parsed = new URL(TEST_DATABASE_URL!)
    if (!['127.0.0.1', 'localhost'].includes(parsed.hostname)
      || !parsed.pathname.includes('contact_resolution')) {
      throw new Error('coordinator suite refuses a non-local disposable database')
    }
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION contact_ownership_matrix_pause()
      RETURNS trigger LANGUAGE plpgsql AS $trigger$
      DECLARE payload jsonb;
      BEGIN
        payload := CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
        IF COALESCE(payload->>'id', '') LIKE 'matrix-gated-%'
          OR payload->>'phone' = '+79997770001'
          OR COALESCE(payload->>'externalId', '') LIKE 'matrix-gated-%'
          OR COALESCE(payload->>'mergedId', '') LIKE 'matrix-gated-%'
        THEN
          PERFORM pg_advisory_xact_lock(1498368847, 1413829460);
        END IF;
        RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
      END $trigger$
    `)
    for (const relation of ['Contact', 'ContactPhone', 'ContactIdentity', 'ContactMerge']) {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS contact_ownership_matrix_pause ON "${relation}"`)
      await prisma.$executeRawUnsafe(`
        CREATE TRIGGER contact_ownership_matrix_pause
        BEFORE INSERT OR UPDATE OR DELETE ON "${relation}"
        FOR EACH ROW EXECUTE FUNCTION contact_ownership_matrix_pause()
      `)
    }
  })

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ContactIdentity", "ContactPhone", "ContactMerge", "Contact" CASCADE',
    )
  })

  afterAll(async () => {
    if (TEST_DATABASE_URL) {
      for (const relation of ['Contact', 'ContactPhone', 'ContactIdentity', 'ContactMerge']) {
        await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS contact_ownership_matrix_pause ON "${relation}"`)
      }
      await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS contact_ownership_matrix_pause()')
    }
    await Promise.all([
      gate?.$disconnect(), observer?.$disconnect(), inversionA?.$disconnect(),
      inversionB?.$disconnect(), prisma.$disconnect(),
    ])
  })

  test('resolver → addPhone serializes and add fails closed as conflict', async () => {
    await createContact('A'); await createContact('B'); await createPhone('phone-A', 'A')
    await runSerializedPair('resolver/add', () => resolver('matrix-gated-resolver-add'), () => addRoute('B'))
    await expect(prisma.contactPhone.count({ where: { phone: PHONE, isActive: true } })).resolves.toBe(1)
  })

  test('addPhone → resolver serializes from zero owners', async () => {
    await createContact('A')
    await runSerializedPair('add/resolver', () => addRoute('A'), () => resolver('resolver-after-add'))
    await expect(prisma.contactIdentity.findUnique({
      where: {
        channel_externalId: {
          channel: 'telegram', externalId: 'resolver-after-add',
        },
      },
    })).resolves.toMatchObject({ contactId: 'A' })
  })

  test('resolver → PATCH and PATCH → resolver both serialize', async () => {
    await createContact('A'); await createPhone('matrix-gated-phone', 'A')
    await runSerializedPair(
      'resolver/patch',
      () => resolver('matrix-gated-resolver-patch'),
      () => patchRoute('A', 'matrix-gated-phone'),
    )
    await prisma.contactIdentity.deleteMany({})
    await runSerializedPair(
      'patch/resolver',
      () => patchRoute('A', 'matrix-gated-phone'),
      () => resolver('resolver-after-patch'),
    )
  })

  test('resolver → DELETE and DELETE → resolver both serialize', async () => {
    await createContact('A'); await createPhone('matrix-gated-phone', 'A')
    await runSerializedPair(
      'resolver/delete',
      () => resolver('matrix-gated-resolver-delete'),
      () => deleteRoute('A', 'matrix-gated-phone'),
    )
    await prisma.contactIdentity.deleteMany({})
    await prisma.contactPhone.update({
      where: { id: 'matrix-gated-phone' },
      data: { isActive: true, isPrimary: true },
    })
    await prisma.contact.update({ where: { id: 'A' }, data: { primaryPhoneId: 'matrix-gated-phone' } })
    await runSerializedPair(
      'delete/resolver',
      () => deleteRoute('A', 'matrix-gated-phone'),
      () => resolver('resolver-after-delete'),
    )
  })

  test('resolver → attach and attach → resolver both serialize', async () => {
    await createContact('A'); await createPhone('phone-A', 'A')
    await createIdentity('matrix-gated-identity', 'A')
    await runSerializedPair(
      'resolver/attach',
      () => resolver('matrix-gated-resolver-attach'),
      () => ContactService.attachPhoneToIdentity('A', 'matrix-gated-identity', PHONE),
    )
    await prisma.contactIdentity.update({ where: { id: 'matrix-gated-identity' }, data: { phoneId: null } })
    await runSerializedPair(
      'attach/resolver',
      () => ContactService.attachPhoneToIdentity('A', 'matrix-gated-identity', PHONE),
      () => resolver('resolver-after-attach'),
    )
  })

  test('resolver → merge and merge → resolver both serialize', async () => {
    await createContact('matrix-gated-source'); await createContact('target')
    await createPhone('phone-source', 'matrix-gated-source')
    await runSerializedPair(
      'resolver/merge',
      () => resolver('matrix-gated-resolver-merge'),
      () => merge('matrix-gated-source', 'target'),
    )
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ContactIdentity", "ContactPhone", "ContactMerge", "Contact" CASCADE',
    )
    await createContact('matrix-gated-source'); await createContact('target')
    await createPhone('phone-source', 'matrix-gated-source')
    await runSerializedPair(
      'merge/resolver',
      () => merge('matrix-gated-source', 'target'),
      () => resolver('resolver-after-merge'),
    )
    await expect(prisma.contactIdentity.findUnique({
      where: {
        channel_externalId: {
          channel: 'telegram', externalId: 'resolver-after-merge',
        },
      },
    })).resolves.toMatchObject({ contactId: 'target' })
  })

  test('add/add serializes for same and different Contacts', async () => {
    await createContact('A')
    await runSerializedPair(
      'add/add same',
      () => ContactService.addPhoneToContact('A', PHONE, { makePrimary: true }),
      () => ContactService.addPhoneToContact('A', PHONE, { makePrimary: true }),
    )
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ContactIdentity", "ContactPhone", "ContactMerge", "Contact" CASCADE',
    )
    await createContact('A'); await createContact('B')
    await runSerializedPair(
      'add/add different',
      () => ContactService.addPhoneToContact('A', PHONE, { makePrimary: true }),
      () => ContactService.addPhoneToContact('B', PHONE, { makePrimary: true }),
    )
  })

  test('add/PATCH and add/DELETE serialize', async () => {
    await createContact('A'); await createPhone('matrix-gated-existing', 'A', OTHER_PHONE)
    await runSerializedPair(
      'add/patch',
      () => ContactService.addPhoneToContact('A', PHONE),
      () => patchRoute('A', 'matrix-gated-existing'),
    )
    await prisma.contactPhone.delete({ where: { contactId_phone: { contactId: 'A', phone: PHONE } } })
    await runSerializedPair(
      'add/delete',
      () => ContactService.addPhoneToContact('A', PHONE),
      () => deleteRoute('A', 'matrix-gated-existing'),
    )
  })

  test('add/attach, PATCH/attach and DELETE/attach serialize', async () => {
    await createContact('A'); await createPhone('matrix-gated-phone', 'A')
    await createIdentity('matrix-gated-identity', 'A')
    await runSerializedPair(
      'add/attach',
      () => ContactService.addPhoneToContact('A', PHONE),
      () => ContactService.attachPhoneToIdentity('A', 'matrix-gated-identity', PHONE),
    )
    await prisma.contactIdentity.update({ where: { id: 'matrix-gated-identity' }, data: { phoneId: null } })
    await runSerializedPair(
      'patch/attach',
      () => patchRoute('A', 'matrix-gated-phone'),
      () => ContactService.attachPhoneToIdentity('A', 'matrix-gated-identity', PHONE),
    )
    await prisma.contactIdentity.update({ where: { id: 'matrix-gated-identity' }, data: { phoneId: null } })
    await runSerializedPair(
      'delete/attach',
      () => deleteRoute('A', 'matrix-gated-phone'),
      () => ContactService.attachPhoneToIdentity('A', 'matrix-gated-identity', PHONE),
    )
  })

  test('attach/merge and phone-writer/merge serialize', async () => {
    await createContact('matrix-gated-source'); await createContact('target')
    await createPhone('matrix-gated-phone', 'matrix-gated-source')
    await createIdentity('matrix-gated-identity', 'matrix-gated-source')
    await runSerializedPair(
      'attach/merge',
      () => ContactService.attachPhoneToIdentity('matrix-gated-source', 'matrix-gated-identity', PHONE),
      () => merge('matrix-gated-source', 'target'),
    )
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ContactIdentity", "ContactPhone", "ContactMerge", "Contact" CASCADE',
    )
    await createContact('matrix-gated-source'); await createContact('target')
    await createPhone('matrix-gated-phone', 'matrix-gated-source')
    await runSerializedPair(
      'phone/merge',
      () => patchRoute('matrix-gated-source', 'matrix-gated-phone'),
      () => merge('matrix-gated-source', 'target'),
    )
  })

  test('merge/merge serializes into one survivor', async () => {
    await createContact('matrix-gated-source-a'); await createContact('source-c'); await createContact('target')
    await createPhone('phone-a', 'matrix-gated-source-a', PHONE)
    await createPhone('phone-c', 'source-c', OTHER_PHONE)
    await runSerializedPair(
      'merge/merge',
      () => merge('matrix-gated-source-a', 'target'),
      () => merge('source-c', 'target'),
    )
  })

  test('Fleet reconciliation/resolver serializes behind owner capability', async () => {
    await prisma.driver.upsert({
      where: { yandexDriverId: 'fleet-driver' },
      create: {
        id: 'matrix-fleet-driver',
        yandexDriverId: 'fleet-driver',
        fullName: 'New Fleet Name',
        phone: PHONE,
      },
      update: { fullName: 'New Fleet Name', phone: PHONE },
    })
    await createContact('matrix-gated-fleet', 'Old Fleet Name', {
      yandexDriverId: 'fleet-driver', displayNameSource: 'yandex', masterSource: 'yandex',
    })
    await createPhone('fleet-phone', 'matrix-gated-fleet')
    await runSerializedPair(
      'fleet/resolver',
      () => reconcileFleetContactOwnershipV1({
        yandexDriverId: 'fleet-driver', fullName: 'New Fleet Name', phone: PHONE,
      }),
      () => resolver('resolver-after-fleet'),
    )
  })

  test('temporary expiry/resolver serializes', async () => {
    await createContact('A')
    await createPhone('matrix-gated-temp', 'A', PHONE, {
      isTemporary: true, expiresAt: new Date(Date.now() - 60_000),
    })
    await runSerializedPair(
      'expiry/resolver',
      () => expireTemporaryContactPhonesV1(new Date(), 100),
      () => resolver('resolver-after-expiry'),
    )
  })

  test('dangling cleanup/resolver serializes', async () => {
    await createContact('A'); await createPhone('phone-A', 'A')
    await createIdentity('matrix-gated-dangling', 'A')
    await runSerializedPair(
      'cleanup/resolver',
      () => ContactService.cleanupDanglingIdentities(['A']),
      () => resolver('resolver-after-cleanup'),
    )
  })

  test('retention/resolver serializes', async () => {
    await createContact('matrix-gated-retention')
    await createPhone('retention-phone', 'matrix-gated-retention')
    await markContactOldAndArchived('matrix-gated-retention')
    await runSerializedPair(
      'retention/resolver',
      () => deleteContactForRetentionV1({
        contract: DELETE_CONTACT_FOR_RETENTION_COMMAND_V1,
        contactId: 'matrix-gated-retention',
      }),
      () => resolver('resolver-after-retention'),
    )
  })

  test('bounded busy timeout rolls back, then fresh retry succeeds', async () => {
    await createContact('A')
    const acquired = deferred(); const release = deferred()
    const holder = gate!.$transaction(async transaction => {
      await transaction.$queryRaw`
        SELECT pg_advisory_xact_lock(
          CAST(${CONTACT_OWNERSHIP_ADVISORY_CLASS_ID} AS integer),
          CAST(${CONTACT_OWNERSHIP_ADVISORY_OBJECT_ID} AS integer)
        ) IS NULL AS acquired
      `
      acquired.resolve(); await release.promise
    }, { timeout: 30_000 })
    await acquired.promise
    const blocked = ContactService.addPhoneToContact('A', OTHER_PHONE, { makePrimary: true })
    await waitForAdvisoryObject(CONTACT_OWNERSHIP_ADVISORY_OBJECT_ID)
    await expect(within(blocked, 'bounded coordinator timeout', 4_000))
      .rejects.toBeInstanceOf(ContactOwnershipBusyError)
    await expect(prisma.contactPhone.count({ where: { phone: OTHER_PHONE } })).resolves.toBe(0)
    release.resolve(); await holder
    await expect(ContactService.addPhoneToContact('A', OTHER_PHONE, { makePrimary: true }))
      .resolves.toMatchObject({ kind: 'added', contactId: 'A' })
    await assertGlobalSerialValidity()
  }, 15_000)

  test('public POST/PATCH/DELETE expose busy as 503 and commit no partial phone state', async () => {
    await createContact('A')
    await createPhone('phone-A', 'A')
    const acquired = deferred(); const release = deferred()
    const holder = gate!.$transaction(async transaction => {
      await transaction.$queryRaw`
        SELECT pg_advisory_xact_lock(
          CAST(${CONTACT_OWNERSHIP_ADVISORY_CLASS_ID} AS integer),
          CAST(${CONTACT_OWNERSHIP_ADVISORY_OBJECT_ID} AS integer)
        ) IS NULL AS acquired
      `
      acquired.resolve(); await release.promise
    }, { timeout: 30_000 })
    await acquired.promise

    const responses = await within(Promise.all([
      addRoute('A', OTHER_PHONE),
      patchRoute('A', 'phone-A'),
      deleteRoute('A', 'phone-A'),
    ]), 'public route coordinator timeouts', 5_000)
    for (const response of responses) {
      expect(response.status).toBe(503)
      expect(response.headers.get('retry-after')).toBe('2')
      await expect(response.json()).resolves.toMatchObject({
        error: 'CONTACT_OWNERSHIP_BUSY', retryable: true,
      })
    }
    await expect(prisma.contactPhone.findUnique({ where: { id: 'phone-A' } }))
      .resolves.toMatchObject({ isActive: true, isPrimary: true })
    await expect(prisma.contact.findUnique({ where: { id: 'A' } }))
      .resolves.toMatchObject({ primaryPhoneId: 'phone-A' })
    await expect(prisma.contactPhone.count({ where: { phone: OTHER_PHONE } })).resolves.toBe(0)

    release.resolve(); await holder
    await expect(addRoute('A', OTHER_PHONE)).resolves.toMatchObject({ status: 201 })
    await assertGlobalSerialValidity()
  }, 15_000)

  test('retention revalidates archive/age/canonical eligibility after waiting for CNT1', async () => {
    await createContact('retention-stale-candidate')
    await markContactOldAndArchived('retention-stale-candidate')
    await expect(observer!.contact.findUnique({ where: { id: 'retention-stale-candidate' } }))
      .resolves.toMatchObject({ isArchived: true })

    const changed = deferred(); const release = deferred()
    const competitor = gate!.$transaction(async transaction => {
      await transaction.$queryRaw`
        SELECT pg_advisory_xact_lock(
          CAST(${CONTACT_OWNERSHIP_ADVISORY_CLASS_ID} AS integer),
          CAST(${CONTACT_OWNERSHIP_ADVISORY_OBJECT_ID} AS integer)
        ) IS NULL AS acquired
      `
      await transaction.contact.update({
        where: { id: 'retention-stale-candidate' },
        data: { isArchived: false },
      })
      changed.resolve(); await release.promise
    }, { timeout: 30_000 })
    await changed.promise

    const retention = deleteContactForRetentionV1({
      contract: DELETE_CONTACT_FOR_RETENTION_COMMAND_V1,
      contactId: 'retention-stale-candidate',
    }).catch(error => error)
    await waitForAdvisoryObject(CONTACT_OWNERSHIP_ADVISORY_OBJECT_ID)
    await expect(observer!.contact.findUnique({ where: { id: 'retention-stale-candidate' } }))
      .resolves.toMatchObject({ isArchived: true })

    release.resolve(); await competitor
    await expect(retention).resolves.toBeInstanceOf(ContactRetentionEligibilityChangedError)
    await expect(prisma.contact.findUnique({ where: { id: 'retention-stale-candidate' } }))
      .resolves.toMatchObject({ isArchived: false })
    await assertGlobalSerialValidity()
  }, 15_000)

  test('primary flag without pointer fails closed and rolls back the admitted mutation', async () => {
    await createContact('primary-rollback')
    await expect(runContactOwnershipTransaction(async transaction => {
      const scope = await lockContactOwnershipRows(transaction, {
        contactIds: ['primary-rollback'],
      })
      await transaction.contactPhone.create({
        data: {
          id: 'primary-rollback-phone',
          contactId: 'primary-rollback',
          phone: PHONE,
          source: 'manual',
          isPrimary: true,
        },
      })
      await assertContactOwnershipPostconditions(transaction, scope)
    })).rejects.toBeInstanceOf(ContactOwnershipInvariantError)
    await expect(prisma.contactPhone.findUnique({ where: { id: 'primary-rollback-phone' } }))
      .resolves.toBeNull()
  })

  test('null pointer with no active primary remains valid', async () => {
    await createContact('primary-empty-valid')
    await expect(runContactOwnershipTransaction(async transaction => {
      const scope = await lockContactOwnershipRows(transaction, {
        contactIds: ['primary-empty-valid'],
      })
      await assertContactOwnershipPostconditions(transaction, scope)
    })).resolves.toBeUndefined()
  })

  test('CommonJS maintenance verifier rejects the same primary mismatch and rolls back', async () => {
    await createContact('maintenance-primary-rollback', 'before')
    await prisma.contactPhone.create({
      data: {
        id: 'maintenance-primary-phone',
        contactId: 'maintenance-primary-rollback',
        phone: PHONE,
        source: 'manual',
        isPrimary: true,
      },
    })
    await expect(runContactOwnershipMaintenance(
      { contactIds: ['maintenance-primary-rollback'] },
      transaction => transaction.contact.update({
        where: { id: 'maintenance-primary-rollback' },
        data: { displayName: 'after' },
      }),
    )).rejects.toThrow(/is not selected by Contact/)
    await expect(prisma.contact.findUnique({ where: { id: 'maintenance-primary-rollback' } }))
      .resolves.toMatchObject({ displayName: 'before', primaryPhoneId: null })
  })

  test('synthetic row-lock inversion oracle deadlocks with no mutation', async () => {
    await createContact('inversion-contact')
    await createPhone('inversion-phone', 'inversion-contact', OTHER_PHONE)
    const phoneLocked = deferred(); const contactLocked = deferred()
    const rollback = new Error('SYNTHETIC_INVERSION_ROLLBACK')
    const patchOrder = inversionA!.$transaction(async transaction => {
      await transaction.$queryRaw`SELECT id FROM "ContactPhone" WHERE id = 'inversion-phone' FOR UPDATE`
      phoneLocked.resolve(); await contactLocked.promise
      await transaction.$queryRaw`SELECT id FROM "Contact" WHERE id = 'inversion-contact' FOR UPDATE`
      throw rollback
    }, { timeout: 10_000 }).catch(error => error)
    const attachOrder = inversionB!.$transaction(async transaction => {
      await phoneLocked.promise
      await transaction.$queryRaw`SELECT id FROM "Contact" WHERE id = 'inversion-contact' FOR UPDATE`
      contactLocked.resolve()
      await transaction.$queryRaw`SELECT id FROM "ContactPhone" WHERE id = 'inversion-phone' FOR UPDATE`
      throw rollback
    }, { timeout: 10_000 }).catch(error => error)
    const outcomes = await within(Promise.all([patchOrder, attachOrder]), 'synthetic deadlock', 12_000)
    expect(outcomes.map(String).join(' ')).toMatch(/deadlock|40P01|P2010/i)
    await expect(prisma.contactPhone.findUnique({ where: { id: 'inversion-phone' } }))
      .resolves.toMatchObject({ contactId: 'inversion-contact', isActive: true })
    await assertGlobalSerialValidity()
  }, 15_000)
})
