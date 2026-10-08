/**
 * The Prisma store and read port of the communication policy foundation,
 * proven over a recorded fake client. What matters: the row is created only at
 * version 1, otherwise advanced by a compare-and-set that must hit exactly one
 * row (never an upsert, never a delete); events are mapped field for field; the
 * event chain read fails closed past its bound; and the permission read binds
 * the existing lineage handler and the policy read to ONE repeatable-read
 * transaction.
 */
import { describe, expect, it, vi } from 'vitest'

import {
  CONTACT_COMMUNICATION_RECOVERY_EVENT_BOUND_V1,
} from '../public/v1/contact-communication-policy'
import { ContactOwnershipInvariantError } from './contact-ownership-coordinator'
import {
  makePrismaContactCommunicationPolicyReadPortV1,
  makePrismaContactCommunicationPolicyStoreV1,
} from './legacy-prisma-contact-communication-policy-adapter'

function fakeClient(options: { policy?: Record<string, unknown> | null; events?: unknown[]; updateCount?: number; contacts?: Record<string, { id: string; isArchived: boolean; customFields?: unknown }> } = {}) {
  const calls: Array<{ model: string; method: string; args: unknown }> = []
  const record = (model: string, method: string, result: unknown) => vi.fn(async (args: unknown) => {
    calls.push({ model, method, args })
    return typeof result === 'function' ? (result as (input: unknown) => unknown)(args) : result
  })
  const contacts = options.contacts ?? {}
  const tx = {
    contact: {
      findUnique: record('contact', 'findUnique', (args: { where: { id: string } }) => {
        const contact = contacts[args.where.id]
        return contact ? { id: contact.id, isArchived: contact.isArchived, customFields: contact.customFields ?? {} } : null
      }),
    },
    contactMerge: { findMany: record('contactMerge', 'findMany', []) },
    contactCommunicationPolicy: {
      findUnique: record('contactCommunicationPolicy', 'findUnique', options.policy ?? null),
      create: record('contactCommunicationPolicy', 'create', {}),
      updateMany: record('contactCommunicationPolicy', 'updateMany', { count: options.updateCount ?? 1 }),
    },
    contactCommunicationPolicyEvent: {
      findUnique: record('contactCommunicationPolicyEvent', 'findUnique', null),
      findMany: record('contactCommunicationPolicyEvent', 'findMany', options.events ?? []),
      create: record('contactCommunicationPolicyEvent', 'create', {}),
    },
  }
  return { tx, calls }
}

describe('makePrismaContactCommunicationPolicyStoreV1', () => {
  it('reads the policy row through an explicit non-sensitive select', async () => {
    const { tx, calls } = fakeClient({ policy: { contactId: 'c1', denyAll: false, denyMessage: true, denyVoice: false, version: 2 } })
    await expect(makePrismaContactCommunicationPolicyStoreV1(tx as never).readPolicy('c1'))
      .resolves.toEqual({ denyAll: false, denyMessage: true, denyVoice: false, version: 2 })
    expect(calls[0]).toMatchObject({
      model: 'contactCommunicationPolicy', method: 'findUnique',
      args: { where: { contactId: 'c1' }, select: { contactId: true, denyAll: true, denyMessage: true, denyVoice: true, version: true } },
    })
  })

  it('creates the row at version 1 when the expected version is 0 and never upserts', async () => {
    const { tx, calls } = fakeClient()
    const store = makePrismaContactCommunicationPolicyStoreV1(tx as never)
    await store.writePolicy({ contactId: 'c1', expectedVersion: 0, version: 1, restriction: { denyAll: true, denyMessage: false, denyVoice: false }, actor: 'op' })
    expect(calls.map(call => `${call.model}.${call.method}`)).toEqual(['contactCommunicationPolicy.create'])
    expect(calls[0].args).toEqual({ data: { contactId: 'c1', denyAll: true, denyMessage: false, denyVoice: false, version: 1, updatedBy: 'op' } })
    await expect(store.writePolicy({ contactId: 'c1', expectedVersion: 0, version: 2, restriction: { denyAll: true, denyMessage: false, denyVoice: false }, actor: 'op' }))
      .rejects.toBeInstanceOf(ContactOwnershipInvariantError)
  })

  it('advances an existing row by compare-and-set and fails closed when no row matched', async () => {
    const hit = fakeClient({ updateCount: 1 })
    await makePrismaContactCommunicationPolicyStoreV1(hit.tx as never)
      .writePolicy({ contactId: 'c1', expectedVersion: 3, version: 4, restriction: { denyAll: false, denyMessage: false, denyVoice: true }, actor: 'op' })
    expect(hit.calls[0]).toMatchObject({
      model: 'contactCommunicationPolicy', method: 'updateMany',
      args: { where: { contactId: 'c1', version: 3 }, data: { denyAll: false, denyMessage: false, denyVoice: true, version: 4, updatedBy: 'op' } },
    })
    const miss = fakeClient({ updateCount: 0 })
    await expect(makePrismaContactCommunicationPolicyStoreV1(miss.tx as never)
      .writePolicy({ contactId: 'c1', expectedVersion: 3, version: 4, restriction: { denyAll: false, denyMessage: false, denyVoice: true }, actor: 'op' }))
      .rejects.toThrow(/no longer current/u)
  })

  it('appends an event field for field, with a null before-state when there was no row', async () => {
    const { tx, calls } = fakeClient()
    await makePrismaContactCommunicationPolicyStoreV1(tx as never).appendEvent({
      contactId: 'c1', cause: 'mutation', version: 1, previousVersion: null, before: null,
      after: { denyAll: false, denyMessage: true, denyVoice: false }, actor: 'op', reason: 'r',
      mutationRequestId: 'req-1', requestDigest: 'a'.repeat(64), mergeId: null, sourceContactId: null,
    })
    expect(calls[0].method).toBe('create')
    expect((calls[0].args as { data: Record<string, unknown> }).data).toMatchObject({
      contactId: 'c1', cause: 'mutation', version: 1, previousVersion: null,
      beforeDenyAll: null, beforeDenyMessage: null, beforeDenyVoice: null,
      afterDenyAll: false, afterDenyMessage: true, afterDenyVoice: false,
      actor: 'op', reason: 'r', mutationRequestId: 'req-1', requestDigest: 'a'.repeat(64), mergeId: null, sourceContactId: null,
    })
    expect((calls[0].args as { data: { eventId: string } }).data.eventId).toMatch(/^[0-9a-f-]{36}$/u)
  })

  it('maps a stored mutation event back to the replay shape', async () => {
    const { tx } = fakeClient()
    tx.contactCommunicationPolicyEvent.findUnique = vi.fn(async () => ({
      contactId: 'c1', requestDigest: 'd'.repeat(64), version: 3, afterDenyAll: true, afterDenyMessage: false, afterDenyVoice: true,
    })) as never
    await expect(makePrismaContactCommunicationPolicyStoreV1(tx as never).findMutationEvent('req-1')).resolves.toEqual({
      contactId: 'c1', requestDigest: 'd'.repeat(64), version: 3, after: { denyAll: true, denyMessage: false, denyVoice: true },
    })
  })

  it('lists later events in version order and fails closed at the recovery bound', async () => {
    const some = fakeClient({ events: [{ cause: 'merge', version: 2, mergeId: 'm' }] })
    await expect(makePrismaContactCommunicationPolicyStoreV1(some.tx as never).listEventsAfter('c1', 1))
      .resolves.toEqual([{ cause: 'merge', version: 2, mergeId: 'm' }])
    expect(some.calls[0].args).toMatchObject({ where: { contactId: 'c1', version: { gt: 1 } }, orderBy: { version: 'asc' }, take: CONTACT_COMMUNICATION_RECOVERY_EVENT_BOUND_V1 })
    const tooMany = fakeClient({ events: Array.from({ length: CONTACT_COMMUNICATION_RECOVERY_EVENT_BOUND_V1 }, (_, index) => ({ cause: 'merge', version: index + 2, mergeId: `m${index}` })) })
    await expect(makePrismaContactCommunicationPolicyStoreV1(tooMany.tx as never).listEventsAfter('c1', 1))
      .rejects.toBeInstanceOf(ContactOwnershipInvariantError)
  })
})

