import { afterAll, beforeEach, describe, expect, test } from 'vitest'

import { ContactMergeService, MergeError, type ContactMergePreview } from '../ContactMergeService'
import { prisma } from '../prisma'

const dbDescribe = process.env.CONTACT_MERGE_DB_TEST === '1' ? describe : describe.skip

function executeInput(preview: ContactMergePreview, actorId = preview.actor.id) {
  return {
    sourceId: preview.source.id,
    targetId: preview.target.id,
    actorId,
    planHash: preview.planHash,
    sourceVersion: preview.sourceVersion,
    targetVersion: preview.targetVersion,
    confirmationToken: preview.confirmationToken,
  }
}

dbDescribe('Contact merge full graph against isolated PostgreSQL', () => {
  beforeEach(async () => {
    process.env.CONTACT_MERGE_TOKEN_SECRET = 'contact-merge-db-test-secret'
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "DriverTelegram", "MessageAttachment", "Message", "Chat", "Call", "tasks", "ContactDriverProfileAudit", "ContactIdentity", "ContactPhone", "Driver", "Park", "ContactMerge", "Contact" CASCADE',
    )
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  test('preview and execute preserve the complete Contact graph and emit rollback manifest', async () => {
    const [source, target] = await Promise.all([
      prisma.contact.create({
        data: {
          displayName: 'Источник',
          tags: ['source'],
          notes: 'source note',
          customFields: { sourceField: 'source' },
        },
      }),
      prisma.contact.create({
        data: {
          displayName: 'Цель',
          tags: ['target'],
          notes: 'target note',
          customFields: { targetField: 'target' },
        },
      }),
    ])
    const targetPhone = await prisma.contactPhone.create({
      data: { contactId: target.id, phone: '+79990000100', isPrimary: true, source: 'manual' },
    })
    await prisma.contact.update({
      where: { id: target.id },
      data: { primaryPhoneId: targetPhone.id },
    })
    const sourceDuplicatePhone = await prisma.contactPhone.create({
      data: { contactId: source.id, phone: '+79990000100', verifiedAt: new Date(), source: 'telegram' },
    })
    const sourcePhone = await prisma.contactPhone.create({
      data: { contactId: source.id, phone: '+79990000101', isPrimary: true, source: 'manual' },
    })
    await prisma.contact.update({
      where: { id: source.id },
      data: { primaryPhoneId: sourcePhone.id },
    })
    const identity = await prisma.contactIdentity.create({
      data: {
        contactId: source.id,
        channel: 'max',
        externalId: 'max-source-1',
        phoneId: sourceDuplicatePhone.id,
        metadata: { username: 'source-max' },
      },
    })
    const chat = await prisma.chat.create({
      data: {
        contactId: source.id,
        contactIdentityId: identity.id,
        channel: 'max',
        externalChatId: 'max-chat-source-1',
      },
    })
    const message = await prisma.message.create({
      data: {
        chatId: chat.id,
        channel: 'max',
        direction: 'inbound',
        content: 'Сообщение',
      },
    })
    const attachment = await prisma.messageAttachment.create({
      data: {
        messageId: message.id,
        type: 'image',
        url: '/test/image.jpg',
      },
    })
    const task = await prisma.task.create({
      data: {
        contactId: source.id,
        chatId: chat.id,
        type: 'follow_up',
        title: 'Перезвонить',
      },
    })
    const call = await prisma.call.create({
      data: {
        contactId: source.id,
        direction: 'inbound',
        fromNumber: '+79990000101',
        toNumber: '+79990000999',
        fsUuid: 'merge-db-call-1',
      },
    })
    const driver = await prisma.driver.create({
      data: {
        contactId: source.id,
        yandexDriverId: 'merge-db-driver-1',
        externalDriverProfileId: 'profile-1',
        externalParkId: 'park-1',
        fullName: 'Водитель Источник',
      },
    })
    await prisma.contact.update({
      where: { id: source.id },
      data: { mainDriverId: driver.id, mainDriverSelection: 'manual' },
    })
    const audit = await prisma.contactDriverProfileAudit.create({
      data: {
        contactId: source.id,
        driverId: driver.id,
        action: 'test_attach',
        selectedBy: 'db-test',
      },
    })
    const telegramBinding = await prisma.driverTelegram.create({
      data: {
        driverId: driver.id,
        telegramId: BigInt('900000000001'),
        username: 'merge_driver',
      },
    })

    const preview = await ContactMergeService.previewContactMerge(source.id, target.id, 'operator-1')
    expect(preview.blockers).toEqual([])
    expect(preview.entities).toMatchObject({
      identities: { count: 1 },
      phones: { count: 2 },
      chats: { count: 1 },
      messages: { count: 1 },
      attachments: { count: 1 },
      tasks: { count: 1 },
      calls: { count: 1 },
      driverProfiles: { count: 1 },
      profileAudits: { count: 1 },
      telegramBindings: { count: 1 },
    })
    expect(preview.duplicates.phones).toEqual([{
      sourcePhoneId: sourceDuplicatePhone.id,
      targetPhoneId: targetPhone.id,
      phone: '+79990000100',
    }])

    const result = await ContactMergeService.executeContactMerge(executeInput(preview))
    expect(result.status).toBe('contact_merged')
    if (result.status !== 'contact_merged') throw new Error('expected contact_merged')

    expect(await prisma.contact.findUnique({ where: { id: source.id }, select: { isArchived: true } }))
      .toEqual({ isArchived: true })
    expect(await prisma.contactIdentity.findUnique({ where: { id: identity.id } }))
      .toMatchObject({ contactId: target.id, phoneId: targetPhone.id })
    expect(await prisma.chat.findUnique({ where: { id: chat.id } }))
      .toMatchObject({ contactId: target.id, contactIdentityId: identity.id })
    expect(await prisma.message.findUnique({ where: { id: message.id } }))
      .toMatchObject({ chatId: chat.id, content: 'Сообщение' })
    expect(await prisma.messageAttachment.findUnique({ where: { id: attachment.id } }))
      .toMatchObject({ messageId: message.id })
    expect(await prisma.task.findUnique({ where: { id: task.id } }))
      .toMatchObject({ contactId: target.id })
    expect(await prisma.call.findUnique({ where: { id: call.id } }))
      .toMatchObject({ contactId: target.id })
    expect(await prisma.driver.findUnique({ where: { id: driver.id } }))
      .toMatchObject({ contactId: target.id })
    expect(await prisma.contactDriverProfileAudit.findUnique({ where: { id: audit.id } }))
      .toMatchObject({ contactId: target.id })
    expect(await prisma.driverTelegram.findUnique({ where: { id: telegramBinding.id } }))
      .toMatchObject({ driverId: driver.id, username: 'merge_driver' })
    expect(await prisma.contactPhone.count({ where: { contactId: target.id, phone: '+79990000100' } }))
      .toBe(1)

    const merge = await prisma.contactMerge.findUnique({ where: { id: result.mergeRecordId } })
    expect(merge?.mergedBy).toBe('operator-1')
    expect(merge?.snapshotBefore).toMatchObject({
      manifestVersion: 1,
      mergeRecordId: result.mergeRecordId,
      moved: {
        calls: { ids: [call.id] },
        messages: { ids: [message.id] },
        attachments: { ids: [attachment.id] },
      },
      limitations: expect.arrayContaining([
        expect.stringContaining('no automatic rollback endpoint'),
      ]),
    })

    await expect(ContactMergeService.executeContactMerge(executeInput(preview)))
      .resolves.toMatchObject({
        status: 'already_merged',
        sourceId: source.id,
        targetId: target.id,
        mergeRecordId: result.mergeRecordId,
      })
  })

  test('rejects stale plans, actor mismatch and archived targets without writes', async () => {
    const [source, target] = await Promise.all([
      prisma.contact.create({ data: { displayName: 'Источник' } }),
      prisma.contact.create({ data: { displayName: 'Цель' } }),
    ])
    const actorPreview = await ContactMergeService.previewContactMerge(source.id, target.id, 'operator-1')
    await expect(ContactMergeService.executeContactMerge(executeInput(actorPreview, 'operator-2')))
      .rejects.toMatchObject({ code: 'ACTOR_MISMATCH' } satisfies Partial<MergeError>)

    await prisma.contact.update({
      where: { id: target.id },
      data: { tags: ['changed-after-preview'] },
    })
    await expect(ContactMergeService.executeContactMerge(executeInput(actorPreview)))
      .rejects.toMatchObject({ code: 'STALE_MERGE_PLAN' } satisfies Partial<MergeError>)
    expect(await prisma.contact.findUnique({ where: { id: source.id }, select: { isArchived: true } }))
      .toEqual({ isArchived: false })

    await prisma.contact.update({ where: { id: target.id }, data: { isArchived: true } })
    const archivedPreview = await ContactMergeService.previewContactMerge(source.id, target.id, 'operator-1')
    expect(archivedPreview.blockers.map(blocker => blocker.code)).toContain('TARGET_ARCHIVED')
  })

  test('blocks cycles and inconsistent already-merged sources during preview', async () => {
    const [source, firstTarget, secondTarget] = await Promise.all([
      prisma.contact.create({ data: { displayName: 'Источник' } }),
      prisma.contact.create({ data: { displayName: 'Цель 1' } }),
      prisma.contact.create({ data: { displayName: 'Цель 2' } }),
    ])
    await prisma.contactMerge.create({
      data: {
        survivorId: secondTarget.id,
        mergedId: firstTarget.id,
        action: 'merge',
        mergedBy: 'db-test',
        reason: 'manual',
        snapshotBefore: {},
      },
    })
    await prisma.contactMerge.create({
      data: {
        survivorId: firstTarget.id,
        mergedId: secondTarget.id,
        action: 'merge',
        mergedBy: 'db-test',
        reason: 'manual',
        snapshotBefore: {},
      },
    })

    const cyclePreview = await ContactMergeService.previewContactMerge(source.id, firstTarget.id, 'operator-1')
    expect(cyclePreview.blockers.map(blocker => blocker.code)).toContain('MERGE_CYCLE')

    const alreadyMergedSource = await prisma.contact.create({ data: { displayName: 'Уже объединён' } })
    const canonical = await prisma.contact.create({ data: { displayName: 'Canonical' } })
    await prisma.contactMerge.create({
      data: {
        survivorId: canonical.id,
        mergedId: alreadyMergedSource.id,
        action: 'merge',
        mergedBy: 'db-test',
        reason: 'manual',
        snapshotBefore: {},
      },
    })
    const alreadyMergedPreview = await ContactMergeService.previewContactMerge(
      alreadyMergedSource.id,
      canonical.id,
      'operator-1',
    )
    expect(alreadyMergedPreview.blockers.map(blocker => blocker.code)).toContain('SOURCE_ALREADY_MERGED')
  })
})
