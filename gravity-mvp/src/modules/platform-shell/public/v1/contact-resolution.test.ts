import { describe, expect, test, vi } from 'vitest'

vi.mock('@/modules/contacts/public/v1', () => ({
  resolveChannelContactOperationV1: vi.fn(),
  resolveContactByPhoneV1: vi.fn(),
}))
vi.mock('@/infrastructure/automatic-contact-merge', () => ({
  executeAutomaticContactMergeV1: vi.fn(),
}))

import { resolveWithAutomaticMergeV1 } from './contact-resolution'

const ambiguous = (candidateContactIds: string[]) => ({
  status: 'ambiguous' as const,
  candidateContactIds,
  candidateCount: candidateContactIds.length,
  warnings: [],
})

describe('Platform contact resolution composition', () => {
  test('attempts one sorted exact pair and re-resolves once after an authorized merge', async () => {
    const resolved = {
      status: 'resolved' as const,
      contact: { id: 'contact-a', displayName: 'A' },
      identity: null,
      phoneId: 'phone-a',
      isNew: false,
      warnings: [],
    }
    const resolve = vi.fn()
      .mockResolvedValueOnce(ambiguous(['contact-b', 'contact-a', 'contact-b']))
      .mockResolvedValueOnce(resolved)
    const attempt = vi.fn().mockResolvedValue({ status: 'merged' as const })

    await expect(resolveWithAutomaticMergeV1(resolve, attempt)).resolves.toEqual(resolved)
    expect(attempt).toHaveBeenCalledWith({ leftContactId: 'contact-a', rightContactId: 'contact-b' })
    expect(resolve).toHaveBeenCalledTimes(2)
  })

  test('preserves ambiguity without retry when locked policy blocks the pair', async () => {
    const first = ambiguous(['contact-a', 'contact-b'])
    const resolve = vi.fn().mockResolvedValue(first)
    const attempt = vi.fn().mockResolvedValue({ status: 'policy_blocked' as const })
    await expect(resolveWithAutomaticMergeV1(resolve, attempt)).resolves.toBe(first)
    expect(resolve).toHaveBeenCalledTimes(1)
  })

  test.each([
    ['one candidate', ['contact-a']],
    ['three candidates', ['contact-a', 'contact-b', 'contact-c']],
  ])('never reduces %s to a destructive pair', async (_label, candidates) => {
    const first = ambiguous(candidates)
    const attempt = vi.fn()
    await expect(resolveWithAutomaticMergeV1(() => Promise.resolve(first), attempt)).resolves.toBe(first)
    expect(attempt).not.toHaveBeenCalled()
  })

  test('does not invoke Auto Merge for a stable-identity conflict', async () => {
    const result = {
      status: 'identity_phone_conflict' as const,
      identityContactId: 'identity-owner',
      phoneContactIds: ['phone-owner'],
      warnings: [],
    }
    const attempt = vi.fn()
    await expect(resolveWithAutomaticMergeV1(() => Promise.resolve(result), attempt)).resolves.toBe(result)
    expect(attempt).not.toHaveBeenCalled()
  })

  test('keeps the safe ambiguity when optional merge infrastructure fails', async () => {
    const first = ambiguous(['contact-a', 'contact-b'])
    const error = new Error('coordinator busy')
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      await expect(resolveWithAutomaticMergeV1(
        () => Promise.resolve(first),
        () => Promise.reject(error),
      )).resolves.toBe(first)
      expect(consoleError).toHaveBeenCalledWith(
        '[platform-shell] Optional automatic contact merge failed:',
        error,
      )
    } finally {
      consoleError.mockRestore()
    }
  })
})
