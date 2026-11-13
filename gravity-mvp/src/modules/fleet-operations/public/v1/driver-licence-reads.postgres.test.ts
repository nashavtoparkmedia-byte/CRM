/**
 * Isolated-PostgreSQL proof of Fleet's licence-carrying reads (Owner D2):
 * the exact-licence search matches a stored ВУ however it was spaced or cased
 * (Cyrillic series letters included), never by prefix, reads the park name of
 * the Fleet-owned Park (or none), is bounded, and the answers carry the stored
 * ВУ only as the caller's view allows; DriverProfilesForContactsQuery.v2 adds
 * the masked ВУ to exactly v1's profiles.
 *
 * Gated behind YOKO_COMPENSATION_MONETARY_POSTGRES_PROOF=1 (the gate the Fleet
 * and Cash proofs share; the isolated runner switches it on) and an isolated
 * DATABASE_URL holding the canonical migration catalog.
 */
import { PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { DRIVER_PROFILES_BY_EXACT_LICENCE_QUERY_V1, DRIVER_PROFILES_FOR_CONTACTS_QUERY_V1 } from '../../../../contracts/fleet-operations/v1'
import { DRIVER_PROFILES_FOR_CONTACTS_QUERY_V2 } from '../../../../contracts/fleet-operations/v2'
import {
  findDriverProfilesByExactLicenceV1,
  readDriverProfilesForContactsV1,
  readDriverProfilesForContactsV2,
} from '../../application/fleet-operations'
import { DRIVER_LICENCE_MASK_V1 } from './driver-licence-mask'
import { legacyPrismaDriverLicencePortV1 as port } from './legacy-prisma-driver-licence-adapter'

const proof = process.env.YOKO_COMPENSATION_MONETARY_POSTGRES_PROOF === '1' ? describe : describe.skip
const tag = `lic${process.pid}${Date.now()}`
// One unconditional client: it connects only on the first query, so a skipped
// suite never opens a connection.
const database = new PrismaClient()

const ids = {
  park: `${tag}-park`,
  contact: `${tag}-contact`,
  spaced: `${tag}-d1`,
  plain: `${tag}-d2`,
  other: `${tag}-d3`,
  cyrillic: `${tag}-d4`,
  none: `${tag}-d5`,
  prefix: `${tag}-d6`,
}

proof('Fleet licence reads on PostgreSQL', () => {
  beforeAll(async () => {
    await database.park.create({ data: { id: ids.park, parkCode: `${tag}-code`, parkName: 'Парк Один', externalParkId: `${tag}-ext` } })
    await database.contact.create({ data: { id: ids.contact, displayName: 'Иванов Иван' } })
    // A static payload: every column is named, nothing is spread in.
    const driver = (id: string, fullName: string, licenseNumber: string | null, links: { parkId?: string; contactId?: string; externalParkId?: string } = {}) =>
      database.driver.create({
        data: {
          id,
          yandexDriverId: `yd-${id}`,
          fullName,
          licenseNumber,
          parkId: links.parkId ?? null,
          contactId: links.contactId ?? null,
          externalParkId: links.externalParkId ?? null,
        },
      })
    await driver(ids.spaced, 'Б Водитель', '99 12 345678', { parkId: ids.park, contactId: ids.contact, externalParkId: `${tag}-ext` })
    await driver(ids.plain, 'А Водитель', '9912345678', { contactId: ids.contact })
    await driver(ids.other, 'В Водитель', '99-12-345-679')
    await driver(ids.cyrillic, 'Г Водитель', '77 ав 123456')
    await driver(ids.none, 'Д Водитель', null, { contactId: ids.contact })
    await driver(ids.prefix, 'Е Водитель', '991234567')
  }, 60_000)

  afterAll(async () => {
    await database.driver.deleteMany({ where: { id: { startsWith: tag } } })
    await database.contact.deleteMany({ where: { id: ids.contact } })
    await database.park.deleteMany({ where: { id: ids.park } })
    await database.$disconnect()
  })

  it('matches the stored licence by letters and digits, upper case, exactly', async () => {
    const rows = await port.findProfilesByLicenceKey('9912345678', 21)
    expect(rows.map(row => row.id)).toEqual([ids.plain, ids.spaced])
    expect(rows.find(row => row.id === ids.spaced)?.parkName).toBe('Парк Один')
    expect(rows.find(row => row.id === ids.plain)?.parkName).toBeNull()
    expect((await port.findProfilesByLicenceKey('77АВ123456', 21)).map(row => row.id)).toEqual([ids.cyrillic])
    expect(await port.findProfilesByLicenceKey('991234', 21)).toEqual([])
    expect((await port.findProfilesByLicenceKey('991234567', 21)).map(row => row.id)).toEqual([ids.prefix])
    expect(await port.findProfilesByLicenceKey('9912345678', 1)).toHaveLength(1)
  })

  it('treats the typed key as a value, never as SQL', async () => {
    expect(await port.findProfilesByLicenceKey("9912345678' OR '1'='1", 21)).toEqual([])
    expect(await port.findProfilesByLicenceKey('%', 21)).toEqual([])
  })

  it('reads the stored licences of exactly the asked drivers', async () => {
    const stored = await port.findLicencesOfDrivers([ids.spaced, ids.none, `${tag}-missing`])
    expect(stored.get(ids.spaced)).toBe('99 12 345678')
    expect(stored.get(ids.none)).toBeNull()
    expect(stored.has(`${tag}-missing`)).toBe(false)
    expect(stored.has(ids.plain)).toBe(false)
  })

  it('answers the exact-licence search masked for last4, with no echo of the typed licence', async () => {
    const last4 = await findDriverProfilesByExactLicenceV1({ contract: DRIVER_PROFILES_BY_EXACT_LICENCE_QUERY_V1, licence: '99 12 34 56 78', licenceView: 'last4' })
    expect(last4.profiles.map(profile => [profile.driverId, profile.licence])).toEqual([
      [ids.plain, `${DRIVER_LICENCE_MASK_V1} 5678`],
      [ids.spaced, `${DRIVER_LICENCE_MASK_V1} 5678`],
    ])
    expect(JSON.stringify(last4)).not.toMatch(/345678|99 12|9912/u)
    const full = await findDriverProfilesByExactLicenceV1({ contract: DRIVER_PROFILES_BY_EXACT_LICENCE_QUERY_V1, licence: '9912345678', licenceView: 'full' })
    expect(full.profiles.map(profile => profile.licence)).toEqual(['9912345678', '99 12 345678'])
    expect(full.profiles.find(profile => profile.driverId === ids.spaced)?.linkedContactId).toBe(ids.contact)
  })

  it('adds the masked licence to exactly the v1 profiles', async () => {
    const subjects = [{ contactId: ids.contact, legacyYandexDriverId: null }]
    const v1 = await readDriverProfilesForContactsV1({ contract: DRIVER_PROFILES_FOR_CONTACTS_QUERY_V1, subjects })
    const last4 = await readDriverProfilesForContactsV2({ contract: DRIVER_PROFILES_FOR_CONTACTS_QUERY_V2, licenceView: 'last4', subjects })
    const full = await readDriverProfilesForContactsV2({ contract: DRIVER_PROFILES_FOR_CONTACTS_QUERY_V2, licenceView: 'full', subjects })
    expect(last4.entries[0].profiles.map(({ licence: _licence, ...rest }) => rest)).toEqual(v1.entries[0].profiles)
    const byId = (result: typeof last4) => Object.fromEntries(result.entries[0].profiles.map(profile => [profile.driverId, profile.licence]))
    expect(byId(last4)).toEqual({ [ids.spaced]: `${DRIVER_LICENCE_MASK_V1} 5678`, [ids.plain]: `${DRIVER_LICENCE_MASK_V1} 5678`, [ids.none]: null })
    expect(byId(full)).toEqual({ [ids.spaced]: '99 12 345678', [ids.plain]: '9912345678', [ids.none]: null })
    expect(JSON.stringify(last4)).not.toMatch(/345678/u)
  })
})
