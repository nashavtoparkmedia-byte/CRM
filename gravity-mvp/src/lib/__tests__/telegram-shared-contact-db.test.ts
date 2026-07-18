import { afterAll, beforeEach, describe, expect, test } from 'vitest'

import { applyTelegramSharedContactPhone } from '@/lib/telegram-shared-contact'
import { prisma } from '@/lib/prisma'

const dbDescribe = process.env.TELEGRAM_SHARED_CONTACT_DB_TEST === '1' ? describe : describe.skip

dbDescribe('Telegram shared contact against isolated PostgreSQL', () => {
  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ContactDriverProfileAudit", "ContactIdentity", "ContactPhone", "ContactMerge", "Contact" CASCADE',
    )
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  test('adds a FREE own phone once and binds it to the stable Telegram identity', async () => {
    const contact = await prisma.contact.create({ data: { displayName: 'Telegram Driver' } })
    const identity = await prisma.contactIdentity.create({
      data: {
        contactId: contact.id,
        channel: 'telegram',
        externalId: '100500',
        metadata: { telegramUserId: '100500', username: 'driver' },
      },
    })
    const input = {
      contactId: contact.id,
      identityId: identity.id,
      senderTelegramUserId: '100500',
      sharedContactUserId: '100500',
      phoneNumber: '+79990000000',
      providerMessageId: '77',
      observedAt: new Date('2026-07-18T10:00:00.000Z'),
      transport: 'bot_webhook' as const,
    }

    await expect(applyTelegramSharedContactPhone(input)).resolves.toMatchObject({
      trustResult: 'trusted_own_contact',
      resolutionResult: 'phone_added',
      contactId: contact.id,
      ownerContactIds: [contact.id],
    })
    await expect(applyTelegramSharedContactPhone(input)).resolves.toMatchObject({
      resolutionResult: 'same_contact',
      contactId: contact.id,
    })

    const [phones, refreshedIdentity, refreshedContact] = await Promise.all([
      prisma.contactPhone.findMany({ where: { contactId: contact.id } }),
      prisma.contactIdentity.findUniqueOrThrow({ where: { id: identity.id } }),
      prisma.contact.findUniqueOrThrow({ where: { id: contact.id } }),
    ])
    expect(phones).toHaveLength(1)
    expect(phones[0]).toMatchObject({
      phone: '+79990000000',
      source: 'telegram',
      isPrimary: true,
    })
    expect(phones[0].verifiedAt?.toISOString()).toBe('2026-07-18T10:00:00.000Z')
    expect(refreshedIdentity.phoneId).toBe(phones[0].id)
    expect(refreshedContact.primaryPhoneId).toBe(phones[0].id)
    expect(refreshedIdentity.metadata).toMatchObject({
      phoneEvidence: {
        trustResult: 'trusted_own_contact',
        resolutionResult: 'same_contact',
      },
      phoneEvidenceHistory: [expect.objectContaining({ eventKey: expect.any(String) })],
    })
  })

  test('does not move a phone owned by another or ambiguous Contact', async () => {
    const [source, firstOwner, secondOwner] = await Promise.all([
      prisma.contact.create({ data: { displayName: 'Source' } }),
      prisma.contact.create({ data: { displayName: 'Owner A' } }),
      prisma.contact.create({ data: { displayName: 'Owner B' } }),
    ])
    const identity = await prisma.contactIdentity.create({
      data: { contactId: source.id, channel: 'telegram', externalId: '100501' },
    })
    await prisma.contactPhone.create({
      data: { contactId: firstOwner.id, phone: '+79990000001', source: 'manual' },
    })
    await prisma.contactPhone.createMany({
      data: [
        { contactId: firstOwner.id, phone: '+79990000002', source: 'manual' },
        { contactId: secondOwner.id, phone: '+79990000002', source: 'manual' },
      ],
    })

    await expect(applyTelegramSharedContactPhone({
      contactId: source.id,
      identityId: identity.id,
      senderTelegramUserId: '100501',
      sharedContactUserId: '100501',
      phoneNumber: '+79990000001',
      providerMessageId: '78',
      transport: 'gramjs',
    })).resolves.toMatchObject({
      resolutionResult: 'other_contact',
      ownerContactIds: [firstOwner.id],
      phoneId: null,
    })
    await expect(applyTelegramSharedContactPhone({
      contactId: source.id,
      identityId: identity.id,
      senderTelegramUserId: '100501',
      sharedContactUserId: '100501',
      phoneNumber: '+79990000002',
      providerMessageId: '79',
      transport: 'gramjs',
    })).resolves.toMatchObject({
      resolutionResult: 'ambiguous',
      ownerContactIds: expect.arrayContaining([firstOwner.id, secondOwner.id]),
      phoneId: null,
    })
    expect(await prisma.contactPhone.count({ where: { contactId: source.id } })).toBe(0)
  })

  test('records a foreign contact without attaching its phone', async () => {
    const contact = await prisma.contact.create({ data: { displayName: 'Sender' } })
    const identity = await prisma.contactIdentity.create({
      data: { contactId: contact.id, channel: 'telegram', externalId: '100502' },
    })

    await expect(applyTelegramSharedContactPhone({
      contactId: contact.id,
      identityId: identity.id,
      senderTelegramUserId: '100502',
      sharedContactUserId: '900000',
      phoneNumber: '+79990000003',
      providerMessageId: '80',
      transport: 'bot_webhook',
    })).resolves.toMatchObject({
      trustResult: 'foreign_contact',
      resolutionResult: 'ignored',
      phoneId: null,
    })
    expect(await prisma.contactPhone.count({ where: { contactId: contact.id } })).toBe(0)
  })
})
