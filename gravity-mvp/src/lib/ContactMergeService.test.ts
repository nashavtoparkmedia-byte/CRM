import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  mergeContactsV1: vi.fn(),
}))

vi.mock('@/modules/contacts/public/v1', () => {
  class ContactMergeErrorV1 extends Error {
    readonly code: string

    constructor(code: string, message: string) {
      super(message)
      this.name = 'MergeError'
      this.code = code
    }
  }

  return {
    ContactMergeErrorV1,
  }
})

vi.mock('@/infrastructure/contact-merge-composition', () => ({
  mergeContactsV1: mocks.mergeContactsV1,
}))

import { MERGE_CONTACTS_COMMAND_V1, MERGE_CONTACTS_RESULT_V1 } from '@/contracts/contacts/v1'
import { ContactMergeService, MergeError } from './ContactMergeService'

describe('ContactMergeService compatibility facade', () => {
  beforeEach(() => {
    mocks.mergeContactsV1.mockReset()
  })

  it('retires the legacy contact-to-driver facade before composition', async () => {
    await expect(ContactMergeService.mergeContactToDriver('source', 'driver-request-id'))
      .rejects.toMatchObject({
        name: 'MergeError',
        code: 'DRIVER_PERSON_CONFIRMATION_REQUIRED',
      })
    expect(mocks.mergeContactsV1).not.toHaveBeenCalled()
  })

  it('keeps the contact-to-contact signature and strips only the contract envelope', async () => {
    mocks.mergeContactsV1.mockResolvedValue({
      contract: MERGE_CONTACTS_RESULT_V1,
      status: 'already_merged',
      sourceId: 'source',
      targetId: 'target',
    })

    await expect(ContactMergeService.mergeContactToContact('source', 'target', 'manager')).resolves.toEqual({
      status: 'already_merged',
      sourceId: 'source',
      targetId: 'target',
    })
    expect(mocks.mergeContactsV1).toHaveBeenCalledWith({
      contract: MERGE_CONTACTS_COMMAND_V1,
      operation: 'contact_to_contact',
      sourceId: 'source',
      targetId: 'target',
      mergedBy: 'manager',
    })
  })

  it('preserves a typed automatic-merge block through the compatibility facade', async () => {
    mocks.mergeContactsV1.mockResolvedValue({
      contract: MERGE_CONTACTS_RESULT_V1,
      status: 'automatic_merge_blocked',
      leftContactId: 'source',
      rightContactId: 'target',
      reason: 'business_state_collision',
    })

    await expect(ContactMergeService.mergeContactToContact('source', 'target')).resolves.toEqual({
      status: 'automatic_merge_blocked',
      leftContactId: 'source',
      rightContactId: 'target',
      reason: 'business_state_collision',
    })
  })

  it('retains the MergeError runtime constructor expected by the contact merge route', () => {
    const error = new MergeError('CONTACT_NOT_FOUND', 'missing')
    expect(error).toMatchObject({ name: 'MergeError', code: 'CONTACT_NOT_FOUND', message: 'missing' })
    expect(error).toBeInstanceOf(MergeError)
  })
})
