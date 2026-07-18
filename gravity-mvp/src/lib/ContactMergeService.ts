import { Prisma } from '@prisma/client'

import {
  createContactMergeConfirmationToken,
  hashMergeValue,
  toMergeJsonValue,
  verifyContactMergeConfirmationToken,
  ContactMergeTokenError,
} from '@/lib/contacts/contact-merge-plan'
import { getDriverProfileStatus, refreshContactMainDriver } from '@/lib/driver-profiles/multi-park'
import { prisma } from '@/lib/prisma'

import { planMergedContactState } from './contact-merge-state'

const MAX_MERGE_DEPTH = 16

export type MergeErrorCode =
  | 'CONTACT_NOT_FOUND'
  | 'DRIVER_NOT_FOUND'
  | 'CONTACT_ARCHIVED'
  | 'SURVIVOR_ARCHIVED'
  | 'SELF_MERGE'
  | 'DRIVER_PROFILE_NOT_ACTIVE'
  | 'MERGE_CONFIRMATION_REQUIRED'
  | 'MERGE_BLOCKED'
  | 'STALE_MERGE_PLAN'
  | 'INVALID_CONFIRMATION_TOKEN'
  | 'ACTOR_MISMATCH'

export class MergeError extends Error {
  constructor(
    public readonly code: MergeErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message)
    this.name = 'MergeError'
  }
}

type MergeBlocker = {
  code: string
  message: string
}

type EntityBucket = {
  count: number
  ids: string[]
}

export type ContactMergePreview = {
  planVersion: 1
  source: {
    id: string
    displayName: string
    isArchived: boolean
  }
  target: {
    id: string
    displayName: string
    isArchived: boolean
  }
  canonicalTargetId: string | null
  sourceVersion: string
  targetVersion: string
  planHash: string
  confirmationToken: string
  confirmationExpiresAt: string
  actor: {
    required: true
    id: string
  }
  entities: {
    identities: EntityBucket
    phones: EntityBucket
    chats: EntityBucket
    messages: EntityBucket
    attachments: EntityBucket
    tasks: EntityBucket
    calls: EntityBucket
    driverProfiles: EntityBucket
    profileAudits: EntityBucket
    telegramBindings: EntityBucket
  }
  duplicates: {
    identities: Array<{
      sourceIdentityId: string
      targetIdentityId: string
      key: string
    }>
    phones: Array<{
      sourcePhoneId: string
      targetPhoneId: string
      phone: string
    }>
  }
  conflicts: string[]
  warnings: string[]
  blockers: MergeBlocker[]
  mainProfileOutcome: {
    mainDriverId: string | null
    mainDriverSelection: string
    primaryPhoneId: string | null
    adoptedLegacyYandexDriverId: string | null
  }
  rollback: {
    mode: 'operator_manifest'
    automatic: false
  }
}

export type ExecuteContactMergeInput = {
  sourceId: string
  targetId: string
  actorId: string
  planHash: string
  sourceVersion: string
  targetVersion: string
  confirmationToken: string
}

export type MergeResult =
  | { status: 'already_linked'; contactId: string; driverId: string }
  | { status: 'linked'; contactId: string; driverId: string }
  | { status: 'merge_confirmation_required'; sourceId: string; targetId: string; driverId: string; preview: ContactMergePreview }
  | { status: 'already_merged'; sourceId: string; targetId: string; mergeRecordId: string }
  | { status: 'contact_merged'; survivorId: string; mergedId: string; mergeRecordId: string; planHash: string }

type MergeDb = Prisma.TransactionClient

