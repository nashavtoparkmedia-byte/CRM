import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  addPhoneToContact: vi.fn(),
  cleanupDanglingIdentities: vi.fn(),
  resolveContact: vi.fn(),
  resolveByPhone: vi.fn(),
}))

vi.mock('@/lib/ContactService', () => ({ ContactService: mocks }))

import {
  addPhoneToContactV1,
  cleanupDanglingContactIdentitiesV1,
  resolveChannelContactOperationV1,
  resolveContactByPhoneV1,
} from './contact-identity-maintenance'

beforeEach(() => vi.clearAllMocks())

describe('Contacts identity maintenance capabilities', () => {
  it('delegates only the fixed phone-resolution and attachment operations', async () => {
    const options = { source: 'avito' as const, makePrimary: true, deactivateTemporaries: true }
    mocks.resolveByPhone.mockResolvedValue({ contact: { id: 'contact-1' }, phoneId: 'phone-1', isNew: false })
    mocks.resolveContact.mockResolvedValue({ contact: { id: 'contact-1' }, identity: { id: 'identity-1' }, isNew: false })
    mocks.addPhoneToContact.mockResolvedValue({ kind: 'added', phoneId: 'phone-2', contactId: 'contact-1' })

    await resolveChannelContactOperationV1('avito', 'lead-1', '+79990000001', 'Contact One')
    await resolveContactByPhoneV1('+79990000001', 'Contact One')
    await addPhoneToContactV1('contact-1', '+79990000002', options)

    expect(mocks.resolveContact).toHaveBeenCalledWith('avito', 'lead-1', '+79990000001', 'Contact One')
    expect(mocks.resolveByPhone).toHaveBeenCalledWith('+79990000001', 'Contact One')
    expect(mocks.addPhoneToContact).toHaveBeenCalledWith('contact-1', '+79990000002', options)
  })

  it('delegates cleanup only for the explicitly supplied contact identities', async () => {
    mocks.cleanupDanglingIdentities.mockResolvedValue(2)
    await expect(cleanupDanglingContactIdentitiesV1(['contact-1', 'contact-2'])).resolves.toBe(2)
    expect(mocks.cleanupDanglingIdentities).toHaveBeenCalledWith(['contact-1', 'contact-2'])
  })
})
