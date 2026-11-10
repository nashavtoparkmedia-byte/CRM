/**
 * Isolated-PostgreSQL proof for ContactLookup.v1 as the Owner meets it in «Люди».
 *
 * The unit suite proves the criteria and the precedence; this proves that the
 * real adapter folds the STORED name the same way the query was folded, on a
 * real database whatever its ctype locale: «ё» equals «е» both ways, Russian
 * capitals equal small letters, typed words match in any order, a full ФИО finds
 * a card that has no patronymic (ranked last and marked), and a leading 8 finds a
 * +7 number. Archived contacts and inactive phones never match.
 *
 * It runs under the Contacts database gate (REQUIRE_CONTACT_RESOLUTION_DB_TESTS=1
 * with CONTACT_RESOLUTION_TEST_DATABASE_URL), only when DATABASE_URL is that
 * isolated database, and touches only rows it created. It never touches a
 * production database.
 */
import { randomUUID } from 'node:crypto'

import { PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { searchContactsV1 } from '../../application/contact-operations'

const TEST_DATABASE_URL = process.env.CONTACT_RESOLUTION_TEST_DATABASE_URL
if (process.env.REQUIRE_CONTACT_RESOLUTION_DB_TESTS === '1' && !TEST_DATABASE_URL) {
  throw new Error('CONTACT_RESOLUTION_TEST_DATABASE_URL is required for the ContactLookup PostgreSQL proof')
}
const isolated = Boolean(TEST_DATABASE_URL) && process.env.DATABASE_URL === TEST_DATABASE_URL
const proof = isolated ? describe : describe.skip
const db = isolated ? new PrismaClient() : null

const RUN = randomUUID().replace(/-/gu, '').slice(0, 12)
const id = (name: string) => `lookupproof-${RUN}-${name}`

const CONTACTS: Array<{ key: string; displayName: string; isArchived?: boolean; phones?: Array<{ phone: string; isActive?: boolean }> }> = [
  { key: 'ivanov', displayName: 'Иванов Пётр (демо)', phones: [{ phone: '+79991000101' }] },
  { key: 'ivanov-namesake', displayName: 'Иванов Алексей Сергеевич' },
  { key: 'gromov', displayName: 'Громов Сергей (демо)', phones: [{ phone: '79991000202' }] },
  { key: 'solovyov', displayName: 'СОЛОВЬЕВ ЕГОР' },
  { key: 'archived', displayName: 'Иванов Пётр', isArchived: true, phones: [{ phone: '+79991000303' }] },
  { key: 'old-phone', displayName: 'Орлов Денис', phones: [{ phone: '+79991000404', isActive: false }] },
]

/** Our own rows only, in the order Contacts returned them, as [key, match]. */
async function search(query: string): Promise<Array<[string, string | undefined]>> {
  const result = await searchContactsV1({ query, limit: 25 })
  const prefix = id('')
  return result.items
    .filter(item => item.contactId.startsWith(prefix))
    .map(item => [item.contactId.slice(prefix.length), item.match])
}

proof('ContactLookup.v1 on PostgreSQL', () => {
  beforeAll(async () => {
    for (const contact of CONTACTS) {
      await db!.contact.create({
        data: {
          id: id(contact.key),
          displayName: contact.displayName,
          isArchived: contact.isArchived ?? false,
          phones: { create: (contact.phones ?? []).map(phone => ({ phone: phone.phone, isActive: phone.isActive ?? true })) },
        },
      })
    }
  })

  afterAll(async () => {
    await db!.contact.deleteMany({ where: { id: { startsWith: id('') } } })
    await db!.$disconnect()
  })

  it('treats «ё» and «е» as one letter in both directions, and ignores case', async () => {
    expect(await search('Иванов Петр')).toEqual([['ivanov', 'name_prefix']])
    expect(await search('иванов пётр')).toEqual([['ivanov', 'name_prefix']])
    // Stored in capitals with «е»; typed with «ё»: the fold does not rely on the database locale.
    expect(await search('Соловьёв Егор')).toEqual([['solovyov', 'name_prefix']])
    expect(await search('соловьев')).toEqual([['solovyov', 'name_prefix']])
  })

  it('matches the typed words in any order, ranking a name that starts with the first word higher', async () => {
    expect(await search('Пётр Иванов')).toEqual([['ivanov', 'name_all_words']])
    expect(await search('Громов')).toEqual([['gromov', 'name_prefix']])
    // «Сергеевич» does not contain «сергей»: a word matches inside a name, never by stem.
    expect(await search('Сергей')).toEqual([['gromov', 'name_all_words']])
  })

  it('finds a card without a patronymic from a full ФИО, last and marked as not every word', async () => {
    expect(await search('Громов Сергей Петрович')).toEqual([['gromov', 'name_all_but_one_word']])
    expect(await search('Громов Сергей Петрович (демо)')).toEqual([['gromov', 'name_all_but_one_word']])
    // Both share two of the three words; both are only candidates, flagged, never «the» person.
    expect(await search('Иванов Пётр Сергеевич')).toEqual([
      ['ivanov-namesake', 'name_all_but_one_word'],
      ['ivanov', 'name_all_but_one_word'],
    ])
    expect(await search('Иванов Алексей Сергеевич')).toEqual([['ivanov-namesake', 'name_prefix']])
  })

  it('does not relax a one- or two-word name', async () => {
    expect(await search('Громов Петрович')).toEqual([])
    expect(await search('Петрович')).toEqual([])
  })

  it('reads a leading 8 as +7 and matches a stored number with or without «+»', async () => {
    for (const query of ['8 (999) 100-01-01', '89991000101', '8-999-100-01-01', '+7 999 100-01-01', '79991000101']) {
      expect(await search(query)).toEqual([['ivanov', 'phone_exact']])
    }
    expect(await search('8 999 100 02 02')).toEqual([['gromov', 'phone_exact']])
    expect(await search('+79991000202')).toEqual([['gromov', 'phone_exact']])
    expect(await search('999 100 01')).toEqual([['ivanov', 'phone_substring']])
    expect(await search('8 999 100')).toEqual([['gromov', 'phone_substring'], ['ivanov', 'phone_substring']])
  })

  it('never returns an archived contact or an inactive phone', async () => {
    expect((await search('Иванов')).map(([key]) => key)).not.toContain('archived')
    expect(await search('8 999 100 03 03')).toEqual([])
    expect(await search('8 999 100 04 04')).toEqual([])
    expect(await search('Орлов')).toEqual([['old-phone', 'name_prefix']])
  })
})
