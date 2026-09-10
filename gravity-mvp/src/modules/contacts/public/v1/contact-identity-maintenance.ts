import {
  ContactService,
  type FleetContactOwnershipReconciliationResult,
  type ResolveContactPolicy,
} from '@/lib/ContactService'
import {
  isSafeContactResolutionSuccess,
  type SafeContactResolutionResult,
  type SafeContactResolutionSuccess,
} from '@/lib/contacts/SafeContactResolutionExecutor'
import type { ChatChannel } from '@prisma/client'

export type AddPhoneToContactOptionsV1 = {
  isTemporary?: boolean
  expiresAt?: Date | null
  source?: 'manual' | 'avito' | 'whatsapp' | 'telegram' | 'max' | 'phone' | 'yandex'
  label?: string | null
  makePrimary?: boolean
  deactivateTemporaries?: boolean
}

export type AddPhoneToContactResultV1 =
  | { kind: 'added'; phoneId: string; contactId: string }
  | { kind: 'exists_same_contact'; phoneId: string; contactId: string }
  | { kind: 'conflict'; otherContactId: string; otherContactName: string }

export type AttachPhoneToIdentityResultV1 =
  | { kind: 'added' | 'exists_same_contact'; phoneId: string; contactId: string }
  | { kind: 'conflict'; otherContactId: string; otherContactName: string }

export const CONTACT_OWNERSHIP_BUSY_CODE_V1 = 'CONTACT_OWNERSHIP_BUSY' as const

export type ContactOwnershipBusyResultV1 = {
  error: typeof CONTACT_OWNERSHIP_BUSY_CODE_V1
  message: 'Contact is being updated. Retry shortly.'
  retryable: true
}

/** Public, provider-neutral projection of the internal coordinator timeout. */
export function contactOwnershipBusyResultV1(error: unknown): ContactOwnershipBusyResultV1 | null {
  const candidate = error as { code?: unknown } | null
  if (candidate?.code !== CONTACT_OWNERSHIP_BUSY_CODE_V1) return null
  return {
    error: CONTACT_OWNERSHIP_BUSY_CODE_V1,
    message: 'Contact is being updated. Retry shortly.',
    retryable: true,
  }
}

/** Resolve any persisted conversation channel through Contacts-owned identity policy. */
export function resolveChannelContactOperationV1(
  channel: ChatChannel,
  externalId: string,
  phone: string | null | undefined,
  displayName?: string | null,
  policy?: ResolveContactPolicy,
): Promise<SafeContactResolutionResult> {
  return policy
    ? ContactService.resolveContact(channel, externalId, phone, displayName, policy)
    : ContactService.resolveContact(channel, externalId, phone, displayName)
}

/** Resolve a call participant through the Contacts-owned canonical phone policy. */
export function resolveContactByPhoneV1(phone: string, displayName?: string | null) {
  return ContactService.resolveByPhone(phone, displayName)
}

export type ResolveChannelContactResultV1 = SafeContactResolutionResult
export type ResolveChannelContactSuccessV1 = SafeContactResolutionSuccess
export type ResolveChannelContactPolicyV1 = ResolveContactPolicy

export function isResolvedChannelContactResultV1(
  result: ResolveChannelContactResultV1,
): result is ResolveChannelContactSuccessV1 {
  return isSafeContactResolutionSuccess(result)
}

/** Attach one canonical phone while preserving conflict and temporary-phone policy. */
export function addPhoneToContactV1(
  contactId: string,
  phone: string,
  options?: AddPhoneToContactOptionsV1,
): Promise<AddPhoneToContactResultV1> {
  return ContactService.addPhoneToContact(contactId, phone, options)
}

/** Attach one canonical phone to one exact identity with conflict preservation. */
export function attachPhoneToIdentityV1(
  contactId: string,
  identityId: string,
  phone: string,
  options?: {
    source?: 'manual' | 'avito' | 'whatsapp' | 'telegram' | 'max' | 'phone' | 'yandex'
    confirmed?: boolean
  },
): Promise<AttachPhoneToIdentityResultV1> {
  return ContactService.attachPhoneToIdentity(contactId, identityId, phone, options)
}

/** Owner-scoped maintenance after provider conversation deletion. */
export function cleanupDanglingContactIdentitiesV1(contactIds: string[]): Promise<number> {
  return ContactService.cleanupDanglingIdentities(contactIds)
}

/** Fleet supplies an already-fetched provider record; Contacts owns all DB decisions/mutations. */
export function reconcileFleetContactOwnershipV1(input: {
  yandexDriverId: string
  fullName: string
  phone: string | null
}): Promise<FleetContactOwnershipReconciliationResult> {
  return ContactService.reconcileFleetContactOwnership(input)
}

export function expireTemporaryContactPhonesV1(before?: Date, limit?: number): Promise<number> {
  return ContactService.expireTemporaryContactPhones(before, limit)
}