async function loadContactGraph(db: MergeDb, contactId: string) {
  const contact = await db.contact.findUnique({
    where: { id: contactId },
    select: {
      id: true,
      displayName: true,
      displayNameSource: true,
      masterSource: true,
      yandexDriverId: true,
      mainDriverId: true,
      mainDriverSelection: true,
      mainDriverSelectedBy: true,
      mainDriverSelectedAt: true,
      primaryPhoneId: true,
      notes: true,
      customFields: true,
      tags: true,
      isArchived: true,
      createdAt: true,
      updatedAt: true,
    },
  })
  if (!contact) return null

  const phones = await db.contactPhone.findMany({
    where: { contactId },
    orderBy: { id: 'asc' },
  })
  const identities = await db.contactIdentity.findMany({
    where: { contactId },
    orderBy: { id: 'asc' },
  })
  const chats = await db.chat.findMany({
    where: { contactId },
    orderBy: { id: 'asc' },
    select: {
      id: true,
      externalChatId: true,
      channel: true,
      contactIdentityId: true,
      driverId: true,
    },
  })
  const chatIds = chats.map(chat => chat.id)
  const messages = chatIds.length > 0
    ? await db.message.findMany({
        where: { chatId: { in: chatIds } },
        orderBy: { id: 'asc' },
        select: { id: true, chatId: true },
      })
    : []
  const messageIds = messages.map(message => message.id)
  const attachments = messageIds.length > 0
    ? await db.messageAttachment.findMany({
        where: { messageId: { in: messageIds } },
        orderBy: { id: 'asc' },
        select: { id: true, messageId: true },
      })
    : []
  const tasks = await db.task.findMany({
    where: { contactId },
    orderBy: { id: 'asc' },
    select: { id: true, driverId: true, chatId: true },
  })
  const calls = await db.call.findMany({
    where: { contactId },
    orderBy: { id: 'asc' },
    select: { id: true, driverId: true, fsUuid: true },
  })
  const driverProfiles = await db.driver.findMany({
    where: { contactId },
    orderBy: { id: 'asc' },
    select: {
      id: true,
      yandexDriverId: true,
      externalDriverProfileId: true,
      externalParkId: true,
    },
  })
  const profileAudits = await db.contactDriverProfileAudit.findMany({
    where: { contactId },
    orderBy: { id: 'asc' },
    select: { id: true, driverId: true, action: true },
  })
  const driverIds = driverProfiles.map(profile => profile.id)
  const telegramBindings = driverIds.length > 0
    ? await db.driverTelegram.findMany({
        where: { driverId: { in: driverIds } },
        orderBy: { id: 'asc' },
        select: { id: true, driverId: true, telegramId: true, username: true },
      })
    : []
  const mergesFromContact = await db.contactMerge.findMany({
    where: { mergedId: contactId, action: 'merge' },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true, survivorId: true, createdAt: true },
  })
  const mergesIntoContact = await db.contactMerge.findMany({
    where: { survivorId: contactId, action: 'merge' },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true, mergedId: true, createdAt: true },
  })

  return {
    contact,
    phones,
    identities,
    chats,
    messages,
    attachments,
    tasks,
    calls,
    driverProfiles,
    profileAudits,
    telegramBindings: telegramBindings.map(binding => ({
      ...binding,
      telegramId: binding.telegramId.toString(),
    })),
    mergesFromContact,
    mergesIntoContact,
  }
}

type LoadedContactGraph = NonNullable<Awaited<ReturnType<typeof loadContactGraph>>>

type CanonicalChain = {
  canonicalContactId: string | null
  visitedContactIds: string[]
  status: 'canonical' | 'cycle' | 'ambiguous' | 'missing' | 'archived_without_redirect'
}

async function inspectCanonicalChain(db: MergeDb, startId: string): Promise<CanonicalChain> {
  let currentId = startId
  const visited: string[] = []

  for (let depth = 0; depth < MAX_MERGE_DEPTH; depth += 1) {
    if (visited.includes(currentId)) {
      return { canonicalContactId: null, visitedContactIds: [...visited, currentId], status: 'cycle' }
    }
    visited.push(currentId)

    const contact = await db.contact.findUnique({
      where: { id: currentId },
      select: { id: true, isArchived: true },
    })
    if (!contact) return { canonicalContactId: null, visitedContactIds: visited, status: 'missing' }

    const edges = await db.contactMerge.findMany({
      where: { mergedId: currentId, action: 'merge' },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { survivorId: true },
    })
    const survivors = [...new Set(edges.map(edge => edge.survivorId))]
    if (survivors.length > 1) {
      return { canonicalContactId: null, visitedContactIds: visited, status: 'ambiguous' }
    }
    if (survivors.length === 0) {
      return {
        canonicalContactId: currentId,
        visitedContactIds: visited,
        status: contact.isArchived ? 'archived_without_redirect' : 'canonical',
      }
    }
    currentId = survivors[0]
  }

  return { canonicalContactId: null, visitedContactIds: visited, status: 'cycle' }
}

