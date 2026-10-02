import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  update: vi.fn(),
  lock: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({ prisma: {} }))
vi.mock('../../internal/contact-ownership-coordinator', () => ({
  // The real coordinator opens a Prisma interactive transaction. Here the
  // transaction body runs directly against a stub so the capability's own
  // decisions are what is under test.
  runContactOwnershipTransaction: (operation: (transaction: unknown) => unknown) => operation({
    contact: { findUnique: mocks.findUnique, update: mocks.update },
  }),
  lockContactOwnershipRows: mocks.lock,
}))

import { CanonicalContactPinErrorV1, pinCanonicalContactV1 } from './canonical-contact-pin'

const CONTACT = 'contact-canonical'
const ACTOR = 'operator-1'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.findUnique.mockResolvedValue({ id: CONTACT, isArchived: false, customFields: {} })
  mocks.update.mockResolvedValue({})
})

describe('pinCanonicalContactV1', () => {
  it('records the pin and its author, under the ownership row lock', async () => {
    const result = await pinCanonicalContactV1({ contactId: CONTACT, pinnedBy: ACTOR })

    expect(mocks.lock).toHaveBeenCalledWith(expect.anything(), { contactIds: [CONTACT] })
    expect(result.status).toBe('pinned')
    expect(result.canonicalPinnedBy).toBe(ACTOR)
    expect(result.canonicalPinnedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(mocks.update).toHaveBeenCalledWith({
      where: { id: CONTACT },
      data: {
        customFields: {
          canonicalPinnedAt: result.canonicalPinnedAt,
          canonicalPinnedBy: ACTOR,
        },
      },
    })
  })

  it('preserves every other custom field', async () => {
    mocks.findUnique.mockResolvedValue({
      id: CONTACT,
      isArchived: false,
      customFields: { driverConfirmations: [{ id: 'c1' }], phoneEvidenceByPhoneId: { p1: {} } },
    })
    await pinCanonicalContactV1({ contactId: CONTACT, pinnedBy: ACTOR })
    const written = mocks.update.mock.calls[0][0].data.customFields
    expect(written.driverConfirmations).toEqual([{ id: 'c1' }])
    expect(written.phoneEvidenceByPhoneId).toEqual({ p1: {} })
  })

  it('is idempotent: an existing pin is preserved exactly and never rewritten', async () => {
    mocks.findUnique.mockResolvedValue({
      id: CONTACT,
      isArchived: false,
      customFields: {
        canonicalPinnedAt: '2026-09-01T00:00:00.000Z',
        canonicalPinnedBy: 'earlier-operator',
      },
    })
    const result = await pinCanonicalContactV1({ contactId: CONTACT, pinnedBy: ACTOR })
    expect(result).toEqual({
      status: 'already_pinned',
      contactId: CONTACT,
      canonicalPinnedAt: '2026-09-01T00:00:00.000Z',
      canonicalPinnedBy: 'earlier-operator',
    })
    expect(mocks.update).not.toHaveBeenCalled()
  })

  it('refuses a missing or archived Contact with no write', async () => {
    for (const contact of [null, { id: CONTACT, isArchived: true, customFields: {} }]) {
      vi.clearAllMocks()
      mocks.findUnique.mockResolvedValue(contact)
      await expect(pinCanonicalContactV1({ contactId: CONTACT, pinnedBy: ACTOR }))
        .rejects.toMatchObject({ name: 'CanonicalContactPinErrorV1', code: 'CONTACT_NOT_ELIGIBLE' })
      expect(mocks.update).not.toHaveBeenCalled()
    }
  })

  it('refuses blank input before reading anything', async () => {
    for (const input of [
      { contactId: '', pinnedBy: ACTOR },
      { contactId: CONTACT, pinnedBy: '   ' },
    ]) {
      vi.clearAllMocks()
      await expect(pinCanonicalContactV1(input)).rejects.toBeInstanceOf(CanonicalContactPinErrorV1)
      expect(mocks.findUnique).not.toHaveBeenCalled()
      expect(mocks.update).not.toHaveBeenCalled()
    }
  })
})
