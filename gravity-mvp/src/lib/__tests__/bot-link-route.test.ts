import { beforeEach, describe, expect, it, vi } from 'vitest'

const txMock = vi.hoisted(() => ({
  driverTelegram: {
    deleteMany: vi.fn(),
    create: vi.fn(),
  },
}))

const prismaMock = vi.hoisted(() => ({
  driver: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
  },
  contact: {
    findUnique: vi.fn(),
  },
  driverTelegram: {
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    delete: vi.fn(),
  },
  $transaction: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }))

import { POST } from '@/app/api/bot-link/route'

function request(body: Record<string, unknown>) {
  return new Request('http://localhost/api/bot-link', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as never
}

describe('Telegram Bot binding API', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    prismaMock.$transaction.mockImplementation(async callback => callback(txMock))
  })

  it('rejects a DriverProfile that is not attached to the current Contact', async () => {
    prismaMock.driver.findUnique.mockResolvedValue({
      id: 'driver-other',
      fullName: 'Другой водитель',
      contactId: 'contact-other',
      yandexDriverId: 'yandex-other',
      parkId: 'park-other',
    })
    prismaMock.contact.findUnique.mockResolvedValue({
      id: 'contact-current',
      isArchived: false,
      mainDriverId: 'driver-current',
      yandexDriverId: 'yandex-current',
    })

    const response = await POST(request({
      action: 'link',
      telegramId: '100500',
      driverId: 'driver-other',
      contactId: 'contact-current',
    }))

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: 'PROFILE_NOT_ATTACHED' })
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
  })

  it('binds an attached DriverProfile together with its park', async () => {
    prismaMock.driver.findUnique.mockResolvedValue({
      id: 'driver-current',
      fullName: 'Текущий водитель',
      contactId: 'contact-current',
      yandexDriverId: 'yandex-current',
      parkId: 'park-yoko',
    })
    prismaMock.contact.findUnique.mockResolvedValue({
      id: 'contact-current',
      isArchived: false,
      mainDriverId: 'driver-current',
      yandexDriverId: 'yandex-current',
    })

    const response = await POST(request({
      action: 'link',
      telegramId: '100500',
      driverId: 'driver-current',
      contactId: 'contact-current',
    }))

    expect(response.status).toBe(200)
    expect(txMock.driverTelegram.create).toHaveBeenCalledWith({
      data: {
        telegramId: 100500n,
        driverId: 'driver-current',
        activeParkId: 'park-yoko',
      },
    })
  })

  it('rejects a Contact-scoped DriverProfile without a park', async () => {
    prismaMock.driver.findUnique.mockResolvedValue({
      id: 'driver-current',
      fullName: 'Current driver',
      contactId: 'contact-current',
      yandexDriverId: 'yandex-current',
      parkId: null,
    })
    prismaMock.contact.findUnique.mockResolvedValue({
      id: 'contact-current',
      isArchived: false,
      mainDriverId: 'driver-current',
      yandexDriverId: 'yandex-current',
    })

    const response = await POST(request({
      action: 'link',
      telegramId: '100500',
      driverId: 'driver-current',
      contactId: 'contact-current',
    }))

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: 'PROFILE_PARK_REQUIRED' })
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
  })

  it('does not unlink a binding owned by another Contact', async () => {
    prismaMock.driverTelegram.findUnique.mockResolvedValue({
      id: 'binding-1',
      driverId: 'driver-other',
      telegramId: 100500n,
    })
    prismaMock.driver.findUnique.mockResolvedValue({
      id: 'driver-other',
      contactId: 'contact-other',
      yandexDriverId: 'yandex-other',
    })
    prismaMock.contact.findUnique.mockResolvedValue({
      id: 'contact-current',
      isArchived: false,
      mainDriverId: 'driver-current',
      yandexDriverId: 'yandex-current',
    })

    const response = await POST(request({
      action: 'unlink',
      telegramId: '100500',
      contactId: 'contact-current',
    }))

    expect(response.status).toBe(409)
    expect(prismaMock.driverTelegram.delete).not.toHaveBeenCalled()
  })
})
