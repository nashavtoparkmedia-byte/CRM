import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest'

import { prisma } from '@/lib/prisma'

const refreshMainMock = vi.hoisted(() => vi.fn(async () => null))
const attachProfilesMock = vi.hoisted(() => vi.fn(async () => ({
  action: 'no_drivers',
  contactId: null,
  driverIds: [],
})))

vi.mock('@/lib/driver-profiles/multi-park', () => ({
  refreshContactMainDriver: refreshMainMock,
  attachDriverProfilesToContactByPhone: attachProfilesMock,
}))

import { syncContactForDriver } from '@/app/api/monitoring/sync/route'

const dbDescribe = process.env.DRIVER_FIRST_CONTACT_DB_TEST === '1'
  ? describe
  : describe.skip

async function createPhoneOwner(displayName: string, phone: string) {
  const contact = await prisma.contact.create({
    data: { displayName, displayNameSource: 'manual' },
  })
  const contactPhone = await prisma.contactPhone.create({
    data: {
      contactId: contact.id,
      phone,
      source: 'manual',
      isPrimary: true,
    },
  })
  await prisma.contact.update({
    where: { id: contact.id },
    data: { primaryPhoneId: contactPhone.id },
  })
  return contact
}

async function createDriver(
  yandexDriverId: string,
  fullName: string,
  phone: string,
) {
  return prisma.driver.create({
    data: { yandexDriverId, fullName, phone },
  })
}

dbDescribe('driver-first Contact creation against isolated PostgreSQL', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ContactDriverProfileAudit", "ContactPhone", "Driver", "Park", "ContactMerge", "Contact" CASCADE',
    )
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  test('concurrent and repeated sync create one Contact and one active phone owner', async () => {
    await createDriver('driver-first-1', 'Driver First', '+79990000001')

    const firstPair = await Promise.all([
      syncContactForDriver('driver-first-1', 'Driver First', '+7 999 000-00-01'),
      syncContactForDriver('driver-first-1', 'Driver First', '8 (999) 000-00-01'),
    ])
    const repeated = await syncContactForDriver(
      'driver-first-1',
      'Driver First',
      '79990000001',
    )

    expect(firstPair.map(result => result.action).sort()).toEqual(['created', 'noop'])
    expect(repeated.action).toBe('noop')
    expect(await prisma.contact.count({
      where: { yandexDriverId: 'driver-first-1', isArchived: false },
    })).toBe(1)

    const contact = await prisma.contact.findUniqueOrThrow({
      where: { yandexDriverId: 'driver-first-1' },
      include: { phones: true },
    })
    expect(contact.phones).toHaveLength(1)
    expect(contact.phones[0]).toMatchObject({
      phone: '+79990000001',
      isActive: true,
      source: 'yandex',
    })
  })

  test('ambiguous phone ownership remains unresolved and creates no Driver Contact', async () => {
    await createDriver(
      'driver-first-ambiguous',
      'Wrong Driver',
      '+79990000002',
    )
    await createPhoneOwner('Owner A', '+79990000002')
    await createPhoneOwner('Owner B', '+79990000002')

    const result = await syncContactForDriver(
      'driver-first-ambiguous',
      'Wrong Driver',
      '+7 999 000-00-02',
    )

    expect(result.action).toBe('ambiguous')
    expect(await prisma.contact.count()).toBe(2)
    expect(await prisma.contact.count({
      where: { yandexDriverId: 'driver-first-ambiguous' },
    })).toBe(0)
  })

  test('an existing Driver Contact never takes a phone owned by another Contact', async () => {
    await createDriver(
      'driver-first-conflict',
      'Driver Contact',
      '+79990000003',
    )
    const driverContact = await prisma.contact.create({
      data: {
        displayName: 'Driver Contact',
        displayNameSource: 'yandex',
        masterSource: 'yandex',
        yandexDriverId: 'driver-first-conflict',
      },
    })
    const otherOwner = await createPhoneOwner('Other owner', '+79990000003')

    const result = await syncContactForDriver(
      'driver-first-conflict',
      'Driver Contact',
      '+7 999 000-00-03',
    )

    expect(result.action).toBe('ambiguous_phone_owner')
    expect(await prisma.contactPhone.count({
      where: { contactId: driverContact.id },
    })).toBe(0)
    expect(await prisma.contactPhone.count({
      where: { contactId: otherOwner.id, phone: '+79990000003' },
    })).toBe(1)
  })
})
