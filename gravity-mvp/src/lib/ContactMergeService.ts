import { Prisma } from '@prisma/client'

import { getDriverProfileStatus, refreshContactMainDriver } from '@/lib/driver-profiles/multi-park'
import { prisma } from '@/lib/prisma'

import { planMergedContactState } from './contact-merge-state'

export type MergeErrorCode =
  | 'CONTACT_NOT_FOUND'
  | 'DRIVER_NOT_FOUND'
  | 'CONTACT_ARCHIVED'
  | 'SURVIVOR_ARCHIVED'
  | 'SELF_MERGE'
  | 'DRIVER_PROFILE_NOT_ACTIVE'

export class MergeError extends Error {
  constructor(
    public readonly code: MergeErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'MergeError'
  }
}

export type MergeResult =
  | { status: 'already_linked'; contactId: string; driverId: string }
  | { status: 'linked'; contactId: string; driverId: string }
  | { status: 'merged'; survivorId: string; mergedId: string; driverId: string; mergeRecordId: string }
  | { status: 'already_merged'; sourceId: string; targetId: string }
  | { status: 'contact_merged'; survivorId: string; mergedId: string; mergeRecordId: string }

type MergeContactData = {
  id: string
  displayName: string
  displayNameSource: string
  masterSource: string
  yandexDriverId: string | null
  mainDriverId: string | null
  mainDriverSelection: string
  primaryPhoneId: string | null
  notes: string | null
  customFields: Prisma.JsonValue | null
  tags: string[]
  isArchived: boolean
  phones: Array<{ id: string; phone: string; isPrimary: boolean; source: string; isActive: boolean }>
  identities: Array<{ id: string; channel: string; externalId: string; displayName: string | null; reachabilityStatus: string }>
  chats: Array<{ id: string }>
  tasks: Array<{ id: string }>
  driverProfiles: Array<{ id: string }>
}

type ContactMergeOutcome = Extract<MergeResult, { status: 'already_merged' | 'contact_merged' }>

const mergeContactInclude = {
  phones: true,
  identities: true,
  chats: { select: { id: true } },
  tasks: { select: { id: true } },
  driverProfiles: { select: { id: true } },
} satisfies Prisma.ContactInclude

function toMergeContactData(value: unknown): MergeContactData {
  return value as MergeContactData
}

function createSnapshot(source: MergeContactData): Prisma.InputJsonValue {
  return {
    contact: {
      id: source.id,
      displayName: source.displayName,
      displayNameSource: source.displayNameSource,
      masterSource: source.masterSource,
      yandexDriverId: source.yandexDriverId,
      mainDriverId: source.mainDriverId,
      notes: source.notes,
      tags: source.tags,
      customFields: source.customFields,
    },
    phones: source.phones.map(phone => ({
      id: phone.id,
      phone: phone.phone,
      isPrimary: phone.isPrimary,
      source: phone.source,
      isActive: phone.isActive,
    })),
    identities: source.identities.map(identity => ({
      id: identity.id,
      channel: identity.channel,
      externalId: identity.externalId,
      displayName: identity.displayName,
      reachabilityStatus: identity.reachabilityStatus,
    })),
    chatIds: source.chats.map(chat => chat.id),
    taskIds: source.tasks.map(task => task.id),
    driverProfileIds: source.driverProfiles.map(profile => profile.id),
  } as Prisma.InputJsonValue
}

/**
 * Manual merge executor. It deliberately never finds a Contact by name or by
 * provider data: callers must supply the two explicit CRM Contact ids.
 */
