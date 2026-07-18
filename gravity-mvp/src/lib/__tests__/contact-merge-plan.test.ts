import { describe, expect, test } from 'vitest'

import {
  ContactMergeTokenError,
  createContactMergeConfirmationToken,
  hashMergeValue,
  verifyContactMergeConfirmationToken,
} from '@/lib/contacts/contact-merge-plan'

const payload = {
  actorId: 'operator-1',
  sourceId: 'source',
  targetId: 'target',
  planHash: 'plan-hash',
  sourceVersion: 'source-version',
  targetVersion: 'target-version',
}

describe('Contact merge plan evidence', () => {
  test('hashes equivalent objects deterministically', () => {
    expect(hashMergeValue({ b: 2, a: { y: 2, x: 1 } }))
      .toBe(hashMergeValue({ a: { x: 1, y: 2 }, b: 2 }))
  })

  test('signs all actor, plan and version fields', () => {
    const { token } = createContactMergeConfirmationToken(payload, {
      secret: 'test-secret',
      now: 1000,
    })
    expect(verifyContactMergeConfirmationToken(token, {
      secret: 'test-secret',
      now: 2000,
    })).toMatchObject(payload)
  })

  test('rejects a modified signature', () => {
    const { token } = createContactMergeConfirmationToken(payload, {
      secret: 'test-secret',
      now: 1000,
    })
    expect(() => verifyContactMergeConfirmationToken(`${token}x`, {
      secret: 'test-secret',
      now: 2000,
    })).toThrow(ContactMergeTokenError)
  })

  test('rejects an expired preview token', () => {
    const { token, expiresAt } = createContactMergeConfirmationToken(payload, {
      secret: 'test-secret',
      now: 1000,
    })
    expect(() => verifyContactMergeConfirmationToken(token, {
      secret: 'test-secret',
      now: expiresAt + 1,
    })).toThrow('expired')
  })
})
