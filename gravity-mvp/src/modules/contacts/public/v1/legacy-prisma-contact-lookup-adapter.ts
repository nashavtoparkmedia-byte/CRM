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
//
// A name class is one static, parameterized read of Contact only. The stored name
// gets the same fold the query words got (contactLookupFoldV1): lower case, then
// «ё» as «е». lower() folds Cyrillic under the UTF-8 locale every CRM database
// image runs (en_US.utf8), the same assumption the earlier case-insensitive search
// made; the PostgreSQL proof keeps a capitals-only name to catch a regression.
// The SQL text is fixed: up to CONTACT_LOOKUP_MAX_WORDS_V1 words are bound into
// fixed slots (unused slots are NULL and never match), and every word is compared
// with strpos, so no word can act as a LIKE wildcard.

import { prisma } from '@/lib/prisma'

import {
  CONTACT_LOOKUP_MAX_WORDS_V1,
  type ContactLookupPortV1,
  type ContactLookupSourceV1,
} from './contact-lookup'

const LIVE_CONTACT = { isArchived: false } as const

/** The words in the fixed slots of the name query; unused slots are NULL. */
function wordSlots(words: readonly string[]): Array<string | null> {
  return Array.from({ length: CONTACT_LOOKUP_MAX_WORDS_V1 }, (_unused, index) => words[index] ?? null)
}

export const legacyPrismaContactLookupPortV1: ContactLookupPortV1 = {
  async findContactLookupCandidateIds(criteria, rankClass, limit): Promise<string[]> {
    if (criteria.kind === 'phone') {
      if (rankClass !== 'phone_exact' && rankClass !== 'phone_substring') return []
      const readings = criteria.digitReadings
      const phones = await prisma.contactPhone.findMany({
        where: {
          isActive: true,
          contact: LIVE_CONTACT,
          ...(rankClass === 'phone_exact'
            ? { phone: { in: readings.flatMap(reading => [reading, `+${reading}`]) } }
            : { OR: readings.map(reading => ({ phone: { contains: reading } })) }),
        },
        select: { contactId: true },
        orderBy: [{ contactId: 'asc' }],
        take: limit,
      })
      return phones.map(phone => phone.contactId)
    }

    if (rankClass !== 'name_prefix' && rankClass !== 'name_all_words' && rankClass !== 'name_all_but_one_word') return []
    const words = criteria.words.slice(0, CONTACT_LOOKUP_MAX_WORDS_V1)
    if (words.length === 0) return []
    if (rankClass === 'name_all_but_one_word' && words.length < 3) return []
    // name_prefix and name_all_words need every word; the last class all but one.
    const requiredHits = rankClass === 'name_all_but_one_word' ? words.length - 1 : words.length
    const prefixWord = rankClass === 'name_prefix' ? words[0] : null
    const [w1, w2, w3, w4, w5, w6] = wordSlots(words)
    const rows = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT s.id FROM (
        SELECT c."id" AS id, replace(lower(c."displayName"), 'ё', 'е') AS n
        FROM "Contact" c
        WHERE c."isArchived" = false
      ) s
      WHERE (
        (CASE WHEN strpos(s.n, ${w1}::text) > 0 THEN 1 ELSE 0 END)
        + (CASE WHEN strpos(s.n, ${w2}::text) > 0 THEN 1 ELSE 0 END)
        + (CASE WHEN strpos(s.n, ${w3}::text) > 0 THEN 1 ELSE 0 END)
        + (CASE WHEN strpos(s.n, ${w4}::text) > 0 THEN 1 ELSE 0 END)
        + (CASE WHEN strpos(s.n, ${w5}::text) > 0 THEN 1 ELSE 0 END)
        + (CASE WHEN strpos(s.n, ${w6}::text) > 0 THEN 1 ELSE 0 END)
      ) = ${requiredHits}::int
        AND (${prefixWord}::text IS NULL OR strpos(s.n, ${prefixWord}::text) = 1)
      ORDER BY s.id ASC
      LIMIT ${limit}::int
    `
    return rows.map(row => row.id)
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
