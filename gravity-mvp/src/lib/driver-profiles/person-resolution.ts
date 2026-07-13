import { PARK_CODES, type ParkCode } from './park-identity'

export type PersonResolutionStatus =
  | 'proven'
  | 'verified_phone_owner'
  | 'suggested'
  | 'person_ownership_ambiguous'
  | 'unlinked'

export type PersonResolutionBasis =
  | 'STABLE_PROVIDER_PERSON_KEY'
  | 'PROVEN_MANUAL'
  | 'VERIFIED_PHONE_OWNER'
  | 'PHONE_ONLY_SUGGESTION'
  | 'NAME_PHONE_SUGGESTION'
  | 'NO_STABLE_PERSON_KEY'
  | 'MULTIPLE_CONTACTS_FOR_PERSON_KEY'

export type PersonResolvedProfile = {
  id: string
  externalParkId: string
  externalDriverProfileId: string
  parkCode: ParkCode
  contactId: string | null
  externalPersonKey: string | null
  personKeyType?: string | null
  phone: string | null
  fullName: string | null
  status: 'working' | 'dismissed' | 'unknown'
  manualProven?: boolean
}

export type PersonGroup = {
  groupKey: string
  groupType: 'stable_person_key' | 'suggested_phone' | 'unlinked'
  profiles: PersonResolvedProfile[]
  status: PersonResolutionStatus
  basis: PersonResolutionBasis
  contactIds: string[]
  autoAttachContactId: string | null
  suggestedContactIds: string[]
  reasons: string[]
}

export type AttachmentPlan = {
  groups: PersonGroup[]
  autoAttachableProfileIds: string[]
  manualProfileIds: string[]
  ambiguousProfileIds: string[]
  unlinkedProfileIds: string[]
}

function stableSortProfiles(a: PersonResolvedProfile, b: PersonResolvedProfile) {
  const park = PARK_CODES.indexOf(a.parkCode) - PARK_CODES.indexOf(b.parkCode)
  if (park !== 0) return park
  return a.externalDriverProfileId.localeCompare(b.externalDriverProfileId)
}

function uniqueSorted(values: Array<string | null | undefined>) {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value)))).sort()
}

