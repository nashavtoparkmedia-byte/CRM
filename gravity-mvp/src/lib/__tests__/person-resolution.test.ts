import { describe, expect, test } from 'vitest'
import {
  buildPersonAttachmentPlan,
  canSelectMainProfile,
  planManualAttachment,
  type PersonResolvedProfile,
} from '../driver-profiles/person-resolution'

function profile(overrides: Partial<PersonResolvedProfile> = {}): PersonResolvedProfile {
  return {
    id: 'profile-1',
    externalParkId: 'park-a',
    externalDriverProfileId: 'external-1',
    parkCode: 'YOKO',
    contactId: null,
    externalPersonKey: null,
    personKeyType: null,
    phone: '+79990000000',
    fullName: 'Driver One',
    status: 'working',
    ...overrides,
  }
}

describe('cross-park person resolution', () => {
  test('stable person key groups profiles across parks even with different phones and employment types', () => {
    const plan = buildPersonAttachmentPlan([
      profile({ id: 'a', parkCode: 'NASH_AVTOPARK', externalPersonKey: 'person-fp-1', contactId: 'contact-1', phone: '+70000000001' }),
      profile({ id: 'b', parkCode: 'YOKO_2', externalPersonKey: 'person-fp-1', phone: '+70000000002' }),
      profile({ id: 'c', parkCode: 'YOKO_DELIVERY', externalPersonKey: 'person-fp-1', phone: '+70000000003' }),
    ])
    expect(plan.groups).toHaveLength(1)
    expect(plan.groups[0]).toMatchObject({ status: 'proven', basis: 'STABLE_PROVIDER_PERSON_KEY', autoAttachContactId: 'contact-1' })
    expect(plan.autoAttachableProfileIds).toEqual(['b', 'c'])
  })

  test('same phone and same name without person key creates suggestions only, never auto attachment', () => {
    const plan = buildPersonAttachmentPlan([
      profile({ id: 'a', parkCode: 'YOKO', contactId: 'contact-1', fullName: 'Same Name' }),
      profile({ id: 'b', parkCode: 'YOKO_2', fullName: 'Same Name' }),
    ])
    expect(plan.groups).toHaveLength(1)
    expect(plan.groups[0].status).toBe('suggested')
    expect(plan.groups[0].basis).toBe('PHONE_ONLY_SUGGESTION')
    expect(plan.autoAttachableProfileIds).toEqual([])
    expect(plan.manualProfileIds).toEqual(['a', 'b'])
  })

  test('one stable person key linked to multiple Contacts is person ownership ambiguous', () => {
    const plan = buildPersonAttachmentPlan([
      profile({ id: 'a', externalPersonKey: 'person-fp-1', contactId: 'contact-1' }),
      profile({ id: 'b', externalPersonKey: 'person-fp-1', contactId: 'contact-2' }),
      profile({ id: 'c', externalPersonKey: 'person-fp-1', contactId: null }),
    ])
    expect(plan.groups[0].status).toBe('person_ownership_ambiguous')
    expect(plan.groups[0].basis).toBe('MULTIPLE_CONTACTS_FOR_PERSON_KEY')
    expect(plan.autoAttachableProfileIds).toEqual([])
    expect(plan.ambiguousProfileIds).toEqual(['a', 'b', 'c'])
  })

  test('existing proven manual link allows remaining stable-key profiles to attach to the same Contact', () => {
    const plan = buildPersonAttachmentPlan([
      profile({ id: 'a', externalPersonKey: 'person-fp-1', contactId: 'contact-1', manualProven: true }),
      profile({ id: 'b', externalPersonKey: 'person-fp-1', contactId: null }),
    ])
    expect(plan.groups[0]).toMatchObject({ status: 'proven', basis: 'PROVEN_MANUAL', autoAttachContactId: 'contact-1' })
    expect(plan.autoAttachableProfileIds).toEqual(['b'])
  })

  test('manual attachment blocks profiles already linked to another Contact', () => {
    const result = planManualAttachment({
      contactId: 'contact-1',
      selectedProfileIds: ['a'],
      profiles: [profile({ id: 'a', contactId: 'contact-2' })],
    })
    expect(result).toEqual({ ok: false, error: 'profile_belongs_to_other_contact', profileIds: ['a'] })
  })

  test('manual group attachment requires a proven group key', () => {
    const result = planManualAttachment({
      contactId: 'contact-1',
      selectedProfileIds: ['a', 'b'],
      attachWholeProvenGroup: true,
      profiles: [profile({ id: 'a' }), profile({ id: 'b', parkCode: 'YOKO_2' })],
    })
    expect(result).toEqual({ ok: false, error: 'group_not_proven', profileIds: ['a', 'b'] })
  })

  test('manual attachment can confirm a selected active profile', () => {
    const result = planManualAttachment({
      contactId: 'contact-1',
      selectedProfileIds: ['a'],
      profiles: [profile({ id: 'a' })],
    })
    expect(result).toEqual({ ok: true, profileIds: ['a'], basis: 'PROVEN_MANUAL', auditReason: 'operator confirmed DriverProfile belongs to Contact' })
  })

  test('main profile selection is allowed only after proven attachment', () => {
    expect(canSelectMainProfile(profile({ contactId: null, externalPersonKey: 'person-fp-1' }))).toBe(false)
    expect(canSelectMainProfile(profile({ contactId: 'contact-1', externalPersonKey: null }))).toBe(false)
    expect(canSelectMainProfile(profile({ contactId: 'contact-1', externalPersonKey: 'person-fp-1' }))).toBe(true)
    expect(canSelectMainProfile(profile({ contactId: 'contact-1', externalPersonKey: null, manualProven: true }))).toBe(true)
    expect(canSelectMainProfile(profile({ contactId: 'contact-1', externalPersonKey: 'person-fp-1', status: 'dismissed' }))).toBe(false)
  })
})
