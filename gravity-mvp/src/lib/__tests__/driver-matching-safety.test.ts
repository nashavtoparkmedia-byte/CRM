import { beforeEach, describe, expect, test, vi } from 'vitest'
import { readFileSync } from 'fs'
import path from 'path'

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    $queryRaw: vi.fn(),
    driver: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
      updateMany: vi.fn(),
    },
    chat: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    contactPhone: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    contact: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    contactDriverProfileAudit: {
      create: vi.fn(),
    },
  },
}))

vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }))

import { DriverMatchService } from '../DriverMatchService'
import { linkContactToBestDriver } from '../contacts/yandex-link'
import { syncContactForDriver } from '../../app/api/monitoring/sync/route'

const ACTIVE_OLD = new Date('2026-01-01T00:00:00.000Z')
const ACTIVE_NEW = new Date('2026-02-01T00:00:00.000Z')

function driver(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    yandexDriverId: `yd-${id}`,
    fullName: `Driver ${id}`,
    phone: '+79990000000',
    dismissedAt: null,
    lastOrderAt: ACTIVE_OLD,
    ...overrides,
  }
}

function contactPhoneRecord(
  contactId: string,
  contactOverrides: Record<string, unknown> = {},
  phoneOverrides: Record<string, unknown> = {},
) {
  return {
    id: `phone-${contactId}`,
    contactId,
    phone: '+79990000000',
    isActive: true,
    contact: {
      id: contactId,
      yandexDriverId: null,
      displayNameSource: 'channel',
      isArchived: false,
      ...contactOverrides,
    },
    ...phoneOverrides,
  }
}

function readProjectFile(relativePath: string) {
  return readFileSync(path.join(process.cwd(), relativePath), 'utf8')
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('DriverMatchService safety matching', () => {
  test('one driver by confirmed phone returns matched and linkChatToDriver writes Chat.driverId', async () => {
    prismaMock.$queryRaw
      .mockResolvedValueOnce([driver('d1')])
      .mockResolvedValueOnce([driver('d1')])
    prismaMock.chat.findUnique.mockResolvedValueOnce({ driverId: null })
    prismaMock.chat.update.mockResolvedValueOnce({})

    const result = await DriverMatchService.matchDriver({ phone: '+7 999 000-00-00' })
    const linked = await DriverMatchService.linkChatToDriver('chat-1', { phone: '+7 999 000-00-00' })

    expect(result.status).toBe('matched')
    if (result.status === 'matched') expect(result.driver.id).toBe('d1')
    expect(linked).toBe(true)
    expect(prismaMock.chat.update).toHaveBeenCalledWith({
      where: { id: 'chat-1' },
      data: { driverId: 'd1' },
    })
  })

  test('matched phone does not overwrite existing different Chat.driverId', async () => {
    prismaMock.$queryRaw.mockResolvedValueOnce([driver('d1')])
    prismaMock.chat.findUnique.mockResolvedValueOnce({ driverId: 'existing-driver' })

    const linked = await DriverMatchService.linkChatToDriver('chat-1', { phone: '+7 999 000-00-00' })

    expect(linked).toBe(false)
    expect(prismaMock.chat.update).not.toHaveBeenCalled()
  })

  test('zero drivers by phone returns not_found and does not write Chat.driverId', async () => {
    prismaMock.$queryRaw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])

    const result = await DriverMatchService.matchDriver({ phone: '+7 999 000-00-00' })
    const linked = await DriverMatchService.linkChatToDriver('chat-1', { phone: '+7 999 000-00-00' })

    expect(result).toEqual({ status: 'not_found', candidates: [] })
    expect(linked).toBe(false)
    expect(prismaMock.chat.update).not.toHaveBeenCalled()
  })

  test('two drivers with same phone return ambiguous and lastOrderAt does not choose automatically', async () => {
    prismaMock.$queryRaw.mockResolvedValueOnce([
      driver('older', { lastOrderAt: ACTIVE_OLD }),
      driver('newer', { lastOrderAt: ACTIVE_NEW }),
    ])

    const result = await DriverMatchService.matchDriver({ phone: '+7 999 000-00-00' })

    expect(result.status).toBe('ambiguous')
    if (result.status === 'ambiguous') {
      expect(result.candidates.map(c => c.id).sort()).toEqual(['newer', 'older'])
    }
    expect(prismaMock.chat.update).not.toHaveBeenCalled()
  })

  test('one name candidate without phone never auto-links', async () => {
    prismaMock.driver.findMany
      .mockResolvedValueOnce([driver('name-only')])
      .mockResolvedValueOnce([driver('name-only')])

    const result = await DriverMatchService.matchDriver({ name: 'Роман' })
    const linked = await DriverMatchService.linkChatToDriver('chat-1', { name: 'Роман' })

    expect(result).toEqual({ status: 'not_found', candidates: [] })
    expect(linked).toBe(false)
    expect(prismaMock.chat.update).not.toHaveBeenCalled()
  })

  test('multiple name candidates never auto-link', async () => {
    prismaMock.driver.findMany.mockResolvedValueOnce([driver('a'), driver('b')])

    const result = await DriverMatchService.matchDriver({ name: 'Юрий' })

    expect(result).toEqual({ status: 'not_found', candidates: [] })
    expect(prismaMock.chat.update).not.toHaveBeenCalled()
  })

  test('ambiguous phone match does not write Chat.driverId', async () => {
    prismaMock.$queryRaw.mockResolvedValueOnce([driver('a'), driver('b')])

    const linked = await DriverMatchService.linkChatToDriver('chat-ambiguous', { phone: '+7 999 000-00-00' })

    expect(linked).toBe(false)
    expect(prismaMock.chat.update).not.toHaveBeenCalled()
  })
})

