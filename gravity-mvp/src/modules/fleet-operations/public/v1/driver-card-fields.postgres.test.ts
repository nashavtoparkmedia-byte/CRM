/**
 * Isolated-PostgreSQL proof of DriverProfilesForContactsQuery.v3's extra
 * profile fields: the card-fields reader reads exactly the asked Fleet-owned
 * Driver rows, and v3 answers v2's profiles unchanged plus each profile's own
 * phone and its employment narrowed to the contract's codes.
 *
 * Gated behind YOKO_COMPENSATION_MONETARY_POSTGRES_PROOF=1 (the gate the Fleet
 * and Cash proofs share; the isolated runner switches it on) and an isolated
 * DATABASE_URL holding the canonical migration catalog.
 */
import { PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { DRIVER_PROFILES_FOR_CONTACTS_QUERY_V2 } from '../../../../contracts/fleet-operations/v2'
import { DRIVER_PROFILES_FOR_CONTACTS_QUERY_V3 } from '../../../../contracts/fleet-operations/v3'
import { readDriverProfilesForContactsV2, readDriverProfilesForContactsV3 } from '../../application/fleet-operations'
import { legacyPrismaDriverCardFieldsPortV1 as port } from './legacy-prisma-driver-card-fields-adapter'

const proof = process.env.YOKO_COMPENSATION_MONETARY_POSTGRES_PROOF === '1' ? describe : describe.skip
const tag = `card${process.pid}${Date.now()}`
// One unconditional client: it connects only on the first query, so a skipped
// suite never opens a connection.
const database = new PrismaClient()

const ids = {
  contact: `${tag}-contact`,
  employee: `${tag}-d1`,
  selfEmployed: `${tag}-d2`,
  other: `${tag}-d3`,
  empty: `${tag}-d4`,
}

proof('Fleet card fields on PostgreSQL', () => {
  beforeAll(async () => {
    await database.contact.create({ data: { id: ids.contact, displayName: 'Иванов Иван' } })
    // Static payloads: every column is named, nothing is spread in.
    await database.driver.create({ data: { id: ids.employee, yandexDriverId: `yd-${ids.employee}`, fullName: 'А Водитель', contactId: ids.contact, phone: '+79991234567', isSelfEmployed: false, employmentType: 'park_employee' } })
    await database.driver.create({ data: { id: ids.selfEmployed, yandexDriverId: `yd-${ids.selfEmployed}`, fullName: 'Б Водитель', contactId: ids.contact, phone: '+998901234567', isSelfEmployed: true, employmentType: 'selfemployed' } })
    await database.driver.create({ data: { id: ids.other, yandexDriverId: `yd-${ids.other}`, fullName: 'В Водитель', contactId: ids.contact, phone: null, isSelfEmployed: null, employmentType: 'work_rule_7f3a' } })
    await database.driver.create({ data: { id: ids.empty, yandexDriverId: `yd-${ids.empty}`, fullName: 'Г Водитель', contactId: null, phone: '+79990000000', isSelfEmployed: null, employmentType: null } })
  }, 60_000)

  afterAll(async () => {
    await database.driver.deleteMany({ where: { id: { startsWith: tag } } })
    await database.contact.deleteMany({ where: { id: ids.contact } })
    await database.$disconnect()
  })

  it('reads the card fields of exactly the asked drivers', async () => {
    const stored = await port.findCardFieldsOfDrivers([ids.employee, ids.other, `${tag}-missing`])
    expect(stored.get(ids.employee)).toEqual({ phone: '+79991234567', isSelfEmployed: false, employmentType: 'park_employee' })
    expect(stored.get(ids.other)).toEqual({ phone: null, isSelfEmployed: null, employmentType: 'work_rule_7f3a' })
    expect(stored.has(`${tag}-missing`)).toBe(false)
    expect(stored.has(ids.selfEmployed)).toBe(false)
    expect(await port.findCardFieldsOfDrivers([])).toEqual(new Map())
  })

  it('answers v2\'s profiles unchanged plus the phone and the narrowed employment', async () => {
    const subjects = [{ contactId: ids.contact, legacyYandexDriverId: null }]
    const v2 = await readDriverProfilesForContactsV2({ contract: DRIVER_PROFILES_FOR_CONTACTS_QUERY_V2, licenceView: 'last4', subjects })
    const v3 = await readDriverProfilesForContactsV3({ contract: DRIVER_PROFILES_FOR_CONTACTS_QUERY_V3, licenceView: 'last4', subjects })
    expect(v3.entries[0].profiles.map(({ phone: _p, isSelfEmployed: _s, employmentType: _e, ...rest }) => rest)).toEqual(v2.entries[0].profiles)
    const byId = Object.fromEntries(v3.entries[0].profiles.map(p => [p.driverId, [p.phone, p.isSelfEmployed, p.employmentType]]))
    expect(byId).toEqual({
      [ids.employee]: ['+79991234567', false, 'park_employee'],
      [ids.selfEmployed]: ['+998901234567', true, 'selfemployed'],
      [ids.other]: [null, null, 'unknown'],
    })
    expect(JSON.stringify(v3)).not.toContain('work_rule_7f3a')
  })
})
