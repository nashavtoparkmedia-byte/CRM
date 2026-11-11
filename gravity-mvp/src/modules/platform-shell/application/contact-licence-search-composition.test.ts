/**
 * The «Люди» search by an exact ВУ: Contacts' read authority first, Fleet only
 * after it allows, with the view passed on unchanged; the typed licence is never
 * echoed, logged or quoted; an unmasked ВУ for a last-4 reader is withheld.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DRIVER_PROFILES_BY_EXACT_LICENCE_RESULT_V1, type DriverProfileByExactLicenceV1 } from '@/contracts/fleet-operations/v1'
import type { ContactReadAuthorityV1 } from '@/modules/contacts/public/v1'
import { createContactLicenceSearchCompositionV1 } from './contact-licence-search-composition'

const TYPED = '99 12 345678'

function allow(licenceView: 'full' | 'last4'): ContactReadAuthorityV1 {
  return { decision: 'allow', principal: { kind: 'staff_session', userId: 'u1', role: licenceView === 'full' ? 'Администратор' : 'Менеджер' }, licenceView, policyVersion: 'contacts.read-authority.v1' }
}

function row(overrides: Partial<DriverProfileByExactLicenceV1> = {}): DriverProfileByExactLicenceV1 {
  return { driverId: 'd-1', linkedContactId: 'c-1', externalParkId: 'p', externalDriverProfileId: 'x', parkName: 'Парк', fullName: 'Иванов Иван', licence: '•••• 5678', dismissedAt: null, ...overrides }
}

afterEach(() => { vi.restoreAllMocks() })

describe('searchPeopleByExactLicenceV1', () => {
  it('asks Fleet nothing for a caller without read authority', async () => {
    for (const reason of ['no_session', 'staff_session_refused', 'transitional_admin_read_disabled'] as const) {
      const find = vi.fn()
      const search = createContactLicenceSearchCompositionV1({ resolveReadAuthority: async () => ({ decision: 'deny', reason }), findDriverProfilesByExactLicence: find })
      await expect(search(TYPED)).resolves.toEqual({ status: 'denied' })
      expect(find).not.toHaveBeenCalled()
    }
  })

  it('passes the typed licence and the caller\'s view to Fleet, and answers the profiles without the typed value', async () => {
    for (const licenceView of ['full', 'last4'] as const) {
      const find = vi.fn().mockResolvedValue({
        contract: DRIVER_PROFILES_BY_EXACT_LICENCE_RESULT_V1,
        profiles: [row({ licence: licenceView === 'full' ? TYPED : '•••• 5678' }), row({ driverId: 'd-2', linkedContactId: null, licence: licenceView === 'full' ? TYPED : '•••• 5678' })],
        truncated: false,
      })
      const search = createContactLicenceSearchCompositionV1({ resolveReadAuthority: async () => allow(licenceView), findDriverProfilesByExactLicence: find })
      const result = await search(TYPED)
      expect(find).toHaveBeenCalledWith({ contract: 'fleet_operations.DriverProfilesByExactLicenceQuery.v1', licence: TYPED, licenceView })
      expect(result).toEqual({
        status: 'answered',
        profiles: [
          { driverId: 'd-1', linkedContactId: 'c-1', fullName: 'Иванов Иван', parkName: 'Парк', licence: licenceView === 'full' ? TYPED : '•••• 5678', dismissedAt: null },
          { driverId: 'd-2', linkedContactId: null, fullName: 'Иванов Иван', parkName: 'Парк', licence: licenceView === 'full' ? TYPED : '•••• 5678', dismissedAt: null },
        ],
        truncated: false,
      })
      if (licenceView === 'last4') expect(JSON.stringify(result)).not.toContain('345678')
    }
  })

  it('an allow without a view asks Fleet for the last-4 view, never the full one', async () => {
    const find = vi.fn().mockResolvedValue({ contract: DRIVER_PROFILES_BY_EXACT_LICENCE_RESULT_V1, profiles: [], truncated: false })
    const { licenceView: _dropped, ...withoutView } = allow('full')
    const search = createContactLicenceSearchCompositionV1({ resolveReadAuthority: async () => withoutView as never, findDriverProfilesByExactLicence: find })
    await search(TYPED)
    expect(find.mock.calls[0]?.[0]).toMatchObject({ licenceView: 'last4' })
  })

  it('refuses a value that is not a licence before any read', async () => {
    for (const value of [undefined, null, 42, ['x'], 'x'.repeat(65)]) {
      const find = vi.fn()
      const search = createContactLicenceSearchCompositionV1({ resolveReadAuthority: async () => allow('last4'), findDriverProfilesByExactLicence: find })
      await expect(search(value)).resolves.toEqual({ status: 'invalid' })
      expect(find).not.toHaveBeenCalled()
    }
  })

  it('a Fleet failure is unavailable, and neither the typed licence nor the failure text is logged', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const search = createContactLicenceSearchCompositionV1({
      resolveReadAuthority: async () => allow('last4'),
      findDriverProfilesByExactLicence: async () => { throw new Error(`lookup of ${TYPED} failed`) },
    })
    await expect(search(TYPED)).resolves.toEqual({ status: 'unavailable' })
    expect(JSON.stringify(logged.mock.calls)).not.toContain('345678')
  })

  it('withholds the whole answer when Fleet shows a last-4 reader an unmasked ВУ', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const search = createContactLicenceSearchCompositionV1({
      resolveReadAuthority: async () => allow('last4'),
      findDriverProfilesByExactLicence: async () => ({ contract: DRIVER_PROFILES_BY_EXACT_LICENCE_RESULT_V1, profiles: [row(), row({ driverId: 'd-2', licence: TYPED })], truncated: false }),
    })
    const result = await search(TYPED)
    expect(result).toEqual({ status: 'unavailable' })
  })
})
