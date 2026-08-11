import { ContactService } from '@/lib/ContactService'
import type { ChatChannel } from '@prisma/client'

export type AddPhoneToContactOptionsV1 = {
  isTemporary?: boolean
  expiresAt?: Date | null
  source?: 'manual' | 'avito' | 'whatsapp' | 'telegram' | 'phone' | 'yandex'
  label?: string | null
  makePrimary?: boolean
  deactivateTemporaries?: boolean
}

export type AddPhoneToContactResultV1 =
  | { kind: 'added'; phoneId: string; contactId: string }
  | { kind: 'exists_same_contact'; phoneId: string; contactId: string }
  | { kind: 'conflict'; otherContactId: string; otherContactName: string }

/** Resolve any persisted conversation channel through Contacts-owned identity policy. */
export function resolveChannelContactOperationV1(
  channel: ChatChannel,
  externalId: string,
  phone: string | null | undefined,
  displayName?: string | null,
) {
  return ContactService.resolveContact(channel, externalId, phone, displayName)
}

/** Resolve a call participant through the Contacts-owned canonical phone policy. */
export function resolveContactByPhoneV1(phone: string, displayName?: string | null) {
  return ContactService.resolveByPhone(phone, displayName)
}

/** Attach one canonical phone while preserving conflict and temporary-phone policy. */
export function addPhoneToContactV1(
  contactId: string,
  phone: string,
  options?: AddPhoneToContactOptionsV1,
): Promise<AddPhoneToContactResultV1> {
  return ContactService.addPhoneToContact(contactId, phone, options)
}

/** Owner-scoped maintenance after provider conversation deletion. */
export function cleanupDanglingContactIdentitiesV1(contactIds: string[]): Promise<number> {
  return ContactService.cleanupDanglingIdentities(contactIds)
}
