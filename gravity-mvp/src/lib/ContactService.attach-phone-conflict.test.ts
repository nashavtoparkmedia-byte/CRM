import { beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  assertPostconditions: vi.fn(),
  lockRows: vi.fn(),
  runOwnership: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({ prisma: {} }))
vi.mock('@/modules/contacts/internal/contact-ownership-coordinator', () => ({
  assertContactOwnershipPostconditions: mocks.assertPostconditions,
  lockContactOwnershipRows: mocks.lockRows,
  runContactOwnershipTransaction: mocks.runOwnership,
}))

import { ContactService } from './ContactService'

const NORMALIZED_PHONE = '+79990000001'
const SCOPE = {
  contactIds: ['attempted-contact', 'phone-owner'],
  phoneIds: ['owned-phone'],
  normalizedPhones: [NORMALIZED_PHONE],
  identityIds: ['stable-identity'],
  mergeIds: [],
}

describe('ContactService stable identity phone conflicts', () => {
  let contactCustomFields: Record<string, unknown>
  let identityMetadata: Record<string, unknown>
  let transaction: {
    contact: { findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> }
    contactIdentity: { findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> }
    contactPhone: {
      findMany: ReturnType<typeof vi.fn>
      findUnique: ReturnType<typeof vi.fn>
      create: ReturnType<typeof vi.fn>
      update: ReturnType<typeof vi.fn>
    }
  }

  beforeEach(() => {
    vi.clearAllMocks()
    contactCustomFields = { retained: 'contact-metadata' }
    identityMetadata = {
      providerAccountId: 'provider-account-1',
      origin: 'provider',
      evidenceRoot: 'provider:telegram:provider-account-1:external-user-1',
      retained: 'identity-metadata',
      conflictState: 'clear',
    }
    transaction = {
      contact: {
        findUnique: vi.fn(async () => ({
          id: 'attempted-contact',
          displayName: 'Attempted Contact',
          displayNameSource: 'manual',
          isArchived: false,
          primaryPhoneId: null,
          customFields: contactCustomFields,
        })),
        update: vi.fn(async ({ data }: { data: { customFields: Record<string, unknown> } }) => {
          contactCustomFields = data.customFields
          return { id: 'attempted-contact' }
        }),
      },
      contactIdentity: {
        findUnique: vi.fn(async () => ({
          id: 'stable-identity',
          contactId: 'attempted-contact',
          channel: 'telegram',
          externalId: 'external-user-1',
          phoneId: null,
          reachabilityStatus: 'unknown',
          phone: null,
          metadata: identityMetadata,
        })),
        update: vi.fn(async ({ data }: { data: { metadata: Record<string, unknown> } }) => {
          identityMetadata = data.metadata
          return { id: 'stable-identity' }
        }),
      },
      contactPhone: {
        findMany: vi.fn(async (query?: { select?: { contactId?: boolean } }) => (
          query?.select
            ? [{ contactId: 'phone-owner' }]
            : [{
                id: 'owned-phone',
                contactId: 'phone-owner',
                contact: { id: 'phone-owner', displayName: 'Phone Owner' },
              }]
        )),
        findUnique: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
      },
    }
    mocks.lockRows.mockResolvedValue(SCOPE)
    mocks.assertPostconditions.mockResolvedValue(undefined)
    mocks.runOwnership.mockImplementation(async (work: (value: unknown) => Promise<unknown>) => work(transaction))
  })

  test('persists evidence and marks the stable identity before returning the existing conflict result', async () => {
    await expect(ContactService.attachPhoneToIdentity(
      'attempted-contact',
      'stable-identity',
      NORMALIZED_PHONE,
      { source: 'telegram', confirmed: true },
    )).resolves.toEqual({
      kind: 'conflict',
      otherContactId: 'phone-owner',
      otherContactName: 'Phone Owner',
    })

    expect(contactCustomFields).toMatchObject({
      retained: 'contact-metadata',
      identityConflicts: [expect.objectContaining({
        otherContactIds: ['phone-owner'],
        identityId: 'stable-identity',
        conflictType: 'stable_identity_phone_contradiction',
        evidenceRoot: 'provider:telegram:provider-account-1:external-user-1',
        source: 'attach-phone-to-identity',
        status: 'open',
        details: expect.objectContaining({
          normalizedPhone: NORMALIZED_PHONE,
          phoneContactIds: ['phone-owner'],
        }),
      })],
    })
    expect(identityMetadata).toEqual(expect.objectContaining({
      retained: 'identity-metadata',
      conflictState: 'conflicted',
    }))
    expect(transaction.contactPhone.create).not.toHaveBeenCalled()
    expect(transaction.contactPhone.update).not.toHaveBeenCalled()
    expect(mocks.lockRows).toHaveBeenCalledWith(transaction, {
      contactIds: ['attempted-contact'],
      identityIds: ['stable-identity'],
      normalizedPhones: [NORMALIZED_PHONE],
    })
    expect(mocks.assertPostconditions).toHaveBeenCalledWith(transaction, SCOPE)
    expect(mocks.lockRows.mock.invocationCallOrder[0])
      .toBeLessThan(transaction.contact.update.mock.invocationCallOrder[0])
    expect(transaction.contactIdentity.update.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.assertPostconditions.mock.invocationCallOrder[0])
  })

  test('deduplicates the same open evidence while still checking ownership postconditions', async () => {
    const first = await ContactService.attachPhoneToIdentity(
      'attempted-contact',
      'stable-identity',
      NORMALIZED_PHONE,
    )
    const second = await ContactService.attachPhoneToIdentity(
      'attempted-contact',
      'stable-identity',
      NORMALIZED_PHONE,
    )

    expect(second).toEqual(first)
    expect((contactCustomFields.identityConflicts as unknown[])).toHaveLength(1)
    expect(transaction.contact.update).toHaveBeenCalledTimes(1)
    expect(transaction.contactIdentity.update).toHaveBeenCalledTimes(1)
    expect(mocks.assertPostconditions).toHaveBeenCalledTimes(2)
  })
})