function entityBucket(rows: Array<{ id: string }>): EntityBucket {
  return { count: rows.length, ids: rows.map(row => row.id) }
}

function graphVersion(graph: LoadedContactGraph): string {
  return hashMergeValue(graph)
}

function mappedMergeState(
  source: LoadedContactGraph,
  target: LoadedContactGraph,
  duplicatePhones: ContactMergePreview['duplicates']['phones'],
) {
  const phoneRemap = new Map(duplicatePhones.map(item => [item.sourcePhoneId, item.targetPhoneId]))
  const sourcePhones = new Map<string, { id: string; isPrimary: boolean }>()
  for (const phone of source.phones) {
    const mappedId = phoneRemap.get(phone.id) ?? phone.id
    const existing = sourcePhones.get(mappedId)
    sourcePhones.set(mappedId, { id: mappedId, isPrimary: Boolean(existing?.isPrimary || phone.isPrimary) })
  }

  return planMergedContactState({
    source: {
      id: source.contact.id,
      mainDriverId: source.contact.mainDriverId,
      mainDriverSelection: source.contact.mainDriverSelection,
      primaryPhoneId: source.contact.primaryPhoneId
        ? phoneRemap.get(source.contact.primaryPhoneId) ?? source.contact.primaryPhoneId
        : null,
      profileIds: source.driverProfiles.map(profile => profile.id),
      phones: [...sourcePhones.values()],
      tags: source.contact.tags,
      notes: source.contact.notes,
      customFields: source.contact.customFields,
    },
    target: {
      id: target.contact.id,
      mainDriverId: target.contact.mainDriverId,
      mainDriverSelection: target.contact.mainDriverSelection,
      primaryPhoneId: target.contact.primaryPhoneId,
      profileIds: target.driverProfiles.map(profile => profile.id),
      phones: target.phones.map(phone => ({ id: phone.id, isPrimary: phone.isPrimary })),
      tags: target.contact.tags,
      notes: target.contact.notes,
      customFields: target.contact.customFields,
    },
  })
}

