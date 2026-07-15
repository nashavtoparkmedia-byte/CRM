import { readFileSync } from 'fs'
import path from 'path'
import { describe, expect, test, vi } from 'vitest'

import {
  classifyContactPhoneOwnership,
  createPhoneConfirmationToken,
  verifyPhoneConfirmationToken,
  type PhoneMergeEdge,
  type PhoneOwnershipContact,
  type PhoneOwnershipRepository,
} from '../contacts/contact-phone-resolution'
import { normalizeRussianPhoneE164 } from '../phoneUtils'

const PHONE = '+79222155750'

function contact(id: string, isArchived = false): PhoneOwnershipContact {
  return { id, isArchived }
}

function repository(options: {
  target?: PhoneOwnershipContact | null
  owners?: PhoneOwnershipContact[]
  merges?: Record<string, PhoneMergeEdge[]>
} = {}): PhoneOwnershipRepository {
  return {
    findContact: vi.fn(async () => options.target === undefined ? contact('target') : options.target),
    findActivePhoneOwners: vi.fn(async () => options.owners || []),
    findMergeSurvivors: vi.fn(async id => options.merges?.[id] || []),
  }
}

describe('strict Russian phone normalization', () => {
  test.each([
    ['8 922 215-57-50', PHONE],
    ['+7 922 215-57-50', PHONE],
    ['79222155750', PHONE],
    ['(922) 215 57 50', PHONE],
  ])('normalizes %s', (input, expected) => {
    expect(normalizeRussianPhoneE164(input)).toBe(expected)
  })

  test.each(['', '123', '+1 922 215-57-50', '0079222155750', 'abc'])('rejects invalid input %s', input => {
    expect(normalizeRussianPhoneE164(input)).toBeNull()
  })
})

describe('ContactPhone ownership classification', () => {
  test('0 active owners is FREE', async () => {
    await expect(classifyContactPhoneOwnership('target', PHONE, repository()))
      .resolves.toMatchObject({ ownershipStatus: 'FREE', canonicalOwnerIds: [] })
  })

  test('one canonical owner equal to target is SAME_CONTACT', async () => {
    await expect(classifyContactPhoneOwnership('target', PHONE, repository({ owners: [contact('target')] })))
      .resolves.toMatchObject({ ownershipStatus: 'SAME_CONTACT', canonicalOwnerIds: ['target'] })
  })

  test('one other canonical owner is OTHER_CONTACT', async () => {
    await expect(classifyContactPhoneOwnership('target', PHONE, repository({ owners: [contact('other')] })))
      .resolves.toMatchObject({ ownershipStatus: 'OTHER_CONTACT', canonicalOwnerIds: ['other'] })
  })

  test('two canonical owners is AMBIGUOUS and order-independent', async () => {
    const first = await classifyContactPhoneOwnership('target', PHONE, repository({ owners: [contact('B'), contact('A')] }))
    const second = await classifyContactPhoneOwnership('target', PHONE, repository({ owners: [contact('A'), contact('B')] }))
    expect(first).toMatchObject({ ownershipStatus: 'AMBIGUOUS', canonicalOwnerIds: ['A', 'B'] })
    expect(second.fingerprint).toBe(first.fingerprint)
  })

  test('two merged rows with one canonical survivor count as one owner', async () => {
    const result = await classifyContactPhoneOwnership('target', PHONE, repository({
      owners: [contact('A', true), contact('B', true)],
      merges: {
        A: [{ survivor: contact('target') }],
        B: [{ survivor: contact('target') }],
      },
    }))
    expect(result).toMatchObject({ ownershipStatus: 'SAME_CONTACT', canonicalOwnerIds: ['target'] })
  })

  test('archived owner without a canonical survivor is AMBIGUOUS', async () => {
    await expect(classifyContactPhoneOwnership('target', PHONE, repository({ owners: [contact('archived', true)] })))
      .resolves.toMatchObject({ ownershipStatus: 'AMBIGUOUS', unsafeContactIds: ['archived'] })
  })

  test('merge cycle is AMBIGUOUS instead of selecting a random Contact', async () => {
    const result = await classifyContactPhoneOwnership('target', PHONE, repository({
      owners: [contact('A', true)],
      merges: {
        A: [{ survivor: contact('B', true) }],
        B: [{ survivor: contact('A', true) }],
      },
    }))
    expect(result).toMatchObject({ ownershipStatus: 'AMBIGUOUS', unsafeContactIds: ['A', 'B'] })
  })
})

describe('preflight confirmation token', () => {
  const secret = 'test-secret'
  const payload = {
    contactId: 'target',
    normalizedPhone: PHONE,
    ownershipStatus: 'FREE' as const,
    fingerprint: 'FREE:',
  }

  test('round-trips a valid token', () => {
    const token = createPhoneConfirmationToken(payload, { secret, now: 1000 })
    expect(verifyPhoneConfirmationToken(token, { secret, now: 2000 })).toMatchObject(payload)
  })

  test('rejects tampering and expiry', () => {
    const token = createPhoneConfirmationToken(payload, { secret, now: 1000 })
    expect(() => verifyPhoneConfirmationToken(`${token}x`, { secret, now: 2000 })).toThrow('invalid')
    expect(() => verifyPhoneConfirmationToken(token, { secret, now: 1000 + 5 * 60 * 1000 + 1 })).toThrow('expired')
  })
})

describe('ContactPhone mutation source safety', () => {
  test('canonical confirm rechecks under a read-committed advisory lock', () => {
    const source = readFileSync(path.join(process.cwd(), 'src/lib/contacts/contact-phone-resolution.ts'), 'utf8')
    expect(source).toContain('pg_advisory_xact_lock')
    expect(source).toContain('TransactionIsolationLevel.ReadCommitted')
    expect(source).toContain('classifyContactPhoneOwnership')
    expect(source).toContain("evaluation.ownershipStatus !== 'FREE'")
  })

  test('phone-only matches remain six-park suggestions and never auto-attach', () => {
    const source = readFileSync(path.join(process.cwd(), 'src/lib/contacts/contact-phone-resolution.ts'), 'utf8')
    expect(source).toContain('findSuggestedDriverProfilesByPhone')
    expect(source).toContain('PARK_PRIORITY')
    expect(source).toContain('ContactResolutionService.fromPrisma().resolve')
    expect(source).not.toContain('attachDriverProfilesToContactByPhone')
    expect(source).not.toContain('attachDriverProfilesToContactManually')
    expect(source).not.toContain('mergeContact')
  })

  test('legacy direct route performs zero ContactPhone writes', () => {
    const source = readFileSync(path.join(process.cwd(), 'src/app/api/contacts/[id]/phones/route.ts'), 'utf8')
    expect(source).toContain('PHONE_RESOLUTION_REQUIRED')
    expect(source).not.toMatch(/contactPhone\.(create|update|upsert)/)
  })
})
