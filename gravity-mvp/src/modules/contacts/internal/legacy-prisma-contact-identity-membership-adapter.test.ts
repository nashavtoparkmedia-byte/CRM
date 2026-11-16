import { describe, expect, it, vi } from 'vitest'
vi.mock('@/lib/prisma', () => ({ prisma: {} }))
import { makePrismaContactIdentityMembershipSourceV1 } from './legacy-prisma-contact-identity-membership-adapter'

/** The membership reader selects ids and flags only, in one REPEATABLE READ snapshot. */
function client(rows: { contact: unknown; merged?: string | null; identities: unknown[] }) {
  const calls: Array<[string, unknown]> = []
  const tx = {
    contact: {
      findUnique: vi.fn(async (args: { where: { id: string }, select: Record<string, boolean> }) => {
        calls.push(['contact.findUnique', args])
        // The lineage port reads redirects with its own select; the reader's own read asks id and isArchived.
        if (args.select && 'customFields' in args.select) return { id: args.where.id, customFields: {}, isArchived: false }
        return rows.contact
      }),
      findMany: vi.fn(async () => []),
    },
    contactMerge: { findFirst: vi.fn(async () => null), findMany: vi.fn(async () => []) },
    contactIdentity: { findMany: vi.fn(async (args: unknown) => { calls.push(['contactIdentity.findMany', args]); return rows.identities }) },
  }
  const $transaction = vi.fn(async (work: (t: unknown) => unknown, options: unknown) => { calls.push(['$transaction', options]); return work(tx) })
  return { client: { $transaction } as never, calls }
}

describe('legacy Prisma ContactIdentityMembership source', () => {
  it('reads the asked accounts with ids and flags only, never a phone, an externalId or a name', async () => {
    const { client: c, calls } = client({ contact: { id: 'c-1', isArchived: false }, identities: [{ id: 'a', contactId: 'c-1', isActive: true, metadata: { conflictState: 'conflicted' } }] })
    const answer = await makePrismaContactIdentityMembershipSourceV1(c).read('c-1', ['a'])
    expect(answer).toEqual({ canonicalContactId: 'c-1', rows: [{ id: 'a', contactId: 'c-1', isActive: true, conflicted: true }] })
    expect(calls).toContainEqual(['$transaction', { isolationLevel: 'RepeatableRead' }])
    expect(calls).toContainEqual(['contactIdentity.findMany', { where: { id: { in: ['a'] } }, select: { id: true, contactId: true, isActive: true, metadata: true } }])
    expect(JSON.stringify(calls)).not.toMatch(/externalId|phone|displayName/u)
  })

  it('an archived canonical Contact is no answer', async () => {
    const { client: c } = client({ contact: { id: 'c-1', isArchived: true }, identities: [] })
    expect(await makePrismaContactIdentityMembershipSourceV1(c).read('c-1', ['a'])).toBeNull()
  })
})