describe('Yandex contact-driver enrichment safety', () => {
  test('one driver with confirmed phone links Contact to that Driver', async () => {
    prismaMock.driver.findMany.mockResolvedValueOnce([driver('d1')])
    prismaMock.contactPhone.findMany.mockResolvedValueOnce([
      contactPhoneRecord('contact-1'),
    ])
    prismaMock.contact.update.mockResolvedValueOnce({})

    const result = await linkContactToBestDriver('+7 999 000-00-00')

    expect(result.action).toBe('linked')
    expect(prismaMock.contact.update).toHaveBeenCalledWith({
      where: { id: 'contact-1' },
      data: {
        yandexDriverId: 'yd-d1',
        masterSource: 'yandex',
        displayName: 'Driver d1',
        displayNameSource: 'yandex',
      },
    })
  })

  test('zero drivers does not remove an existing valid Contact.yandexDriverId', async () => {
    prismaMock.driver.findMany.mockResolvedValueOnce([])

    const result = await linkContactToBestDriver('+7 999 000-00-00')

    expect(result.action).toBe('no_driver')
    expect(prismaMock.contact.update).not.toHaveBeenCalled()
  })

  test('ambiguous drivers do not write Contact.yandexDriverId', async () => {
    prismaMock.driver.findMany.mockResolvedValueOnce([driver('a'), driver('b', { lastOrderAt: ACTIVE_NEW })])
    prismaMock.contactPhone.findMany.mockResolvedValueOnce([
      contactPhoneRecord('contact-1'),
    ])

    const result = await linkContactToBestDriver('+7 999 000-00-00')

    expect(result.action).toBe('ambiguous')
    expect(prismaMock.contact.update).not.toHaveBeenCalled()
  })

  test('ambiguous enrichment is idempotent for repeated runs', async () => {
    prismaMock.driver.findMany
      .mockResolvedValueOnce([driver('a'), driver('b')])
      .mockResolvedValueOnce([driver('a'), driver('b')])
    prismaMock.contactPhone.findMany
      .mockResolvedValueOnce([contactPhoneRecord('contact-1')])
      .mockResolvedValueOnce([contactPhoneRecord('contact-1')])

    const first = await linkContactToBestDriver('+7 999 000-00-00')
    const second = await linkContactToBestDriver('+7 999 000-00-00')

    expect(first.action).toBe('ambiguous')
    expect(second.action).toBe('ambiguous')
    expect(prismaMock.contact.update).not.toHaveBeenCalled()
  })

  test('single phone match does not overwrite existing different Contact.yandexDriverId', async () => {
    prismaMock.driver.findMany.mockResolvedValueOnce([driver('d1', { yandexDriverId: 'yd-new' })])
    prismaMock.contactPhone.findMany.mockResolvedValueOnce([
      contactPhoneRecord('contact-1', { yandexDriverId: 'yd-existing' }),
    ])

    const result = await linkContactToBestDriver('+7 999 000-00-00')

    expect(result.action).toBe('noop')
    expect(prismaMock.contact.update).not.toHaveBeenCalled()
  })


  test('zero ContactPhone owners does not choose a Contact by phone', async () => {
    prismaMock.driver.findMany.mockResolvedValueOnce([driver('d1')])
    prismaMock.contactPhone.findMany.mockResolvedValueOnce([])

    const result = await linkContactToBestDriver('+7 999 000-00-00')

    expect(result.action).toBe('no_contact')
    expect(prismaMock.contact.update).not.toHaveBeenCalled()
  })

  test('two ContactPhone owners make yandex-link ambiguous and do not write Contact.yandexDriverId', async () => {
    prismaMock.driver.findMany.mockResolvedValueOnce([driver('d1')])
    prismaMock.contactPhone.findMany.mockResolvedValueOnce([
      contactPhoneRecord('contact-a'),
      contactPhoneRecord('contact-b'),
    ])

    const result = await linkContactToBestDriver('+7 999 000-00-00')

    expect(result.action).toBe('ambiguous')
    expect(result.contactCandidates?.map(candidate => candidate.contactId).sort()).toEqual(['contact-a', 'contact-b'])
    expect(prismaMock.contact.update).not.toHaveBeenCalled()
  })

  test('active and archived ContactPhone owners are still ambiguous in yandex-link', async () => {
    prismaMock.driver.findMany.mockResolvedValueOnce([driver('d1')])
    prismaMock.contactPhone.findMany.mockResolvedValueOnce([
      contactPhoneRecord('active-contact', { isArchived: false }),
      contactPhoneRecord('archived-contact', { isArchived: true }),
    ])

    const result = await linkContactToBestDriver('+7 999 000-00-00')

    expect(result.action).toBe('ambiguous')
    expect(prismaMock.contact.update).not.toHaveBeenCalled()
  })

  test('Contact activity freshness does not pick one ContactPhone owner in yandex-link', async () => {
    prismaMock.driver.findMany.mockResolvedValueOnce([driver('d1')])
    prismaMock.contactPhone.findMany.mockResolvedValueOnce([
      contactPhoneRecord('older-contact', {}, { lastActivityAt: ACTIVE_OLD }),
      contactPhoneRecord('newer-contact', {}, { lastActivityAt: ACTIVE_NEW }),
    ])

    const result = await linkContactToBestDriver('+7 999 000-00-00')

    expect(result.action).toBe('ambiguous')
    expect(prismaMock.contact.update).not.toHaveBeenCalled()
  })
})