export function buildPersonAttachmentPlan(profiles: PersonResolvedProfile[]): AttachmentPlan {
  const groups: PersonGroup[] = []
  const withStableKey = profiles.filter(profile => profile.externalPersonKey)
  const withoutStableKey = profiles.filter(profile => !profile.externalPersonKey)
  const byStableKey = new Map<string, PersonResolvedProfile[]>()

  for (const profile of withStableKey) {
    const key = profile.externalPersonKey as string
    byStableKey.set(key, [...(byStableKey.get(key) || []), profile])
  }

  for (const [key, groupProfiles] of byStableKey.entries()) {
    const sorted = [...groupProfiles].sort(stableSortProfiles)
    const contactIds = uniqueSorted(sorted.map(profile => profile.contactId))
    const manual = sorted.some(profile => profile.manualProven)
    if (contactIds.length === 1) {
      groups.push({
        groupKey: key,
        groupType: 'stable_person_key',
        profiles: sorted,
        status: 'proven',
        basis: manual ? 'PROVEN_MANUAL' : 'STABLE_PROVIDER_PERSON_KEY',
        contactIds,
        autoAttachContactId: contactIds[0],
        suggestedContactIds: [],
        reasons: ['stable person key and exactly one Contact in group'],
      })
    } else if (contactIds.length > 1) {
      groups.push({
        groupKey: key,
        groupType: 'stable_person_key',
        profiles: sorted,
        status: 'person_ownership_ambiguous',
        basis: 'MULTIPLE_CONTACTS_FOR_PERSON_KEY',
        contactIds,
        autoAttachContactId: null,
        suggestedContactIds: [],
        reasons: ['stable person key is linked to multiple Contacts'],
      })
    } else {
      groups.push({
        groupKey: key,
        groupType: 'stable_person_key',
        profiles: sorted,
        status: 'proven',
        basis: 'STABLE_PROVIDER_PERSON_KEY',
        contactIds: [],
        autoAttachContactId: null,
        suggestedContactIds: [],
        reasons: ['stable person key exists but no Contact is linked yet'],
      })
    }
  }

  const byPhone = new Map<string, PersonResolvedProfile[]>()
  for (const profile of withoutStableKey) {
    if (!profile.phone) {
      groups.push({
        groupKey: profile.id,
        groupType: 'unlinked',
        profiles: [profile],
        status: 'unlinked',
        basis: 'NO_STABLE_PERSON_KEY',
        contactIds: [],
        autoAttachContactId: null,
        suggestedContactIds: [],
        reasons: ['no stable person key and no phone candidate'],
      })
      continue
    }
    byPhone.set(profile.phone, [...(byPhone.get(profile.phone) || []), profile])
  }

  for (const [phone, groupProfiles] of byPhone.entries()) {
    const sorted = [...groupProfiles].sort(stableSortProfiles)
    const contactIds = uniqueSorted(sorted.map(profile => profile.contactId))
    groups.push({
      groupKey: phone,
      groupType: 'suggested_phone',
      profiles: sorted,
      status: 'suggested',
      basis: 'PHONE_ONLY_SUGGESTION',
      contactIds,
      autoAttachContactId: null,
      suggestedContactIds: contactIds,
      reasons: ['phone is not proof of cross-park person ownership'],
    })
  }

  const autoAttachableProfileIds: string[] = []
  const manualProfileIds: string[] = []
  const ambiguousProfileIds: string[] = []
  const unlinkedProfileIds: string[] = []

  for (const group of groups) {
    const ids = group.profiles.map(profile => profile.id)
    if (group.status === 'proven' && group.autoAttachContactId) {
      autoAttachableProfileIds.push(...group.profiles.filter(profile => profile.contactId !== group.autoAttachContactId).map(profile => profile.id))
    } else if (group.status === 'person_ownership_ambiguous') {
      ambiguousProfileIds.push(...ids)
    } else if (group.status === 'suggested') {
      manualProfileIds.push(...ids)
    } else if (group.status === 'unlinked') {
      unlinkedProfileIds.push(...ids)
    } else {
      manualProfileIds.push(...ids)
    }
  }

  return {
    groups: groups.sort((a, b) => a.groupKey.localeCompare(b.groupKey)),
    autoAttachableProfileIds: autoAttachableProfileIds.sort(),
    manualProfileIds: manualProfileIds.sort(),
    ambiguousProfileIds: ambiguousProfileIds.sort(),
    unlinkedProfileIds: unlinkedProfileIds.sort(),
  }
}

export type ManualAttachmentRequest = {
  contactId: string
  profiles: PersonResolvedProfile[]
  selectedProfileIds: string[]
  attachWholeProvenGroup?: boolean
}

export type ManualAttachmentDecision =
  | { ok: true; profileIds: string[]; basis: 'PROVEN_MANUAL'; auditReason: string }
  | { ok: false; error: 'profile_belongs_to_other_contact' | 'dismissed_profile_requires_review' | 'profile_not_found' | 'group_not_proven'; profileIds?: string[] }

export function planManualAttachment(request: ManualAttachmentRequest): ManualAttachmentDecision {
  const selected = request.profiles.filter(profile => request.selectedProfileIds.includes(profile.id))
  if (selected.length !== request.selectedProfileIds.length) return { ok: false, error: 'profile_not_found' }
  const conflicting = selected.filter(profile => profile.contactId && profile.contactId !== request.contactId)
  if (conflicting.length > 0) return { ok: false, error: 'profile_belongs_to_other_contact', profileIds: conflicting.map(profile => profile.id).sort() }
  const dismissed = selected.filter(profile => profile.status === 'dismissed')
  if (dismissed.length > 0 && !request.attachWholeProvenGroup) return { ok: false, error: 'dismissed_profile_requires_review', profileIds: dismissed.map(profile => profile.id).sort() }
  if (request.attachWholeProvenGroup) {
    const keys = uniqueSorted(selected.map(profile => profile.externalPersonKey))
    if (keys.length !== 1) return { ok: false, error: 'group_not_proven', profileIds: selected.map(profile => profile.id).sort() }
  }
  return { ok: true, profileIds: selected.map(profile => profile.id).sort(), basis: 'PROVEN_MANUAL', auditReason: 'operator confirmed DriverProfile belongs to Contact' }
}

export function canSelectMainProfile(profile: PersonResolvedProfile): boolean {
  return profile.status === 'working' && Boolean(profile.contactId) && (profile.externalPersonKey !== null || profile.manualProven === true)
}
