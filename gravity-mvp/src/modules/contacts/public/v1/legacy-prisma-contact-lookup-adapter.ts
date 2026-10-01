// The only database reader behind ContactLookup.v1.
//
// It touches Contacts-owned models only — Contact, ContactPhone and
// ContactIdentity — and never Chat, Message, Driver, Task, Call or any provider
// table, so a lookup result cannot acquire foreign-domain state through its
// persistence port. It selects no `externalId` at all: the provider target is not
// merely dropped later, it is never read.
//
// Candidate search is one bounded query per rank class, because the handler needs
// precedence to hold before truncation. Hydration is one bounded query for the
// selected ids, so the projection is never N+1.

import { prisma } from '@/lib/prisma'

import type {
  ContactLookupPortV1,
  ContactLookupSourceV1,
} from './contact-lookup'

const LIVE_CONTACT = { isArchived: false } as const

export const legacyPrismaContactLookupPortV1: ContactLookupPortV1 = {
  async findContactLookupCandidateIds(criteria, rankClass, limit): Promise<string[]> {
    if (criteria.kind === 'phone') {
      const phones = await prisma.contactPhone.findMany({
        where: {
          isActive: true,
          contact: LIVE_CONTACT,
          phone: rankClass === 'phone_exact'
            ? criteria.digits
            : { contains: criteria.digits },
        },
        select: { contactId: true },
        orderBy: [{ contactId: 'asc' }],
        take: limit,
      })
      return phones.map(phone => phone.contactId)
    }

    const contacts = await prisma.contact.findMany({
      where: {
        ...LIVE_CONTACT,
        displayName: rankClass === 'name_prefix'
          ? { startsWith: criteria.text, mode: 'insensitive' }
          : { contains: criteria.text, mode: 'insensitive' },
      },
      select: { id: true },
      orderBy: [{ id: 'asc' }],
      take: limit,
    })
    return contacts.map(contact => contact.id)
  },

  async findContactLookupSources(contactIds): Promise<ContactLookupSourceV1[]> {
    if (contactIds.length === 0) return []
    const contacts = await prisma.contact.findMany({
      where: { id: { in: [...contactIds] }, ...LIVE_CONTACT },
      select: {
        id: true,
        displayName: true,
        displayNameSource: true,
        primaryPhoneId: true,
        customFields: true,
        phones: {
          select: { id: true, phone: true, isPrimary: true, isActive: true, verifiedAt: true },
          orderBy: { createdAt: 'asc' },
        },
        // No externalId, no reachabilityStatus, no metadata: a lookup row states
        // that an active channel identity exists and nothing more.
        identities: {
          select: { channel: true, isActive: true, displayName: true },
          orderBy: { createdAt: 'asc' },
        },
      },
    })
    return contacts.map(contact => ({
      id: contact.id,
      displayName: contact.displayName,
      displayNameSource: contact.displayNameSource === null ? null : String(contact.displayNameSource),
      primaryPhoneId: contact.primaryPhoneId,
      customFields: contact.customFields,
      phones: contact.phones.map(phone => ({
        id: phone.id,
        phone: phone.phone,
        isPrimary: phone.isPrimary,
        isActive: phone.isActive,
        verifiedAt: phone.verifiedAt,
      })),
      identities: contact.identities.map(identity => ({
        channel: String(identity.channel),
        isActive: identity.isActive,
        displayName: identity.displayName,
      })),
    }))
  },
}
