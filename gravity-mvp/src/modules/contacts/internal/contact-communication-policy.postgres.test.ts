/**
 * Isolated-PostgreSQL proof for the contact communication policy foundation.
 * Gated behind YOKO_CONTACT_COMMUNICATION_POLICY_POSTGRES_PROOF=1 and an
 * isolated DATABASE_URL with every migration (including the pending source
 * migrations) applied. It never touches a production database.
 *
 * The in-memory proofs prove the decision tables; this proves the real
 * adapters are correct clients of the real constraints and guards: the CNT1
 * serialization of concurrent mutations, the append-only event guards, the
 * cascade-only removal, identity churn leaving the policy alone, and a real
 * merge followed by a real automated recovery.
 */
import { randomUUID } from 'node:crypto'

import { PrismaClient, type Prisma } from '@prisma/client'
import { afterAll, describe, expect, it } from 'vitest'

import {
  CONTACT_COMMUNICATION_PERMISSION_QUERY_V1,
  MERGE_CONTACTS_COMMAND_V1,
  RECOVER_AUTOMATED_CONTACT_MERGE_COMMAND_V1,
  SET_CONTACT_COMMUNICATION_POLICY_COMMAND_V1,
} from '@/contracts/contacts/v1'
import { mergeContactsV1 } from '@/infrastructure/contact-merge-composition'

import {
  getContactCommunicationPermissionV1,
  setContactCommunicationPolicyV1,
} from '../application/contact-operations'

const proof = process.env.YOKO_CONTACT_COMMUNICATION_POLICY_POSTGRES_PROOF === '1' ? describe : describe.skip
const db = new PrismaClient()

const ALL = { denyAll: true, denyMessage: false, denyVoice: false }
const MESSAGE = { denyAll: false, denyMessage: true, denyVoice: false }
const VOICE = { denyAll: false, denyMessage: false, denyVoice: true }
const NONE = { denyAll: false, denyMessage: false, denyVoice: false }

async function newContact(customFields: Prisma.InputJsonObject = {}): Promise<string> {
  const id = `ccrproof${randomUUID().replace(/-/gu, '').slice(0, 20)}`
  await db.contact.create({ data: { id, displayName: `Proof ${id.slice(-6)}`, customFields } })
  return id
}

async function policyRow(contactId: string) {
  const rows = await db.$queryRawUnsafe<Array<Record<string, unknown>>>(
    'SELECT "denyAll", "denyMessage", "denyVoice", "version", "updatedBy" FROM "ContactCommunicationPolicy" WHERE "contactId" = $1', contactId,
  )
  return rows[0] ?? null
}

async function eventRows(contactId: string) {
  return db.$queryRawUnsafe<Array<Record<string, unknown>>>(
    'SELECT "cause", "version", "previousVersion", "beforeDenyAll", "afterDenyAll", "afterDenyMessage", "afterDenyVoice", "mutationRequestId", "mergeId", "sourceContactId" FROM "ContactCommunicationPolicyEvent" WHERE "contactId" = $1 ORDER BY "version"', contactId,
  )
}

function set(contactId: string, requestId: string, expectedVersion: number, restriction: typeof ALL, actor = 'proof-operator') {
  return setContactCommunicationPolicyV1({
    contract: SET_CONTACT_COMMUNICATION_POLICY_COMMAND_V1,
    requestId, contactId, expectedVersion, restriction, actor, reason: 'isolated postgres proof',
  })
}

function permission(contactId: string, communicationClass: string) {
  return getContactCommunicationPermissionV1({ contract: CONTACT_COMMUNICATION_PERMISSION_QUERY_V1, contactId, communicationClass })
}

/** Marks a completed merge as an automated, recoverable one so the real recovery path can be exercised. */
async function markMergeRecoverable(mergeId: string, survivorId: string, mergedId: string) {
  await db.$executeRawUnsafe(
    `UPDATE "ContactMerge" SET "snapshotBefore" = jsonb_set(jsonb_set("snapshotBefore"::jsonb, '{_merge,automated}', 'true'::jsonb), '{_merge,recoveryState}', '"recoverable"'::jsonb) WHERE id = $1`,
    mergeId,
  )
  await db.$executeRawUnsafe(
    `UPDATE "Contact" SET "customFields" = COALESCE("customFields", '{}')::jsonb || '{"mergeRecoveryState":"recoverable"}'::jsonb WHERE id = $1 OR id = $2`,
    survivorId, mergedId,
  )
}

async function mergeInto(sourceId: string, targetId: string) {
  const result = await mergeContactsV1({
    contract: MERGE_CONTACTS_COMMAND_V1, operation: 'contact_to_contact', sourceId, targetId, mergedBy: 'proof-manager',
  })
  expect(result).toMatchObject({ status: 'contact_merged', survivorId: targetId, mergedId: sourceId })
  const mergeId = (result as { mergeRecordId: string }).mergeRecordId
  await markMergeRecoverable(mergeId, targetId, sourceId)
  return mergeId
}

