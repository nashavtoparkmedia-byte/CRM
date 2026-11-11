import { afterAll, describe, expect, it, vi } from 'vitest'
import { prisma } from '@/lib/prisma'
import type { ContactCommunicationPermissionResultV1, ContactPersonCardResultV1 } from '@/contracts/contacts/v1'
import { START_MANUAL_CALL_COMMAND_V1 } from '@/contracts/calling/v1/manual-call'
import {
  createManualCallOperations,
  manualCallIdentityV1,
  ManualDialOutcomeUnknownError,
  type ManualCallRecord,
} from '../../application/manual-call'
import { MANUAL_CALL_METADATA_KEY, manualCallPrismaStore } from './manual-call-prisma-adapter'

// PostgreSQL proof of the manual-call claim: the advisory locks, replay, busy and settle semantics
// that the unit tests only model. Runs under the Heavy runner against its own per-run database.
// Calling's PostgreSQL proof gate (the Heavy runner switches it on; hosted CI skips *.postgres.test.ts).
const postgresProof = process.env.YOKO_AI_CALL_POSTGRES_PROOF === '1' ? describe : describe.skip
const PREFIX = 'manual-call-proof-v1'
const PHONE = '+79160000201'
let seq = 0

async function contact(): Promise<string> {
  seq += 1
  const id = `${PREFIX}-contact-${seq}`
  await prisma.contact.create({ data: { id, displayName: `Proof person ${seq}` } })
  return id
}

function record(contactId: string, requestId: string, staffUserId = 'u1', phoneId = 'p'): ManualCallRecord {
  return {
    ...manualCallIdentityV1(`${PREFIX}-${requestId}`),
    requestId: `${PREFIX}-${requestId}`,
    payloadDigest: `${staffUserId}|${contactId}|${phoneId}`,
    contactId,
    driverId: null,
    phoneId,
    e164: PHONE,
    staffUserId,
    extension: '101',
    createdAt: new Date().toISOString(),
  }
}

function personFor(contactId: string): ContactPersonCardResultV1 {
  return {
    contract: 'contacts.ContactPersonCardResult.v1', status: 'confirmed',
    card: {
      contactId, displayName: 'Proof', displayTitle: 'Proof', primaryPhone: PHONE, displayNameSource: 'manual', source: 'manual',
      personConfirmation: { state: 'unconfirmed' }, mainDriverId: null, legacyYandexDriverId: null,
      phones: [{ phoneId: 'p', phone: PHONE, isPrimary: true, isActive: true, lifecycle: 'current', trust: 'unknown', freshness: 'unknown', resolutionState: 'unique', verifiedAt: null, lastSeenAt: null }],
      channels: [], lineage: { canonicalContactId: contactId, contactIds: [contactId], mergedFromCount: 0, mergeHistory: [] },
      conflicts: [], hasOpenConflict: false, hasPersonBlockingConflict: false, candidates: [],
      automation: { doNotMerge: false, canonicalPinned: false, mergeRecoveryState: null }, isArchived: false,
    },
  } as unknown as ContactPersonCardResultV1
}

const allow = (contactId: string): ContactCommunicationPermissionResultV1 => ({
  contract: 'contacts.ContactCommunicationPermissionResult.v1', decision: 'allow', retryable: false, reason: 'no_restriction',
  requestedContactId: contactId, communicationClass: 'voice', canonicalContactId: contactId, policyVersion: 0,
} as ContactCommunicationPermissionResultV1)

