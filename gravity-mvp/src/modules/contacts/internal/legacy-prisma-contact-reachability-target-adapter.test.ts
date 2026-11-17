import { describe, expect, it, vi } from 'vitest'
vi.mock('@/lib/prisma', () => ({ prisma: {} }))
import { makeContactReachabilityTargetReaderV1 } from './legacy-prisma-contact-reachability-target-adapter'

/** «Проверить» resolves only this Contact's own stored number and its exact binding (V2 W5). */
function reader(rows: {
  contact?: { id: string; isArchived: boolean } | null
  identity?: { id: string; phoneId: string | null; isActive: boolean; metadata: unknown } | null
  phone?: { phone: string; isActive: boolean } | null
}) {
  const calls: unknown[] = []
  const read = makeContactReachabilityTargetReaderV1({
    contact: { findUnique: vi.fn(async (args: unknown) => { calls.push(['contact', args]); return rows.contact === undefined ? { id: 'c1', isArchived: false } : rows.contact }) },
    contactIdentity: { findFirst: vi.fn(async (args: unknown) => { calls.push(['identity', args]); return rows.identity ?? null }) },
    contactPhone: { findFirst: vi.fn(async (args: unknown) => { calls.push(['phone', args]); return rows.phone === undefined ? { phone: '+79991000101', isActive: true } : rows.phone }) },
  } as never)
  return { read, calls }
}

describe('readContactReachabilityTargetV1', () => {
  it('a phone of this Contact: its stored number, no binding', async () => {
    const { read, calls } = reader({})
    await expect(read({ contactId: 'c1', channel: 'whatsapp', phoneId: 'p1', identityId: null })).resolves.toEqual({ status: 'found', phone: '+79991000101', exactBinding: null })
    expect(calls).toContainEqual(['phone', { where: { id: 'p1', contactId: 'c1' }, select: { phone: true, isActive: true } }])
  })

  it('an account of this Contact on this channel: its own number and its exact binding', async () => {
    const { read, calls } = reader({ identity: { id: 'i1', phoneId: 'p1', isActive: true, metadata: { providerAccountId: 'wa-1' } } })
    await expect(read({ contactId: 'c1', channel: 'whatsapp', phoneId: null, identityId: 'i1' })).resolves.toEqual({
      status: 'found', phone: '+79991000101', exactBinding: { identityId: 'i1', contactId: 'c1', providerAccountId: 'wa-1' },
    })
    expect(calls).toContainEqual(['identity', { where: { id: 'i1', contactId: 'c1', channel: 'whatsapp' }, select: { id: true, phoneId: true, isActive: true, metadata: true } }])
  })

  it('a legacy, conflicted or inactive account checks the number without a binding', async () => {
    for (const identity of [
      { id: 'i1', phoneId: 'p1', isActive: true, metadata: {} },
      { id: 'i1', phoneId: 'p1', isActive: true, metadata: { providerAccountId: 'wa-1', conflictState: 'conflicted' } },
      { id: 'i1', phoneId: 'p1', isActive: false, metadata: { providerAccountId: 'wa-1' } },
    ]) {
      await expect(reader({ identity }).read({ contactId: 'c1', channel: 'whatsapp', phoneId: null, identityId: 'i1' })).resolves.toMatchObject({ status: 'found', exactBinding: null })
    }
  })

  it('anything that is not this Contact\'s own is not found', async () => {
    const cases: Array<[Parameters<typeof reader>[0], { phoneId: string | null; identityId: string | null }]> = [
      [{ contact: null }, { phoneId: 'p1', identityId: null }],
      [{ contact: { id: 'c1', isArchived: true } }, { phoneId: 'p1', identityId: null }],
      [{ phone: null }, { phoneId: 'other-contacts-phone', identityId: null }],
      [{ phone: { phone: '+79991000101', isActive: false } }, { phoneId: 'p1', identityId: null }],
      [{ identity: null }, { phoneId: null, identityId: 'other-contacts-account' }],
      [{ identity: { id: 'i1', phoneId: 'p2', isActive: true, metadata: {} } }, { phoneId: 'p1', identityId: 'i1' }],
      [{ identity: { id: 'i1', phoneId: null, isActive: true, metadata: {} } }, { phoneId: null, identityId: 'i1' }],
    ]
    for (const [rows, ids] of cases) {
      await expect(reader(rows).read({ contactId: 'c1', channel: 'whatsapp', ...ids })).resolves.toEqual({ status: 'not_found' })
    }
  })
})
