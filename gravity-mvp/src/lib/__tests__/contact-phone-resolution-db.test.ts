import { afterAll, beforeEach, describe, expect, test } from 'vitest'

import { confirmContactPhone, preflightContactPhone } from '../contacts/contact-phone-resolution'
import { PARK_PRIORITY } from '../driver-profiles/multi-park'
import { prisma } from '../prisma'

const dbDescribe = process.env.CONTACT_PHONE_DB_TEST === '1' ? describe : describe.skip

dbDescribe('ContactPhone resolution against isolated PostgreSQL', () => {
  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ContactDriverProfileAudit", "ContactPhone", "Driver", "Park", "ContactMerge", "Contact" CASCADE',
    )
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  test('two concurrent FREE confirmations create exactly one active owner', async () => {
    const [first, second] = await Promise.all([
      prisma.contact.create({ data: { displayName: 'Первый' } }),
      prisma.contact.create({ data: { displayName: 'Второй' } }),
    ])
    const phone = '+79990000001'
    const [firstPreflight, secondPreflight] = await Promise.all([
      preflightContactPhone({ contactId: first.id, rawPhone: phone, operator: 'db-test' }),
      preflightContactPhone({ contactId: second.id, rawPhone: phone, operator: 'db-test' }),
    ])
    expect(firstPreflight.ownershipStatus).toBe('FREE')
    expect(secondPreflight.ownershipStatus).toBe('FREE')

    const results = await Promise.all([
      confirmContactPhone({ contactId: first.id, confirmationToken: firstPreflight.confirmationToken, operator: 'db-test' }),
      confirmContactPhone({ contactId: second.id, confirmationToken: secondPreflight.confirmationToken, operator: 'db-test' }),
    ])

    expect(results.filter(result => result.ok)).toHaveLength(1)
    expect(results.filter(result => !result.ok)).toHaveLength(1)
    expect(await prisma.contactPhone.count({ where: { phone, isActive: true } })).toBe(1)
  })

  test('OTHER_CONTACT and AMBIGUOUS preflights perform zero target writes', async () => {
    const [target, firstOwner, secondOwner] = await Promise.all([
      prisma.contact.create({ data: { displayName: 'Текущий' } }),
      prisma.contact.create({ data: { displayName: 'Владелец 1' } }),
      prisma.contact.create({ data: { displayName: 'Владелец 2' } }),
    ])
    const otherPhone = '+79990000002'
    await prisma.contactPhone.create({ data: { contactId: firstOwner.id, phone: otherPhone, isPrimary: true } })
    const other = await preflightContactPhone({ contactId: target.id, rawPhone: otherPhone, operator: 'db-test' })
    expect(other.ownershipStatus).toBe('OTHER_CONTACT')
    expect(await prisma.contactPhone.count({ where: { contactId: target.id } })).toBe(0)

    const ambiguousPhone = '+79990000003'
    await prisma.contactPhone.createMany({
      data: [
        { contactId: firstOwner.id, phone: ambiguousPhone },
        { contactId: secondOwner.id, phone: ambiguousPhone },
      ],
    })
    const ambiguous = await preflightContactPhone({ contactId: target.id, rawPhone: ambiguousPhone, operator: 'db-test' })
    expect(ambiguous).toMatchObject({ ownershipStatus: 'AMBIGUOUS', resolutionStatus: 'PHONE_OWNERSHIP_AMBIGUOUS' })
    expect(await prisma.contactPhone.count({ where: { contactId: target.id } })).toBe(0)
  })

  test('FREE flow returns suggestions from all six parks without attaching or choosing main', async () => {
    const target = await prisma.contact.create({ data: { displayName: 'Telegram-only' } })
    const phone = '+79990000004'
    for (const [index, parkName] of PARK_PRIORITY.entries()) {
      const park = await prisma.park.create({
        data: { parkCode: `PARK_${index}`, parkName, externalParkId: `external-park-${index}` },
      })
      await prisma.driver.create({
        data: {
          yandexDriverId: `driver-${index}`,
          externalDriverProfileId: `profile-${index}`,
          externalParkId: park.externalParkId,
          fullName: `Водитель ${index}`,
          phone,
          lastExternalPark: parkName,
          parkId: park.id,
        },
      })
    }

    const preflight = await preflightContactPhone({ contactId: target.id, rawPhone: phone, operator: 'db-test' })
    expect(preflight.ownershipStatus).toBe('FREE')
    expect(preflight.searchedParks).toEqual(PARK_PRIORITY)
    expect(preflight.driverProfileSuggestions).toHaveLength(6)

    const result = await confirmContactPhone({
      contactId: target.id,
      confirmationToken: preflight.confirmationToken,
      operator: 'db-test',
    })
    expect(result.ok).toBe(true)
    expect(result.driverProfileSuggestions).toHaveLength(6)
    expect(await prisma.driver.count({ where: { contactId: target.id } })).toBe(0)
    expect(await prisma.contact.findUnique({ where: { id: target.id }, select: { mainDriverId: true } }))
      .toEqual({ mainDriverId: null })
  })
})