proof('contact communication policy foundation on real PostgreSQL', () => {
  afterAll(async () => { await db.$disconnect() })

  it('the migration created both tables and their guards', async () => {
    const tables = await db.$queryRawUnsafe<Array<{ table_name: string }>>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name IN ('ContactCommunicationPolicy', 'ContactCommunicationPolicyEvent') ORDER BY table_name`,
    )
    expect(tables.map(row => row.table_name)).toEqual(['ContactCommunicationPolicy', 'ContactCommunicationPolicyEvent'])
    const guards = await db.$queryRawUnsafe<Array<{ proname: string }>>(
      `SELECT proname FROM pg_proc WHERE proname IN ('contact_communication_policy_guard', 'contact_communication_policy_event_guard') ORDER BY proname`,
    )
    expect(guards.map(row => row.proname)).toEqual(['contact_communication_policy_event_guard', 'contact_communication_policy_guard'])
  })

  it('allows a known Contact without a row at version 0 and denies an unknown one', async () => {
    const contactId = await newContact()
    await expect(permission(contactId, 'message')).resolves.toMatchObject({ decision: 'allow', reason: 'no_restriction', canonicalContactId: contactId, policyVersion: 0 })
    await expect(permission('ccrproof-does-not-exist', 'voice')).resolves.toMatchObject({ decision: 'deny', retryable: false, reason: 'contact_unknown' })
    await expect(permission(contactId, 'telegram')).resolves.toMatchObject({ decision: 'deny', retryable: false, reason: 'unsupported_communication_class' })
  })

  it('applies, replays, conflicts and advances the version through the locked mutation', async () => {
    const contactId = await newContact()
    await expect(set(contactId, 'req-apply', 0, MESSAGE)).resolves.toMatchObject({ status: 'applied', version: 1 })
    await expect(set(contactId, 'req-apply', 0, MESSAGE)).resolves.toMatchObject({ status: 'replayed', version: 1 })
    await expect(set(contactId, 'req-apply', 0, ALL)).resolves.toMatchObject({ status: 'idempotency_conflict' })
    await expect(set(contactId, 'req-stale', 0, ALL)).resolves.toMatchObject({ status: 'version_conflict', currentVersion: 1 })
    await expect(set(contactId, 'req-next', 1, VOICE)).resolves.toMatchObject({ status: 'applied', version: 2 })
    expect(await policyRow(contactId)).toMatchObject({ ...VOICE, version: 2, updatedBy: 'proof-operator' })
    const events = await eventRows(contactId)
    expect(events.map(event => [event.cause, event.version, event.previousVersion, event.mutationRequestId])).toEqual([
      ['mutation', 1, null, 'req-apply'], ['mutation', 2, 1, 'req-next'],
    ])
    await expect(permission(contactId, 'voice')).resolves.toMatchObject({ decision: 'deny', reason: 'restricted_voice', policyVersion: 2 })
    await expect(permission(contactId, 'message')).resolves.toMatchObject({ decision: 'allow', policyVersion: 2 })
  })

  it('ALL denies both classes, MESSAGE and VOICE deny only their own', async () => {
    const all = await newContact()
    await set(all, 'req-all', 0, ALL)
    await expect(permission(all, 'message')).resolves.toMatchObject({ decision: 'deny', reason: 'restricted_all' })
    await expect(permission(all, 'voice')).resolves.toMatchObject({ decision: 'deny', reason: 'restricted_all' })
    const message = await newContact()
    await set(message, 'req-message', 0, MESSAGE)
    await expect(permission(message, 'message')).resolves.toMatchObject({ decision: 'deny', reason: 'restricted_message' })
    await expect(permission(message, 'voice')).resolves.toMatchObject({ decision: 'allow' })
  })

  it('serializes concurrent mutations: exactly one applies, the other sees the newer version', async () => {
    const contactId = await newContact()
    const results = await Promise.all([set(contactId, 'req-c1', 0, MESSAGE), set(contactId, 'req-c2', 0, NONE)])
    expect(results.map(result => result.status).sort()).toEqual(['applied', 'version_conflict'])
    expect((await eventRows(contactId))).toHaveLength(1)
    expect(await policyRow(contactId)).toMatchObject({ version: 1 })
  })

  it('the database refuses a version skip, an event update, a direct delete, and keeps cascade removal', async () => {
    const contactId = await newContact()
    await set(contactId, 'req-guard', 0, ALL)
    await expect(db.$executeRawUnsafe('UPDATE "ContactCommunicationPolicy" SET "version" = 5 WHERE "contactId" = $1', contactId))
      .rejects.toThrow(/advance by exactly one/u)
    await expect(db.$executeRawUnsafe(`UPDATE "ContactCommunicationPolicyEvent" SET "reason" = 'edited' WHERE "contactId" = $1`, contactId))
      .rejects.toThrow(/cannot be updated/u)
    await expect(db.$executeRawUnsafe('DELETE FROM "ContactCommunicationPolicy" WHERE "contactId" = $1', contactId))
      .rejects.toThrow(/cannot be deleted directly/u)
    await expect(db.$executeRawUnsafe('DELETE FROM "ContactCommunicationPolicyEvent" WHERE "contactId" = $1', contactId))
      .rejects.toThrow(/cannot be deleted directly/u)
    // Retention-style removal of the owning Contact cascades through the guards.
    await db.contact.delete({ where: { id: contactId } })
    expect(await policyRow(contactId)).toBeNull()
    expect(await eventRows(contactId)).toEqual([])
  })

  it('identity removal, deactivation and replacement do not alter the restriction', async () => {
    const contactId = await newContact()
    await set(contactId, 'req-identity', 0, ALL)
    const before = await policyRow(contactId)
    const identity = await db.contactIdentity.create({ data: { contactId, channel: 'telegram', externalId: `ccrproof-${randomUUID()}` } })
    await db.contactIdentity.update({ where: { id: identity.id }, data: { isActive: false } })
    await db.contactIdentity.delete({ where: { id: identity.id } })
    await db.contactIdentity.create({ data: { contactId, channel: 'max', externalId: `ccrproof-${randomUUID()}` } })
    expect(await policyRow(contactId)).toEqual(before)
    expect(await eventRows(contactId)).toHaveLength(1)
    await expect(permission(contactId, 'message')).resolves.toMatchObject({ decision: 'deny', reason: 'restricted_all' })
  })

  it('a merge composes deny-wins, keeps the source row, resolves the merged-away id to the survivor, and recovery restores it', async () => {
    const survivor = await newContact({ canonicalPinnedAt: new Date().toISOString(), canonicalPinnedBy: 'proof' })
    const source = await newContact()
    await set(survivor, 'req-survivor', 0, VOICE)
    await set(source, 'req-source', 0, MESSAGE)
    const mergeId = await mergeInto(source, survivor)

    expect(await policyRow(survivor)).toMatchObject({ denyAll: false, denyMessage: true, denyVoice: true, version: 2 })
    expect(await policyRow(source)).toMatchObject({ ...MESSAGE, version: 1 })
    expect((await eventRows(survivor)).at(-1)).toMatchObject({ cause: 'merge', version: 2, previousVersion: 1, mergeId, sourceContactId: source })
    await expect(permission(source, 'message')).resolves.toMatchObject({ decision: 'deny', reason: 'restricted_message', canonicalContactId: survivor, policyVersion: 2 })
    await expect(permission(source, 'voice')).resolves.toMatchObject({ decision: 'deny', reason: 'restricted_voice', canonicalContactId: survivor })
    await expect(set(source, 'req-on-loser', 1, NONE)).resolves.toMatchObject({ status: 'contact_not_canonical', canonicalContactId: survivor })

    const recovery = await mergeContactsV1.recover({
      contract: RECOVER_AUTOMATED_CONTACT_MERGE_COMMAND_V1, mergeId, requestedBy: 'proof-operator', basis: 'isolated postgres proof',
    })
    expect(recovery).toMatchObject({ status: 'recovered', mergeId })
    expect(await policyRow(survivor)).toMatchObject({ ...VOICE, version: 3, updatedBy: 'contacts:automated-merge-recovery' })
    expect(await policyRow(source)).toMatchObject({ ...MESSAGE, version: 1 })
    expect((await eventRows(survivor)).at(-1)).toMatchObject({ cause: 'merge_recovery', version: 3, previousVersion: 2, mergeId, sourceContactId: source })
    await expect(permission(source, 'message')).resolves.toMatchObject({ decision: 'deny', reason: 'restricted_message', canonicalContactId: source })
    await expect(permission(survivor, 'message')).resolves.toMatchObject({ decision: 'allow', policyVersion: 3 })
  })

  it('a policy decided after the merge makes recovery fail closed into manual reconciliation', async () => {
    const survivor = await newContact({ canonicalPinnedAt: new Date().toISOString(), canonicalPinnedBy: 'proof' })
    const source = await newContact()
    await set(source, 'req-source-2', 0, ALL)
    const mergeId = await mergeInto(source, survivor)
    expect(await policyRow(survivor)).toMatchObject({ ...ALL, version: 1 })
    // An operator confirms the restriction after the merge: the newer policy must survive.
    await expect(set(survivor, 'req-after-merge', 1, ALL)).resolves.toMatchObject({ status: 'applied', version: 2 })

    const recovery = await mergeContactsV1.recover({
      contract: RECOVER_AUTOMATED_CONTACT_MERGE_COMMAND_V1, mergeId, requestedBy: 'proof-operator', basis: 'isolated postgres proof',
    })
    expect(recovery).toMatchObject({ status: 'manual_reconciliation', reason: 'communication_policy_changed_after_merge' })
    expect(await policyRow(survivor)).toMatchObject({ ...ALL, version: 2 })
    expect(await policyRow(source)).toMatchObject({ ...ALL, version: 1 })
    const merge = await db.contactMerge.findUnique({ where: { id: mergeId }, select: { snapshotBefore: true } })
    expect((merge?.snapshotBefore as { _merge: { recoveryState: string } })._merge.recoveryState).toBe('manual_reconciliation')
  })
})
