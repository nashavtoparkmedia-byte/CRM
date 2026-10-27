import { Prisma } from '@prisma/client'
import { describe, expect, test, vi } from 'vitest'

vi.mock('@/lib/prisma', () => ({ prisma: {} }))

import { makePrismaContactCardSourcePortV1 } from './legacy-prisma-contact-card-source-adapter'

type Recorded = { model: string; method: string; args: unknown }

/**
 * A transaction client that records reads and throws on anything else: every
 * write method, raw SQL and every model the adapter has no business reading.
 */
function recordingClient(contact: unknown, mergedFromCount = 0) {
  const recorded: Recorded[] = []
  const options: unknown[] = []
  const model = (name: string, methods: Record<string, (args: unknown) => unknown>) => new Proxy({}, {
    get(_target, method: string) {
      const read = methods[method]
      if (!read) throw new Error(`forbidden: ${name}.${method}`)
      return async (args: unknown) => {
        recorded.push({ model: name, method, args })
        return read(args)
      }
    },
  })
  const tx = new Proxy({}, {
    get(_target, property: string) {
      if (property === 'contact') return model('contact', { findUnique: () => contact })
      if (property === 'contactMerge') return model('contactMerge', { count: () => mergedFromCount })
      throw new Error(`forbidden: ${property}`)
    },
  })
  const client = {
    async $transaction(work: (client: unknown) => Promise<unknown>, transactionOptions: unknown) {
      options.push(transactionOptions)
      return work(tx)
    },
  }
  return { client: client as unknown as Parameters<typeof makePrismaContactCardSourcePortV1>[0], recorded, options }
}

function keysDeep(value: unknown, into: string[] = []): string[] {
  if (value && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      into.push(key)
      keysDeep(nested, into)
    }
  }
  return into
}

const STORED_CONTACT = {
  id: 'contact-a',
  displayName: 'Иван',
  displayNameSource: 'provider',
  primaryPhoneId: 'phone-1',
  isArchived: false,
  customFields: {
    phoneEvidenceByPhoneId: { 'phone-2': { lifecycle: 'removed' } },
    driverConfirmations: [{
      status: 'confirmed',
      representativeDriverId: 'driver-a',
      evidenceSnapshot: { profiles: [{ driverId: 'driver-a', fullName: 'Иван Петров' }] },
    }],
  },
  phones: [
    { id: 'phone-1', phone: '79990000001', isActive: true, verifiedAt: null },
    { id: 'phone-2', phone: '79990000002', isActive: true, verifiedAt: null },
  ],
  identities: [{ id: 'identity-1', channel: 'telegram', isActive: true, metadata: { conflictState: 'clear' }, displayName: 'ivan' }],
}

describe('legacy Prisma Contact card source', () => {
  test('reads one Contact by its exact id inside one REPEATABLE READ snapshot', async () => {
    const { client, recorded, options } = recordingClient(STORED_CONTACT, 2)
    const result = await makePrismaContactCardSourcePortV1(client).findContactCardSource('contact-a')

    expect(options).toEqual([{ isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }])
    expect(recorded.map(call => `${call.model}.${call.method}`)).toEqual(['contact.findUnique', 'contactMerge.count'])
    expect((recorded[0].args as { where: unknown }).where).toEqual({ id: 'contact-a' })
    expect(recorded[1].args).toEqual({ where: { survivorId: 'contact-a', action: 'merge' } })
    expect(result).toEqual({
      id: 'contact-a',
      displayName: 'Иван',
      displayNameSource: 'provider',
      primaryPhoneId: 'phone-1',
      isArchived: false,
      customFields: STORED_CONTACT.customFields,
      phones: [
        { id: 'phone-1', phone: '79990000001', isActive: true, lifecycle: 'current' },
        { id: 'phone-2', phone: '79990000002', isActive: true, lifecycle: 'removed' },
      ],
      identities: [{ id: 'identity-1', channel: 'telegram', isActive: true, metadata: { conflictState: 'clear' }, displayName: 'ivan' }],
      mergedFromCount: 2,
      confirmedPersonName: 'Иван Петров',
    })
  })

  test('never selects a provider external id, a Chat, a Message, a Driver or a provider table', async () => {
    const { client, recorded } = recordingClient(STORED_CONTACT)
    await makePrismaContactCardSourcePortV1(client).findContactCardSource('contact-a')
    const selected = keysDeep((recorded[0].args as { select: unknown }).select)
    expect(selected).not.toContain('externalId')
    expect(selected).not.toContain('chats')
    expect(selected).not.toContain('messages')
    expect(selected).not.toContain('mainDriver')
    expect(selected).not.toContain('mainDriverId')
    expect(Object.keys((recorded[0].args as { select: Record<string, unknown> }).select).sort()).toEqual([
      'customFields', 'displayName', 'displayNameSource', 'id', 'identities', 'isArchived', 'phones', 'primaryPhoneId',
    ])
  })

  test('a missing Contact is null and nothing else is read', async () => {
    const { client, recorded } = recordingClient(null)
    expect(await makePrismaContactCardSourcePortV1(client).findContactCardSource('contact-x')).toBeNull()
    expect(recorded.map(call => `${call.model}.${call.method}`)).toEqual(['contact.findUnique'])
  })

  test('read-only: any write, raw query or foreign model access would throw inside the snapshot', async () => {
    const { client } = recordingClient(STORED_CONTACT)
    // The recording client throws on every method it was not given; a full read
    // completing proves the adapter used none of them.
    await expect(makePrismaContactCardSourcePortV1(client).findContactCardSource('contact-a')).resolves.not.toBeNull()
  })
})