async function buildMergePlan(
  db: MergeDb,
  sourceId: string,
  targetId: string,
  actorId: string,
): Promise<{ preview: ContactMergePreview; source: LoadedContactGraph; target: LoadedContactGraph }> {
  if (sourceId === targetId) throw new MergeError('SELF_MERGE', 'Cannot merge contact into itself')

  const source = await loadContactGraph(db, sourceId)
  const target = await loadContactGraph(db, targetId)
  if (!source) throw new MergeError('CONTACT_NOT_FOUND', `Source contact ${sourceId} not found`)
  if (!target) throw new MergeError('CONTACT_NOT_FOUND', `Target contact ${targetId} not found`)

  const [sourceChain, targetChain] = await Promise.all([
    inspectCanonicalChain(db, sourceId),
    inspectCanonicalChain(db, targetId),
  ])
  const blockers: MergeBlocker[] = []
  const warnings: string[] = []
  const conflicts: string[] = []

  if (source.contact.isArchived) {
    blockers.push({ code: 'SOURCE_ARCHIVED', message: 'Исходный контакт уже архивирован или объединён' })
  }
  if (target.contact.isArchived) {
    blockers.push({ code: 'TARGET_ARCHIVED', message: 'Целевой контакт архивирован; выберите активный canonical Contact' })
  }
  if (sourceChain.status === 'cycle' || targetChain.status === 'cycle') {
    blockers.push({ code: 'MERGE_CYCLE', message: 'Обнаружен цикл в истории объединений' })
  }
  if (sourceChain.status === 'ambiguous' || targetChain.status === 'ambiguous') {
    blockers.push({ code: 'AMBIGUOUS_MERGE_CHAIN', message: 'История объединений содержит несколько canonical Contact' })
  }
  if (sourceChain.status === 'archived_without_redirect' || targetChain.status === 'archived_without_redirect') {
    blockers.push({ code: 'BROKEN_MERGE_CHAIN', message: 'Архивный Contact не имеет однозначного canonical redirect' })
  }
  if (source.mergesFromContact.length > 0) {
    blockers.push({ code: 'SOURCE_ALREADY_MERGED', message: 'Исходный Contact уже имеет запись объединения' })
  }
  if (targetChain.visitedContactIds.includes(sourceId)) {
    blockers.push({ code: 'MERGE_CYCLE', message: 'Целевой Contact уже ведёт к исходному Contact' })
  }

  const targetIdentityByKey = new Map(
    target.identities.map(identity => [`${identity.channel}:${identity.externalId}`, identity.id]),
  )
  const duplicateIdentities = source.identities.flatMap(identity => {
    const targetIdentityId = targetIdentityByKey.get(`${identity.channel}:${identity.externalId}`)
    return targetIdentityId
      ? [{
          sourceIdentityId: identity.id,
          targetIdentityId,
          key: `${identity.channel}:${identity.externalId}`,
        }]
      : []
  })
  const targetPhoneByValue = new Map(target.phones.map(phone => [phone.phone, phone.id]))
  const duplicatePhones = source.phones.flatMap(phone => {
    const targetPhoneId = targetPhoneByValue.get(phone.phone)
    return targetPhoneId
      ? [{ sourcePhoneId: phone.id, targetPhoneId, phone: phone.phone }]
      : []
  })

  if (duplicateIdentities.length > 0) warnings.push('Повторяющиеся provider identities будут сведены к identity целевого Contact')
  if (duplicatePhones.length > 0) warnings.push('Повторяющиеся телефоны будут сведены без потери identity phone binding')
  if (
    source.contact.mainDriverId
    && target.contact.mainDriverId
    && source.contact.mainDriverId !== target.contact.mainDriverId
  ) {
    conflicts.push('У обоих Contact выбран главный профиль; сохранится главный профиль целевого Contact')
  }

  const mergedState = mappedMergeState(source, target, duplicatePhones)
  const sourceVersion = graphVersion(source)
  const targetVersion = graphVersion(target)
  const entities = {
    identities: entityBucket(source.identities),
    phones: entityBucket(source.phones),
    chats: entityBucket(source.chats),
    messages: entityBucket(source.messages),
    attachments: entityBucket(source.attachments),
    tasks: entityBucket(source.tasks),
    calls: entityBucket(source.calls),
    driverProfiles: entityBucket(source.driverProfiles),
    profileAudits: entityBucket(source.profileAudits),
    telegramBindings: entityBucket(source.telegramBindings),
  }
  const adoptedLegacyYandexDriverId = target.contact.yandexDriverId ?? source.contact.yandexDriverId
  const planCore = {
    planVersion: 1,
    actorId,
    sourceId,
    targetId,
    canonicalTargetId: targetChain.canonicalContactId,
    sourceVersion,
    targetVersion,
    entities,
    duplicateIdentities,
    duplicatePhones,
    conflicts,
    warnings,
    blockers,
    mainProfileOutcome: {
      mainDriverId: mergedState.mainDriverId,
      mainDriverSelection: mergedState.mainDriverSelection,
      primaryPhoneId: mergedState.primaryPhoneId,
      adoptedLegacyYandexDriverId,
    },
  }
  const planHash = hashMergeValue(planCore)
  const confirmation = createContactMergeConfirmationToken({
    actorId,
    sourceId,
    targetId,
    planHash,
    sourceVersion,
    targetVersion,
  })

  return {
    source,
    target,
    preview: {
      planVersion: 1,
      source: {
        id: sourceId,
        displayName: source.contact.displayName,
        isArchived: source.contact.isArchived,
      },
      target: {
        id: targetId,
        displayName: target.contact.displayName,
        isArchived: target.contact.isArchived,
      },
      canonicalTargetId: targetChain.canonicalContactId,
      sourceVersion,
      targetVersion,
      planHash,
      confirmationToken: confirmation.token,
      confirmationExpiresAt: new Date(confirmation.expiresAt).toISOString(),
      actor: { required: true, id: actorId },
      entities,
      duplicates: {
        identities: duplicateIdentities,
        phones: duplicatePhones,
      },
      conflicts,
      warnings,
      blockers,
      mainProfileOutcome: {
        mainDriverId: mergedState.mainDriverId,
        mainDriverSelection: mergedState.mainDriverSelection,
        primaryPhoneId: mergedState.primaryPhoneId,
        adoptedLegacyYandexDriverId,
      },
      rollback: {
        mode: 'operator_manifest',
        automatic: false,
      },
    },
  }
}