describe('Yandex monitoring sync Contact creation idempotency', () => {
  test('first sync without matching ContactPhone creates at most one Contact', async () => {
    prismaMock.contact.findUnique.mockResolvedValueOnce(null)
    prismaMock.contactPhone.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
    prismaMock.contact.create.mockResolvedValueOnce({ id: 'contact-1', primaryPhoneId: null })
    prismaMock.contactPhone.create.mockResolvedValueOnce({ id: 'phone-1' })
    prismaMock.contact.update.mockResolvedValueOnce({})

    const result = await syncContactForDriver('yd-1', 'Driver One', '+7 999 000-00-00')

    expect(result.action).toBe('created')
    expect(prismaMock.contact.create).toHaveBeenCalledTimes(1)
    expect(prismaMock.contact.create).toHaveBeenCalledWith({
      data: {
        displayName: 'Driver One',
        displayNameSource: 'yandex',
        masterSource: 'yandex',
        yandexDriverId: 'yd-1',
      },
    })
  })

  test('repeated sync for same Driver reuses Contact.yandexDriverId and does not create duplicate Contact', async () => {
    prismaMock.contact.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 'contact-1',
        displayName: 'Driver One',
        displayNameSource: 'yandex',
        primaryPhoneId: 'phone-1',
        phones: [{ id: 'phone-1', phone: '+79990000000' }],
      })
    prismaMock.contactPhone.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([contactPhoneRecord('contact-1')])
    prismaMock.contact.create.mockResolvedValueOnce({ id: 'contact-1', primaryPhoneId: null })
    prismaMock.contactPhone.create.mockResolvedValueOnce({ id: 'phone-1' })
    prismaMock.contact.update.mockResolvedValueOnce({})

    const first = await syncContactForDriver('yd-1', 'Driver One', '+7 999 000-00-00')
    const second = await syncContactForDriver('yd-1', 'Driver One', '+7 999 000-00-00')

    expect(first.action).toBe('created')
    expect(second.action).toBe('noop')
    expect(prismaMock.contact.create).toHaveBeenCalledTimes(1)
  })

  test('Contact with yandexDriverId but without ContactPhone is reused and gets phone', async () => {
    prismaMock.contact.findUnique.mockResolvedValueOnce({
      id: 'contact-1',
      displayName: 'Driver One',
      displayNameSource: 'yandex',
      primaryPhoneId: null,
      phones: [],
    })
    prismaMock.contactPhone.findMany.mockResolvedValueOnce([])
    prismaMock.contactPhone.create.mockResolvedValueOnce({ id: 'phone-1' })
    prismaMock.contact.update.mockResolvedValueOnce({})

    const result = await syncContactForDriver('yd-1', 'Driver One', '+7 999 000-00-00')

    expect(result.action).toBe('updated')
    expect(prismaMock.contact.create).not.toHaveBeenCalled()
    expect(prismaMock.contactPhone.create).toHaveBeenCalledWith({
      data: {
        contactId: 'contact-1',
        phone: '+79990000000',
        source: 'yandex',
        isPrimary: true,
      },
    })
  })

  test('concurrent Contact create race reuses unique yandexDriverId winner', async () => {
    prismaMock.contact.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'contact-1', primaryPhoneId: null })
    prismaMock.contactPhone.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
    prismaMock.contact.create.mockRejectedValueOnce({ code: 'P2002' })
    prismaMock.contactPhone.create.mockResolvedValueOnce({ id: 'phone-1' })
    prismaMock.contact.update.mockResolvedValueOnce({})

    const result = await syncContactForDriver('yd-1', 'Driver One', '+7 999 000-00-00')

    expect(result.action).toBe('created')
    expect(prismaMock.contact.create).toHaveBeenCalledTimes(1)
    expect(prismaMock.contactPhone.create).toHaveBeenCalledTimes(1)
  })

  test('ambiguous ContactPhone records do not link or create a wrong relation', async () => {
    prismaMock.contact.findUnique.mockResolvedValueOnce(null)
    prismaMock.contactPhone.findMany.mockResolvedValueOnce([
      { contactId: 'contact-a', contact: { id: 'contact-a', yandexDriverId: null } },
      { contactId: 'contact-b', contact: { id: 'contact-b', yandexDriverId: null } },
    ])

    const result = await syncContactForDriver('yd-1', 'Driver One', '+7 999 000-00-00')

    expect(result.action).toBe('ambiguous')
    expect(prismaMock.contact.update).not.toHaveBeenCalled()
    expect(prismaMock.contact.create).not.toHaveBeenCalled()
  })

  test('existing conflicting Contact.yandexDriverId is not overwritten by monitoring sync', async () => {
    prismaMock.contact.findUnique.mockResolvedValueOnce(null)
    prismaMock.contactPhone.findMany.mockResolvedValueOnce([
      { contactId: 'contact-1', contact: { id: 'contact-1', yandexDriverId: 'yd-other' } },
    ])

    const result = await syncContactForDriver('yd-1', 'Driver One', '+7 999 000-00-00')

    expect(result.action).toBe('noop')
    expect(prismaMock.contact.update).not.toHaveBeenCalled()
    expect(prismaMock.contact.create).not.toHaveBeenCalled()
  })


  test('existing yandex Contact adds phone only when no other Contact owns it', async () => {
    prismaMock.contact.findUnique.mockResolvedValueOnce({
      id: 'contact-1',
      displayName: 'Driver One',
      displayNameSource: 'yandex',
      primaryPhoneId: null,
      phones: [],
    })
    prismaMock.contactPhone.findMany.mockResolvedValueOnce([])
    prismaMock.contactPhone.create.mockResolvedValueOnce({ id: 'phone-1' })
    prismaMock.contact.update.mockResolvedValueOnce({})

    const result = await syncContactForDriver('yd-1', 'Driver One', '+7 999 000-00-00')

    expect(result.action).toBe('updated')
    expect(result.phonesCreated).toBe(1)
    expect(prismaMock.contactPhone.create).toHaveBeenCalledTimes(1)
  })

  test('repeated sync for existing yandex Contact does not create duplicate ContactPhone', async () => {
    prismaMock.contact.findUnique.mockResolvedValueOnce({
      id: 'contact-1',
      displayName: 'Driver One',
      displayNameSource: 'yandex',
      primaryPhoneId: 'phone-contact-1',
      phones: [{ id: 'phone-contact-1', phone: '+79990000000' }],
    })
    prismaMock.contactPhone.findMany.mockResolvedValueOnce([contactPhoneRecord('contact-1')])

    const result = await syncContactForDriver('yd-1', 'Driver One', '+7 999 000-00-00')

    expect(result.action).toBe('noop')
    expect(prismaMock.contactPhone.create).not.toHaveBeenCalled()
  })

  test('existing yandex Contact does not add phone owned by another Contact', async () => {
    prismaMock.contact.findUnique.mockResolvedValueOnce({
      id: 'contact-1',
      displayName: 'Driver One',
      displayNameSource: 'yandex',
      primaryPhoneId: null,
      phones: [],
    })
    prismaMock.contactPhone.findMany.mockResolvedValueOnce([
      contactPhoneRecord('contact-other', { yandexDriverId: 'yd-other' }),
    ])

    const result = await syncContactForDriver('yd-1', 'Driver One', '+7 999 000-00-00')

    expect(result.action).toBe('ambiguous_phone_owner')
    expect(prismaMock.contactPhone.create).not.toHaveBeenCalled()
    expect(prismaMock.contact.update).not.toHaveBeenCalled()
  })

  test('existing yandex Contact does not choose between two other phone owners', async () => {
    prismaMock.contact.findUnique.mockResolvedValueOnce({
      id: 'contact-1',
      displayName: 'Driver One',
      displayNameSource: 'yandex',
      primaryPhoneId: null,
      phones: [],
    })
    prismaMock.contactPhone.findMany.mockResolvedValueOnce([
      contactPhoneRecord('contact-a'),
      contactPhoneRecord('contact-b'),
    ])

    const result = await syncContactForDriver('yd-1', 'Driver One', '+7 999 000-00-00')

    expect(result.action).toBe('ambiguous_phone_owner')
    expect(prismaMock.contactPhone.create).not.toHaveBeenCalled()
    expect(prismaMock.contact.update).not.toHaveBeenCalled()
  })

  test('P2002 phone attach race reuses only the same Contact owner', async () => {
    prismaMock.contact.findUnique.mockResolvedValueOnce({
      id: 'contact-1',
      displayName: 'Driver One',
      displayNameSource: 'yandex',
      primaryPhoneId: null,
      phones: [],
    })
    prismaMock.contactPhone.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([contactPhoneRecord('contact-1')])
    prismaMock.contactPhone.create.mockRejectedValueOnce({ code: 'P2002' })
    prismaMock.contact.update.mockResolvedValueOnce({})

    const result = await syncContactForDriver('yd-1', 'Driver One', '+7 999 000-00-00')

    expect(result.action).toBe('updated')
    expect(result.phonesCreated).toBe(0)
    expect(prismaMock.contact.update).toHaveBeenCalledWith({
      where: { id: 'contact-1' },
      data: { primaryPhoneId: 'phone-contact-1' },
    })
  })

  test('P2002 phone attach race does not treat another Contact owner as success', async () => {
    prismaMock.contact.findUnique.mockResolvedValueOnce({
      id: 'contact-1',
      displayName: 'Driver One',
      displayNameSource: 'yandex',
      primaryPhoneId: null,
      phones: [],
    })
    prismaMock.contactPhone.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([contactPhoneRecord('contact-other')])
    prismaMock.contactPhone.create.mockRejectedValueOnce({ code: 'P2002' })

    const result = await syncContactForDriver('yd-1', 'Driver One', '+7 999 000-00-00')

    expect(result.action).toBe('ambiguous_phone_owner')
    expect(prismaMock.contact.update).not.toHaveBeenCalled()
  })
})

