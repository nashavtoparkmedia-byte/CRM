import { afterAll, beforeEach, describe, expect, test } from 'vitest'
import { NextRequest } from 'next/server'

import { GET } from '@/app/api/contacts/search/route'
import { prisma } from '@/lib/prisma'

const dbDescribe = process.env.TELEGRAM_SEARCH_DB_TEST === '1' ? describe : describe.skip

async function search(query: string) {
  const response = await GET(new NextRequest(`http://localhost/api/contacts/search?q=${encodeURIComponent(query)}`))
  expect(response.status).toBe(200)
  return response.json() as Promise<{ contacts: Array<{ id: string }>; total: number }>
}

dbDescribe('Telegram identity search against isolated PostgreSQL', () => {
  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ContactIdentity", "ContactPhone", "ContactMerge", "Contact" CASCADE',
    )
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  test('finds current username and stable telegramUserId without creating a duplicate Contact', async () => {
    const contact = await prisma.contact.create({ data: { displayName: 'Telegram Driver' } })
    await prisma.contactIdentity.create({
      data: {
        contactId: contact.id,
        channel: 'telegram',
        externalId: '100500',
        metadata: {
          telegramUserId: '100500',
          username: 'new_name',
          lastObservedUsername: 'new_name',
          usernameHistory: [
            { username: 'old_name', lastObservedAt: '2026-07-17T10:00:00.000Z' },
          ],
        },
      },
    })

    await expect(search('@new_name')).resolves.toMatchObject({
      contacts: [expect.objectContaining({ id: contact.id })],
    })
    await expect(search('100500')).resolves.toMatchObject({
      contacts: [expect.objectContaining({ id: contact.id })],
    })
    expect(await prisma.contact.count()).toBe(1)
    expect(await prisma.contactIdentity.count({
      where: { channel: 'telegram', externalId: '100500' },
    })).toBe(1)
  })

  test('ranks a current username above the same historical username', async () => {
    const [historical, current] = await Promise.all([
      prisma.contact.create({ data: { displayName: 'Historical holder' } }),
      prisma.contact.create({ data: { displayName: 'Current holder' } }),
    ])
    await prisma.contactIdentity.create({
      data: {
        contactId: historical.id,
        channel: 'telegram',
        externalId: '100501',
        metadata: {
          telegramUserId: '100501',
          username: 'new_holder',
          usernameHistory: [
            { username: 'shared_name', lastObservedAt: '2026-07-17T10:00:00.000Z' },
          ],
        },
      },
    })
    await prisma.contactIdentity.create({
      data: {
        contactId: current.id,
        channel: 'telegram',
        externalId: '100502',
        metadata: {
          telegramUserId: '100502',
          username: 'shared_name',
          lastObservedUsername: 'shared_name',
        },
      },
    })

    const result = await search('shared_name')
    expect(result.contacts.map(contact => contact.id)).toEqual([current.id, historical.id])
  })
})