function assertTokenMatchesInput(input: ExecuteContactMergeInput) {
  let token
  try {
    token = verifyContactMergeConfirmationToken(input.confirmationToken)
  } catch (error) {
    if (error instanceof ContactMergeTokenError) {
      throw new MergeError('INVALID_CONFIRMATION_TOKEN', error.message)
    }
    throw error
  }
  if (token.actorId !== input.actorId) {
    throw new MergeError('ACTOR_MISMATCH', 'Merge confirmation belongs to another operator')
  }
  if (
    token.sourceId !== input.sourceId
    || token.targetId !== input.targetId
    || token.planHash !== input.planHash
    || token.sourceVersion !== input.sourceVersion
    || token.targetVersion !== input.targetVersion
  ) {
    throw new MergeError('INVALID_CONFIRMATION_TOKEN', 'Merge confirmation does not match the requested plan')
  }
}

function asInputJson(value: unknown): Prisma.InputJsonValue {
  return toMergeJsonValue(value) as Prisma.InputJsonValue
}

export class ContactMergeService {
  static async previewContactMerge(
    sourceId: string,
    targetId: string,
    actorId: string,
  ): Promise<ContactMergePreview> {
    const result = await prisma.$transaction(
      tx => buildMergePlan(tx, sourceId, targetId, actorId),
      { timeout: 15000 },
    )
    return result.preview
  }

  static async executeContactMerge(input: ExecuteContactMergeInput): Promise<MergeResult> {
    assertTokenMatchesInput(input)

    const result = await prisma.$transaction(async tx => {
      const lockIds = [input.sourceId, input.targetId].sort((left, right) => left.localeCompare(right))
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`contact-merge:${lockIds[0]}`}))`
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`contact-merge:${lockIds[1]}`}))`
      await tx.$queryRaw`
        SELECT id FROM "Contact"
        WHERE id IN (${lockIds[0]}, ${lockIds[1]})
        ORDER BY id
        FOR UPDATE
      `