postgresProof('manual call claim on PostgreSQL', () => {
  afterAll(async () => {
    await prisma.call.deleteMany({ where: { contactId: { startsWith: PREFIX } } })
    await prisma.contact.deleteMany({ where: { id: { startsWith: PREFIX } } })
    await prisma.$disconnect()
  })

  it('pre-creates exactly one ringing outbound Call with the deterministic id and channel uuid', async () => {
    const contactId = await contact()
    const claim = record(contactId, 'create')
    await expect(manualCallPrismaStore.claim(claim)).resolves.toEqual({ kind: 'claimed' })
    const row = await prisma.call.findUniqueOrThrow({ where: { id: claim.callId } })
    expect(row).toMatchObject({ direction: 'outbound', status: 'ringing', fsUuid: claim.fsUuid, contactId, managerId: 'u1', toNumber: PHONE, isAi: false, isSimulation: false })
    expect((row.metadata as Record<string, unknown>)[MANUAL_CALL_METADATA_KEY]).toMatchObject({ version: 1, requestId: claim.requestId, payloadDigest: claim.payloadDigest, phoneId: 'p', extension: '101', dispatch: 'claimed' })
  })

  it('replays the same requestId and refuses a second requestId while the Contact or the employee is live', async () => {
    const contactId = await contact()
    const first = record(contactId, 'replay')
    await manualCallPrismaStore.claim(first)
    await expect(manualCallPrismaStore.claim(first)).resolves.toEqual({ kind: 'existing', payloadDigest: first.payloadDigest, dispatch: 'claimed' })
    await expect(manualCallPrismaStore.claim(record(contactId, 'replay-2', 'u2'))).resolves.toEqual({ kind: 'busy' })
    const otherContact = await contact()
    await expect(manualCallPrismaStore.claim(record(otherContact, 'replay-3', 'u1'))).resolves.toEqual({ kind: 'busy' })
    expect(await prisma.call.count({ where: { contactId } })).toBe(1)
  })

  it('serialises concurrent claims: one Call for one Contact, whatever the requestIds', async () => {
    const contactId = await contact()
    const results = await Promise.all(Array.from({ length: 6 }, (_, index) => manualCallPrismaStore.claim(record(contactId, `race-${index}`, `u${index + 10}`))))
    expect(results.filter(result => result.kind === 'claimed')).toHaveLength(1)
    expect(results.filter(result => result.kind === 'busy')).toHaveLength(5)
    expect(await prisma.call.count({ where: { contactId } })).toBe(1)
  })

  it('serialises concurrent presses of one requestId into one Call', async () => {
    const contactId = await contact()
    const same = record(contactId, 'same', 'u20')
    const results = await Promise.all(Array.from({ length: 6 }, () => manualCallPrismaStore.claim(same)))
    expect(results.filter(result => result.kind === 'claimed')).toHaveLength(1)
    expect(results.filter(result => result.kind === 'existing')).toHaveLength(5)
    expect(await prisma.call.count({ where: { contactId } })).toBe(1)
  })

  it('a failed dial frees the Contact; an accepted or unknown one keeps it busy', async () => {
    const contactId = await contact()
    const failed = record(contactId, 'failed', 'u30')
    await manualCallPrismaStore.claim(failed)
    await manualCallPrismaStore.settle(failed.callId, 'unavailable')
    const row = await prisma.call.findUniqueOrThrow({ where: { id: failed.callId } })
    expect(row.status).toBe('failed')
    expect(row.hangupCause).toBe('MANUAL_CALL_UNAVAILABLE')
    const unknown = record(contactId, 'unknown', 'u30')
    await expect(manualCallPrismaStore.claim(unknown)).resolves.toEqual({ kind: 'claimed' })
    await manualCallPrismaStore.settle(unknown.callId, 'outcome_unknown')
    expect((await prisma.call.findUniqueOrThrow({ where: { id: unknown.callId } })).status).toBe('ringing')
    await expect(manualCallPrismaStore.claim(record(contactId, 'after-unknown', 'u31'))).resolves.toEqual({ kind: 'busy' })
    await expect(manualCallPrismaStore.claim(unknown)).resolves.toEqual({ kind: 'existing', payloadDigest: unknown.payloadDigest, dispatch: 'outcome_unknown' })
  })

  it('the ESL listener’s create-only upsert keeps the pre-created row', async () => {
    const contactId = await contact()
    const claim = record(contactId, 'listener', 'u40')
    await manualCallPrismaStore.claim(claim)
    await prisma.call.upsert({
      where: { fsUuid: claim.fsUuid },
      create: { direction: 'outbound', status: 'ringing', fromNumber: '', toNumber: PHONE, fsUuid: claim.fsUuid },
      update: {},
    })
    expect(await prisma.call.count({ where: { fsUuid: claim.fsUuid } })).toBe(1)
    expect((await prisma.call.findUniqueOrThrow({ where: { fsUuid: claim.fsUuid } })).id).toBe(claim.callId)
    await expect(manualCallPrismaStore.findByFsUuid(claim.fsUuid)).resolves.toEqual({ callId: claim.callId, staffUserId: 'u40', active: true })
    await prisma.call.update({ where: { fsUuid: claim.fsUuid }, data: { status: 'completed' } })
    await expect(manualCallPrismaStore.findByFsUuid(claim.fsUuid)).resolves.toEqual({ callId: claim.callId, staffUserId: 'u40', active: false })
  })

  it('end to end on the real store: two presses, one dial; an unknown outcome is never redialled', async () => {
    const contactId = await contact()
    const dial = { originate: vi.fn(async () => { throw new ManualDialOutcomeUnknownError('no reply') }), cancel: vi.fn(async () => {}) }
    const ops = createManualCallOperations({
      principal: async () => ({ userId: 'u50', role: 'Менеджер' }),
      extensionFor: () => '101',
      readPerson: async id => personFor(id),
      voicePermission: async id => allow(id),
      store: manualCallPrismaStore,
      dial,
      now: () => new Date(),
    })
    const command = { contract: START_MANUAL_CALL_COMMAND_V1, requestId: `${PREFIX}-e2e-0001`, contactId, phoneId: 'p' }
    const results = await Promise.all([ops.start(command), ops.start(command)])
    expect(results.map(result => result.status).sort()).toEqual(['indeterminate', 'indeterminate'])
    await expect(ops.start(command)).resolves.toMatchObject({ status: 'indeterminate' })
    await expect(ops.start({ ...command, requestId: `${PREFIX}-e2e-0002` })).resolves.toMatchObject({ status: 'refused', reason: 'busy' })
    expect(dial.originate).toHaveBeenCalledTimes(1)
    expect(await prisma.call.count({ where: { contactId } })).toBe(1)
  })
})
