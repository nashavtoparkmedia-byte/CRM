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
// A name class is one parameterized read of Contact only. The stored name gets
// the same fold the query words got (contactLookupFoldV1): lower case, then the
// Russian capitals and «ё» mapped explicitly, so the match does not depend on
// the database's ctype locale. Every word is a bound parameter compared with
// strpos, so no word can act as a LIKE wildcard.

import { Prisma } from '@prisma/client'

import { prisma } from '@/lib/prisma'

import type {
  ContactLookupCriteriaV1,
  ContactLookupPortV1,
  ContactLookupRankClassV1,
  ContactLookupSourceV1,
} from './contact-lookup'

const LIVE_CONTACT = { isArchived: false } as const

const RUSSIAN_CAPITALS = 'АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ'
/** translate() source and target: Russian capitals to small letters, «Ё»/«ё» to «е». */
const FOLD_FROM = `${RUSSIAN_CAPITALS}ё`
const FOLD_TO = `${RUSSIAN_CAPITALS.toLowerCase().replace(/ё/gu, 'е')}е`

type NameCriteria = Extract<ContactLookupCriteriaV1, { kind: 'text' }>
type NameRankClass = Extract<ContactLookupRankClassV1, `name_${string}`>

/** The WHERE predicate over the folded name `s.n` for one name rank class. */
function namePredicate(criteria: NameCriteria, rankClass: NameRankClass): Prisma.Sql {
  const words = criteria.words
  const hits = Prisma.join(
    words.map(word => Prisma.sql`(CASE WHEN strpos(s.n, ${word}) > 0 THEN 1 ELSE 0 END)`),
    ' + ',
  )
  if (rankClass === 'name_prefix') return Prisma.sql`strpos(s.n, ${words[0]}) = 1 AND (${hits}) = ${words.length}`
  if (rankClass === 'name_all_words') return Prisma.sql`(${hits}) = ${words.length}`
  return Prisma.sql`(${hits}) = ${words.length - 1}`
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
    if (criteria.words.length === 0) return []
    if (rankClass === 'name_all_but_one_word' && criteria.words.length < 3) return []
    const rows = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT s.id FROM (
        SELECT c."id" AS id, translate(lower(c."displayName"), ${FOLD_FROM}, ${FOLD_TO}) AS n
        FROM "Contact" c
        WHERE c."isArchived" = false
      ) s
      WHERE ${namePredicate(criteria, rankClass)}
      ORDER BY s.id ASC
      LIMIT ${limit}
    `)
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