      const sourceState = await tx.contact.findUnique({
        where: { id: input.sourceId },
        select: { id: true, isArchived: true },
      })
      if (!sourceState) throw new MergeError('CONTACT_NOT_FOUND', `Source contact ${input.sourceId} not found`)
      if (sourceState.isArchived) {
        const existing = await tx.contactMerge.findFirst({
          where: {
            mergedId: input.sourceId,
            survivorId: input.targetId,
            action: 'merge',
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          select: { id: true },
        })
        if (existing) {
          return {
            status: 'already_merged',
            sourceId: input.sourceId,
            targetId: input.targetId,
            mergeRecordId: existing.id,
          } as const
        }
      }

      const current = await buildMergePlan(tx, input.sourceId, input.targetId, input.actorId)
      if (current.preview.blockers.length > 0) {
        throw new MergeError('MERGE_BLOCKED', 'Merge plan contains blockers', current.preview.blockers)
      }
      if (
        current.preview.planHash !== input.planHash
        || current.preview.sourceVersion !== input.sourceVersion
        || current.preview.targetVersion !== input.targetVersion
      ) {
        throw new MergeError('STALE_MERGE_PLAN', 'Contact data changed after preview; review the merge again')
      }

      const { source, target, preview } = current
      const duplicateIdentityIds = preview.duplicates.identities.map(item => item.sourceIdentityId)
      for (const duplicate of preview.duplicates.identities) {
        await tx.chat.updateMany({
          where: { contactIdentityId: duplicate.sourceIdentityId },
          data: { contactIdentityId: duplicate.targetIdentityId },
        })
      }
      if (duplicateIdentityIds.length > 0) {
        await tx.contactIdentity.deleteMany({ where: { id: { in: duplicateIdentityIds } } })
      }

      for (const duplicate of preview.duplicates.phones) {
        const sourcePhone = source.phones.find(phone => phone.id === duplicate.sourcePhoneId)
        const targetPhone = target.phones.find(phone => phone.id === duplicate.targetPhoneId)
        if (!sourcePhone || !targetPhone) {
          throw new MergeError('STALE_MERGE_PLAN', 'Phone ownership changed after preview')
        }
        await tx.contactIdentity.updateMany({
          where: { phoneId: duplicate.sourcePhoneId },
          data: { phoneId: duplicate.targetPhoneId },
        })
        await tx.contactPhone.update({
          where: { id: duplicate.targetPhoneId },
          data: {
            label: targetPhone.label ?? sourcePhone.label,
            isActive: targetPhone.isActive || sourcePhone.isActive,
            verifiedAt: targetPhone.verifiedAt ?? sourcePhone.verifiedAt,
            isTemporary: targetPhone.isTemporary && sourcePhone.isTemporary,
            expiresAt: targetPhone.isTemporary && sourcePhone.isTemporary
              ? targetPhone.expiresAt ?? sourcePhone.expiresAt
              : null,
          },
        })
      }
      const duplicatePhoneIds = preview.duplicates.phones.map(item => item.sourcePhoneId)
      if (duplicatePhoneIds.length > 0) {
        await tx.contactPhone.deleteMany({ where: { id: { in: duplicatePhoneIds } } })
      }

      await tx.contactIdentity.updateMany({
        where: { contactId: input.sourceId },
        data: { contactId: input.targetId },
      })
      await tx.contactPhone.updateMany({
        where: { contactId: { in: [input.sourceId, input.targetId] }, isPrimary: true },
        data: { isPrimary: false },
      })
      await tx.contactPhone.updateMany({
        where: { contactId: input.sourceId },
        data: { contactId: input.targetId },
      })

      await tx.chat.updateMany({ where: { contactId: input.sourceId }, data: { contactId: input.targetId } })
      await tx.task.updateMany({ where: { contactId: input.sourceId }, data: { contactId: input.targetId } })
      await tx.call.updateMany({ where: { contactId: input.sourceId }, data: { contactId: input.targetId } })
      await tx.driver.updateMany({ where: { contactId: input.sourceId }, data: { contactId: input.targetId } })
      await tx.contactDriverProfileAudit.updateMany({
        where: { contactId: input.sourceId },
        data: { contactId: input.targetId },
      })

      const mergedState = mappedMergeState(source, target, preview.duplicates.phones)
      await tx.contact.update({
        where: { id: input.sourceId },
        data: {
          isArchived: true,
          mainDriverId: null,
          mainDriverSelection: 'auto',
          mainDriverSelectedBy: null,
          mainDriverSelectedAt: null,
          primaryPhoneId: null,
          yandexDriverId: null,
        },
      })
      await tx.contact.update({
        where: { id: input.targetId },
        data: {
          mainDriverId: preview.mainProfileOutcome.mainDriverId,
          mainDriverSelection: preview.mainProfileOutcome.mainDriverSelection,
          primaryPhoneId: preview.mainProfileOutcome.primaryPhoneId,
          yandexDriverId: preview.mainProfileOutcome.adoptedLegacyYandexDriverId,
          tags: mergedState.tags,
          notes: mergedState.notes,
          customFields: mergedState.customFields === null
            ? Prisma.JsonNull
            : mergedState.customFields as Prisma.InputJsonValue,
        },
      })
      if (preview.mainProfileOutcome.primaryPhoneId) {
        await tx.contactPhone.update({
          where: { id: preview.mainProfileOutcome.primaryPhoneId },
          data: { isPrimary: true },
        })
      }

      const preliminaryManifest = {
        manifestVersion: 1,
        planHash: preview.planHash,
        actorId: input.actorId,
        sourceSnapshot: source,
        targetSnapshot: target,
        moved: preview.entities,
        duplicateIdentities: preview.duplicates.identities,
        duplicatePhones: preview.duplicates.phones,
        ownership: {
          identities: input.sourceId,
          phones: input.sourceId,
          chats: input.sourceId,
          tasks: input.sourceId,
          calls: input.sourceId,
          driverProfiles: input.sourceId,
          profileAudits: input.sourceId,
          messages: 'transitive_via_chat',
          attachments: 'transitive_via_message',
          telegramBindings: 'retained_via_driver_profile',
        },
        limitations: [
          'Rollback is operator-executed from this manifest; no automatic rollback endpoint is provided.',
          'Messages and attachments retain their ids and remain owned transitively through the moved Chat.',
          'DriverTelegram rows retain their driverId and follow the moved DriverProfile.',
        ],
      }
      const merge = await tx.contactMerge.create({
        data: {
          survivorId: input.targetId,
          mergedId: input.sourceId,
          action: 'merge',
          mergedBy: input.actorId,
          reason: 'manual',
          confidence: 1,
          driverYandexId: preview.mainProfileOutcome.adoptedLegacyYandexDriverId,
          snapshotBefore: asInputJson(preliminaryManifest),
        },
        select: { id: true },
      })
      const mergeAudit = await tx.contactDriverProfileAudit.create({
        data: {
          contactId: input.targetId,
          driverId: preview.mainProfileOutcome.mainDriverId,
          previousMainDriverId: target.contact.mainDriverId,
          action: 'contact_merge',
          selectedBy: input.actorId,
          reason: 'operator_confirmed_contact_merge',
          metadata: {
            mergeRecordId: merge.id,
            sourceContactId: input.sourceId,
            planHash: input.planHash,
          },
        },
        select: { id: true },
      })
      const rollbackManifest = {
        ...preliminaryManifest,
        mergeRecordId: merge.id,
        mergeAuditId: mergeAudit.id,
        executedAt: new Date().toISOString(),
      }
      await tx.contactMerge.update({
        where: { id: merge.id },
        data: { snapshotBefore: asInputJson(rollbackManifest) },
      })

      return {
        status: 'contact_merged',
        survivorId: input.targetId,
        mergedId: input.sourceId,
        mergeRecordId: merge.id,
        planHash: input.planHash,
      } as const
    }, {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      timeout: 30000,
    })

    if (result.status === 'contact_merged') {
      await refreshContactMainDriver(result.survivorId, input.actorId)
    }
    return result
  }

  static async mergeContactToDriver(
    contactId: string,
    driverId: string,
    actorId: string,
  ): Promise<MergeResult> {
    const decision = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "Driver" WHERE id = ${driverId} FOR UPDATE`
      await tx.$queryRaw`SELECT id FROM "Contact" WHERE id = ${contactId} FOR UPDATE`

      const driver = await tx.driver.findUnique({
        where: { id: driverId },
        select: {
          id: true,
          contactId: true,
          dismissedAt: true,
          statusOverride: true,
        },
      })
      if (!driver) throw new MergeError('DRIVER_NOT_FOUND', `Driver profile ${driverId} not found`)

      const contact = await tx.contact.findUnique({
        where: { id: contactId },
        select: { id: true, isArchived: true },
      })
      if (!contact) throw new MergeError('CONTACT_NOT_FOUND', `Contact ${contactId} not found`)
      if (contact.isArchived) throw new MergeError('CONTACT_ARCHIVED', `Contact ${contactId} is archived`)

      if (driver.contactId === contactId) {
        return { kind: 'already_linked' as const }
      }
      if (driver.contactId) {
        return { kind: 'merge_required' as const, targetId: driver.contactId }
      }
      if (getDriverProfileStatus(driver) !== 'working') {
        throw new MergeError('DRIVER_PROFILE_NOT_ACTIVE', 'Нельзя привязать неактивный профиль водителя')
      }

      await tx.driver.update({
        where: { id: driverId },
        data: {
          contactId,
          personResolutionStatus: 'proven',
          personResolutionBasis: 'PROVEN_MANUAL',
          personResolutionAt: new Date(),
          personResolvedBy: actorId,
        },
      })
      await tx.chat.updateMany({
        where: { contactId, driverId: null },
        data: { driverId },
      })
      await tx.contactDriverProfileAudit.create({
        data: {
          contactId,
          driverId,
          action: 'driver_profile_manual_attach',
          selectedBy: actorId,
          reason: 'operator_confirmed_profile_from_contact_merge',
          metadata: { source: 'contact_merge' },
        },
      })
      return { kind: 'linked' as const }
    }, { timeout: 15000 })

    if (decision.kind === 'already_linked') {
      return { status: 'already_linked', contactId, driverId }
    }
    if (decision.kind === 'merge_required') {
      const preview = await this.previewContactMerge(contactId, decision.targetId, actorId)
      return {
        status: 'merge_confirmation_required',
        sourceId: contactId,
        targetId: decision.targetId,
        driverId,
        preview,
      }
    }

    await refreshContactMainDriver(contactId, actorId)
    return { status: 'linked', contactId, driverId }
  }
}
