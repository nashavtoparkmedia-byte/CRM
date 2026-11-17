import { describe, expect, it, vi } from 'vitest'
import {
  CONTACT_IDENTITY_MEMBERSHIP_QUERY_V1,
  CONTACT_IDENTITY_MEMBERSHIP_RESULT_V1,
  parseContactIdentityMembershipQueryV1,
} from '@/contracts/contacts/v1'
import { createContactIdentityMembershipHandlerV1, type ContactIdentityMembershipRowV1 } from './contact-identity-membership'

/**
 * contacts.ContactIdentityMembershipQuery.v1 (V2, for Messaging's «Для связи»):
 * ids in, states out; nothing personal ever leaves.
 */
const query = (identityIds: unknown, extra: Record<string, unknown> = {}) => ({ contract: CONTACT_IDENTITY_MEMBERSHIP_QUERY_V1, contactId: 'c-old', identityIds, ...extra })

function handler(snapshot: { canonicalContactId: string; rows: ContactIdentityMembershipRowV1[] } | null) {
  const read = vi.fn(async () => snapshot)
  return { read, run: createContactIdentityMembershipHandlerV1({ read }) }
}

describe('ContactIdentityMembershipQuery.v1 contract', () => {
  it('accepts 1..25 distinct exact ids and nothing else', () => {
    expect(parseContactIdentityMembershipQueryV1(query(['i1']))).toEqual({ contract: CONTACT_IDENTITY_MEMBERSHIP_QUERY_V1, contactId: 'c-old', identityIds: ['i1'] })
    expect(parseContactIdentityMembershipQueryV1(query(Array.from({ length: 25 }, (_, i) => `i${i}`))).identityIds).toHaveLength(25)
    for (const bad of [
      query([]), query(Array.from({ length: 26 }, (_, i) => `i${i}`)), query(['i1', 'i1']), query(['']), query([' i1']), query([7]), query('i1'),
      query(['i1'], { phone: '+79990000000' }), query(['i1'], { contract: 'contacts.Other.v1' }), { contract: CONTACT_IDENTITY_MEMBERSHIP_QUERY_V1, identityIds: ['i1'] }, null,
    ]) {
      expect(() => parseContactIdentityMembershipQueryV1(bad)).toThrow(expect.objectContaining({ name: 'ContactIdentityMembershipQueryValidationError' }))
    }
  })
})

describe('ContactIdentityMembershipQuery.v1 handler', () => {
  it('answers every asked account in order: active, inactive, conflicted, another person\'s, missing', async () => {
    const { run, read } = handler({ canonicalContactId: 'c-1', rows: [
      { id: 'a', contactId: 'c-1', isActive: true, conflicted: false },
      { id: 'b', contactId: 'c-1', isActive: false, conflicted: false },
      { id: 'c', contactId: 'c-1', isActive: true, conflicted: true },
      { id: 'd', contactId: 'c-2', isActive: true, conflicted: false },
    ] })
    const result = await run(query(['d', 'a', 'x', 'b', 'c']))
    expect(read).toHaveBeenCalledWith('c-old', ['d', 'a', 'x', 'b', 'c'])
    expect(result).toEqual({
      contract: CONTACT_IDENTITY_MEMBERSHIP_RESULT_V1,
      status: 'found',
      canonicalContactId: 'c-1',
      identities: [
        { identityId: 'd', state: 'other_contact' },
        { identityId: 'a', state: 'active' },
        { identityId: 'x', state: 'missing' },
        { identityId: 'b', state: 'inactive' },
        { identityId: 'c', state: 'conflicted' },
      ],
    })
  })

  it('an account of a merged-away lineage member is another person\'s; an inactive account elsewhere stays other_contact', async () => {
    const { run } = handler({ canonicalContactId: 'c-1', rows: [
      { id: 'a', contactId: 'c-old', isActive: true, conflicted: false },
      { id: 'b', contactId: 'c-9', isActive: false, conflicted: true },
    ] })
    expect((await run(query(['a', 'b']))) ).toMatchObject({ identities: [{ identityId: 'a', state: 'other_contact' }, { identityId: 'b', state: 'other_contact' }] })
  })

  it('an unknown or archived Contact is not_found, and nothing personal is ever answered', async () => {
    expect(await handler(null).run(query(['a']))).toEqual({ contract: CONTACT_IDENTITY_MEMBERSHIP_RESULT_V1, status: 'not_found' })
    const { run } = handler({ canonicalContactId: 'c-1', rows: [{ id: 'a', contactId: 'c-1', isActive: true, conflicted: false }] })
    const result = await run(query(['a']))
    expect(Object.keys(result).sort()).toEqual(['canonicalContactId', 'contract', 'identities', 'status'])
    if (result.status === 'found') for (const identity of result.identities) expect(Object.keys(identity).sort()).toEqual(['identityId', 'state'])
  })

  it('refuses a malformed query before reading anything', async () => {
    const { run, read } = handler({ canonicalContactId: 'c-1', rows: [] })
    await expect(run(query(Array.from({ length: 26 }, (_, i) => `i${i}`)))).rejects.toMatchObject({ name: 'ContactIdentityMembershipQueryValidationError' })
    expect(read).not.toHaveBeenCalled()
  })
})
