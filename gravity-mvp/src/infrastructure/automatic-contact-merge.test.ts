import { beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ mergeContactsV1: vi.fn() }))

vi.mock('./contact-merge-composition', () => ({ mergeContactsV1: mocks.mergeContactsV1 }))

import { executeAutomaticContactMergeV1 } from './automatic-contact-merge'

describe('automatic contact merge request boundary', () => {
  beforeEach(() => vi.clearAllMocks())

  test('supplies only a request marker and returns the locked handler survivor', async () => {
    mocks.mergeContactsV1.mockResolvedValue({
      contract: 'contacts.MergeContactsResult.v1',
      status: 'contact_merged',
      survivorId: 'contact-b',
      mergedId: 'contact-a',
      mergeRecordId: 'merge-1',
    })

    await expect(executeAutomaticContactMergeV1({
      leftContactId: 'contact-b',
      rightContactId: 'contact-a',
    })).resolves.toMatchObject({ status: 'merged', survivorContactId: 'contact-b' })
    expect(mocks.mergeContactsV1).toHaveBeenCalledWith(expect.objectContaining({
      operation: 'contact_to_contact',
      sourceId: 'contact-a',
      targetId: 'contact-b',
      mergedBy: 'system:auto-merge',
      automation: {
        trustedUniqueCurrentPhone: false,
        phoneEvidenceRoot: null,
        confirmedPersonEvidenceRoots: [],
        normalizedVuEvidenceRoots: [],
      },
    }))
  })

  test('returns the policy block committed by the locked merge handler', async () => {
    const blockedResult = {
      contract: 'contacts.MergeContactsResult.v1',
      status: 'automatic_merge_blocked',
      leftContactId: 'contact-a',
      rightContactId: 'contact-b',
      reason: 'hard_conflict',
    } as const
    mocks.mergeContactsV1.mockResolvedValue(blockedResult)

    await expect(executeAutomaticContactMergeV1({
      leftContactId: 'contact-a',
      rightContactId: 'contact-b',
    })).resolves.toEqual({
      status: 'policy_blocked',
      reason: 'hard_conflict',
      result: blockedResult,
    })
  })

  test('returns the active canonical survivor supplied by an idempotent chain retry', async () => {
    mocks.mergeContactsV1.mockResolvedValue({
      contract: 'contacts.MergeContactsResult.v1',
      status: 'already_merged',
      sourceId: 'contact-a',
      targetId: 'contact-c',
    })

    await expect(executeAutomaticContactMergeV1({
      leftContactId: 'contact-a',
      rightContactId: 'contact-b',
    })).resolves.toMatchObject({ status: 'merged', survivorContactId: 'contact-c' })
  })

  test('rejects self-pairs without entering the merge transaction', async () => {
    await expect(executeAutomaticContactMergeV1({
      leftContactId: 'contact-a',
      rightContactId: 'contact-a',
    })).resolves.toEqual({ status: 'invalid_pair', reason: 'invalid_contact_pair' })
    expect(mocks.mergeContactsV1).not.toHaveBeenCalled()
  })

  test('does not disguise an unexpected infrastructure failure as a policy decision', async () => {
    mocks.mergeContactsV1.mockRejectedValue(new Error('database unavailable'))
    await expect(executeAutomaticContactMergeV1({
      leftContactId: 'contact-a',
      rightContactId: 'contact-b',
    })).rejects.toThrow('database unavailable')
  })
})