describe('makePrismaContactCommunicationPolicyReadPortV1', () => {
  function clientWith(contacts: Record<string, { id: string; isArchived: boolean; customFields?: unknown }>, policy: Record<string, unknown> | null) {
    const { tx, calls } = fakeClient({ contacts, policy })
    const options: unknown[] = []
    const client = {
      $transaction: vi.fn(async (work: (transaction: unknown) => Promise<unknown>, transactionOptions: unknown) => {
        options.push(transactionOptions)
        return work(tx)
      }),
    }
    return { client, calls, options }
  }

  it('resolves lineage with the existing handler and reads the canonical policy in one repeatable-read transaction', async () => {
    const { client, calls, options } = clientWith({
      loser: { id: 'loser', isArchived: true, customFields: { mergedIntoContactId: 'survivor' } },
      survivor: { id: 'survivor', isArchived: false },
    }, { contactId: 'survivor', denyAll: true, denyMessage: false, denyVoice: false, version: 1 })
    await expect(makePrismaContactCommunicationPolicyReadPortV1(client as never).readPermissionState('loser')).resolves.toEqual({
      kind: 'found', canonicalContactId: 'survivor', isArchived: false, policy: { denyAll: true, denyMessage: false, denyVoice: false, version: 1 },
    })
    expect(client.$transaction).toHaveBeenCalledTimes(1)
    expect(options).toEqual([{ isolationLevel: 'RepeatableRead' }])
    // The whole walk happened inside that one transaction client.
    expect(calls.map(call => `${call.model}.${call.method}`)).toEqual([
      'contact.findUnique', 'contact.findUnique', 'contactMerge.findMany', 'contact.findUnique', 'contactCommunicationPolicy.findUnique',
    ])
  })

  it('reports an unknown Contact when the lineage finds nothing', async () => {
    const { client } = clientWith({}, null)
    await expect(makePrismaContactCommunicationPolicyReadPortV1(client as never).readPermissionState('ghost')).resolves.toEqual({ kind: 'unknown' })
  })

  it('propagates a broken lineage so the handler can deny it retryably', async () => {
    const { client } = clientWith({
      a: { id: 'a', isArchived: true, customFields: { mergedIntoContactId: 'b' } },
      b: { id: 'b', isArchived: true, customFields: { mergedIntoContactId: 'a' } },
    }, null)
    await expect(makePrismaContactCommunicationPolicyReadPortV1(client as never).readPermissionState('a')).rejects.toThrow('CONTACT_MERGE_REDIRECT_CYCLE')
  })
})