describe('Driver matching source-level route safety', () => {
  test('monitoring sync does not pick first ContactPhone or overwrite existing Contact.yandexDriverId by phone', () => {
    const source = readProjectFile('src/app/api/monitoring/sync/route.ts')
    const scenario2 = source.split('// ── Scenario 2:')[1].split('// ── Scenario 3:')[0]

    expect(scenario2).toContain('contactPhone.findMany')
    expect(scenario2).not.toContain('contactPhone.findFirst')
    expect(scenario2).toContain('phoneRecords.length > 1')
    expect(scenario2).toContain("event: 'monitoring_sync_contact_phone_ambiguous'")
    expect(scenario2).toContain('phoneRecords.length === 1')
    expect(scenario2).toContain("event: 'monitoring_sync_contact_driver_existing_link_conflict'")

    const conflictSection = scenario2.split("event: 'monitoring_sync_contact_driver_existing_link_conflict'")[1]
    expect(conflictSection.split('if (phoneRecords.length === 1 && !phoneRecords[0].contact.yandexDriverId)')[0])
      .not.toContain('prisma.contact.update')
  })

  test('legacy MAX webhook blocks name and active-chat driver fallback', () => {
    const source = readProjectFile('src/app/api/webhook/max/route.ts')
    const noPhoneSection = source.split('if (phoneDigits.length < 10)')[1].split('// Use MAX internal chatId')[0]

    expect(source).toContain('Deprecated route /api/webhook/max')
    expect(noPhoneSection).toContain("event: 'legacy_max_name_phone_resolution_blocked'")
    expect(noPhoneSection).not.toContain('DriverMatchService.findDriverId')
    expect(noPhoneSection).not.toContain('recentDriverChats')
    expect(noPhoneSection).not.toContain('matchedActiveChat')
    expect(noPhoneSection).not.toContain('existingChatByName')
    expect(noPhoneSection).not.toContain('phoneDigits = matched')
  })

  test('legacy MAX old-chat migration does not choose first Driver by phone', () => {
    const source = readProjectFile('src/app/api/webhook/max/route.ts')
    const migrationSection = source.split('// Migration pass 2:')[1].split('// 1. Upsert unified Chat')[0]

    expect(migrationSection).toContain('findMany')
    expect(migrationSection).not.toContain('driver.findFirst')
    expect(migrationSection).toContain('driverCandidates.length === 1')
    expect(migrationSection).toContain("event: 'legacy_max_old_chat_migration_ambiguous_driver_phone'")
  })
})