export class ContactMergeService {
  static async mergeContactToDriver(
    contactId: string,
    driverId: string,
    mergedBy = 'system',
  ): Promise<MergeResult> {
    const result = await prisma.$transaction(async tx => {
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
        return { status: 'already_linked', contactId, driverId } as const
      }

      if (driver.contactId) {
        const merged = await this.executeContactMerge(tx, contactId, driver.contactId, mergedBy)
        if (merged.status === 'already_merged') return merged
        return {
          status: 'merged',
          survivorId: merged.survivorId,
          mergedId: merged.mergedId,
          driverId,
          mergeRecordId: merged.mergeRecordId,
        } as const
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
          personResolvedBy: mergedBy,
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
          selectedBy: mergedBy,
          reason: 'operator_confirmed_profile_from_contact_merge',
          metadata: { source: 'contact_merge' },
        },
      })
      return { status: 'linked', contactId, driverId } as const
    }, { timeout: 15000 })

    if (result.status === 'linked') {
      await refreshContactMainDriver(contactId, mergedBy)
    } else if (result.status === 'merged') {
      await refreshContactMainDriver(result.survivorId, mergedBy)
    }
    return result
  }

  static async mergeContactToContact(
    sourceId: string,
    targetId: string,
    mergedBy = 'system',
  ): Promise<MergeResult> {
    if (sourceId === targetId) throw new MergeError('SELF_MERGE', 'Cannot merge contact into itself')

    const result = await prisma.$transaction(
      tx => this.executeContactMerge(tx, sourceId, targetId, mergedBy),
      { timeout: 15000 },
    )
    if (result.status === 'contact_merged') await refreshContactMainDriver(result.survivorId, mergedBy)
    return result
  }

  private static async executeContactMerge(
    tx: Prisma.TransactionClient,
    sourceId: string,
    targetId: string,
    mergedBy: string,
  ): Promise<ContactMergeOutcome> {
    if (sourceId === targetId) throw new MergeError('SELF_MERGE', 'Cannot merge contact into itself')

    // Stable lock ordering prevents a competing A->B / B->A manual merge.
    await tx.$queryRaw`
      SELECT id FROM "Contact"
      WHERE id IN (${sourceId}, ${targetId})
      ORDER BY id
      FOR UPDATE
    `

    const [sourceRow, targetRow] = await Promise.all([
      tx.contact.findUnique({ where: { id: sourceId }, include: mergeContactInclude }),
      tx.contact.findUnique({ where: { id: targetId }, include: mergeContactInclude }),
    ])
    if (!sourceRow) throw new MergeError('CONTACT_NOT_FOUND', `Source contact ${sourceId} not found`)
    if (!targetRow) throw new MergeError('CONTACT_NOT_FOUND', `Target contact ${targetId} not found`)

    const source = toMergeContactData(sourceRow)
    const target = toMergeContactData(targetRow)

    if (source.isArchived) {
      const existing = await tx.contactMerge.findFirst({
        where: { mergedId: sourceId, survivorId: targetId, action: 'merge' },
        select: { id: true },
      })
      if (existing) return { status: 'already_merged', sourceId, targetId }
      throw new MergeError('CONTACT_ARCHIVED', `Source contact ${sourceId} is archived`)
    }
    if (target.isArchived) throw new MergeError('SURVIVOR_ARCHIVED', `Target contact ${targetId} is archived`)

    const snapshot = createSnapshot(source)
    const targetIdentityByKey = new Map(target.identities.map(identity => [`${identity.channel}:${identity.externalId}`, identity.id]))
    const duplicateIdentityIds: string[] = []
    const identityRemaps: Array<{ oldIdentityId: string; newIdentityId: string }> = []
    for (const identity of source.identities) {
      const survivorIdentityId = targetIdentityByKey.get(`${identity.channel}:${identity.externalId}`)
      if (!survivorIdentityId) continue
      duplicateIdentityIds.push(identity.id)
      identityRemaps.push({ oldIdentityId: identity.id, newIdentityId: survivorIdentityId })
    }
    for (const remap of identityRemaps) {
      await tx.chat.updateMany({
        where: { contactIdentityId: remap.oldIdentityId },
        data: { contactIdentityId: remap.newIdentityId },
      })
    }
    if (duplicateIdentityIds.length > 0) {
      await tx.contactIdentity.deleteMany({ where: { id: { in: duplicateIdentityIds } } })
    }
    await tx.contactIdentity.updateMany({ where: { contactId: sourceId }, data: { contactId: targetId } })

    const targetPhones = new Set(target.phones.map(phone => phone.phone))
    const duplicatePhoneIds = source.phones.filter(phone => targetPhones.has(phone.phone)).map(phone => phone.id)
    if (duplicatePhoneIds.length > 0) {
      await tx.contactPhone.deleteMany({ where: { id: { in: duplicatePhoneIds } } })
    }

    const state = planMergedContactState({
      source: {
        id: sourceId,
        mainDriverId: source.mainDriverId,
        mainDriverSelection: source.mainDriverSelection,
        primaryPhoneId: source.primaryPhoneId,
        profileIds: source.driverProfiles.map(profile => profile.id),
        phones: source.phones.filter(phone => !duplicatePhoneIds.includes(phone.id)).map(phone => ({ id: phone.id, isPrimary: phone.isPrimary })),
        tags: source.tags,
        notes: source.notes,
        customFields: source.customFields,
      },
      target: {
        id: targetId,
        mainDriverId: target.mainDriverId,
        mainDriverSelection: target.mainDriverSelection,
        primaryPhoneId: target.primaryPhoneId,
        profileIds: target.driverProfiles.map(profile => profile.id),
        phones: target.phones.map(phone => ({ id: phone.id, isPrimary: phone.isPrimary })),
        tags: target.tags,
        notes: target.notes,
        customFields: target.customFields,
      },
    })

    if (state.clearSourcePrimary) {
      await tx.contactPhone.updateMany({
        where: { contactId: sourceId, id: { notIn: duplicatePhoneIds }, isPrimary: true },
        data: { isPrimary: false },
      })
    }
    await tx.contactPhone.updateMany({ where: { contactId: sourceId }, data: { contactId: targetId } })

    // A chat retains its existing profile id: it is historical evidence and must
    // not be reassigned to whichever profile became the target Contact's main.
    await tx.chat.updateMany({ where: { contactId: sourceId }, data: { contactId: targetId } })
    await tx.task.updateMany({ where: { contactId: sourceId }, data: { contactId: targetId } })
    await tx.driver.updateMany({ where: { contactId: sourceId }, data: { contactId: targetId } })

    await tx.contact.update({
      where: { id: targetId },
      data: {
        mainDriverId: state.mainDriverId,
        mainDriverSelection: state.mainDriverSelection,
        primaryPhoneId: state.primaryPhoneId,
        tags: state.tags,
        notes: state.notes,
        customFields: state.customFields,
      },
    })

    const merge = await tx.contactMerge.create({
      data: {
        survivorId: targetId,
        mergedId: sourceId,
        action: 'merge',
        mergedBy,
        reason: 'manual',
        confidence: 1,
        driverYandexId: target.yandexDriverId,
        snapshotBefore: snapshot,
      },
      select: { id: true },
    })
    await tx.contact.update({
      where: { id: sourceId },
      data: {
        isArchived: true,
        mainDriverId: null,
        mainDriverSelection: 'auto',
        yandexDriverId: null,
      },
    })

    return { status: 'contact_merged', survivorId: targetId, mergedId: sourceId, mergeRecordId: merge.id }
  }
}
