import { prisma } from '@/lib/prisma'
import { Prisma } from '@prisma/client'

// ── Types ────────────────────────────────────────────────────────────────────

export type MergeErrorCode =
  | 'CONTACT_NOT_FOUND'
  | 'DRIVER_NOT_FOUND'
  | 'CONTACT_ARCHIVED'
  | 'SURVIVOR_ARCHIVED'
  | 'CONTACT_LINKED_TO_OTHER_DRIVER'
  | 'ALREADY_MERGED'
  | 'SELF_MERGE'
  | 'SOURCE_HAS_DRIVER'
  | 'INVALID_MERGE_STATE'

export class MergeError extends Error {
  code: MergeErrorCode
  constructor(code: MergeErrorCode, message: string) {
    super(message)
    this.name = 'MergeError'
    this.code = code
  }
}

export type MergeResult =
  | { status: 'already_linked'; contactId: string; driverId: string }
  | { status: 'linked'; contactId: string; driverId: string }
  | { status: 'merged'; survivorId: string; mergedId: string; driverId: string; mergeRecordId: string }
  | { status: 'already_merged'; sourceId: string; targetId: string }
  | { status: 'contact_merged'; survivorId: string; mergedId: string; mergeRecordId: string }

interface SnapshotBefore {
  contact: {
    id: string
    displayName: string
    displayNameSource: string
    masterSource: string
    yandexDriverId: string | null
    notes: string | null
    tags: string[]
  }
  phones: Array<{
    id: string
    phone: string
    isPrimary: boolean
    source: string
    isActive: boolean
  }>
  identities: Array<{
    id: string
    channel: string
    externalId: string
    displayName: string | null
    reachabilityStatus: string
  }>
  chatIds: string[]
  taskIds: string[]
}

// ── Service ──────────────────────────────────────────────────────────────────

export class ContactMergeService {

  /**
   * Merge a Contact to a Driver.
   *
   * Three cases:
   *   1. Contact already linked to this Driver → already_linked (no-op)
   *   2. Driver has no Contact → simple link
   *   3. Driver has a different Contact → full merge (survivor = Driver's Contact)
   */
  static async mergeContactToDriver(
    contactId: string,
    driverId: string,
    mergedBy: string = 'system',
  ): Promise<MergeResult> {

    // ════════════════════════════════════════════════════════════════════════
    // PRECONDITION BLOCK — all invariant checks before any mutation
    // ════════════════════════════════════════════════════════════════════════

    // 1. Contact exists
    const contact = await prisma.contact.findUnique({
      where: { id: contactId },
      include: {
        phones: true,
        identities: true,
        chats: { select: { id: true } },
        tasks: { select: { id: true } },
      },
    })
    if (!contact) {
      throw new MergeError('CONTACT_NOT_FOUND', `Contact ${contactId} not found`)
    }

    // 2. Driver exists
    const driver = await prisma.driver.findUnique({
      where: { id: driverId },
      select: { id: true, yandexDriverId: true, fullName: true },
    })
    if (!driver) {
      throw new MergeError('DRIVER_NOT_FOUND', `Driver ${driverId} not found`)
    }

    // 3. Contact not archived
    if (contact.isArchived) {
      throw new MergeError('CONTACT_ARCHIVED', `Contact ${contactId} is archived (was previously merged)`)
    }

    // 4. Idempotent — contact already linked to this driver
    if (contact.yandexDriverId === driver.yandexDriverId) {
      return { status: 'already_linked', contactId, driverId }
    }

    // 5. Conflict — contact linked to a DIFFERENT driver
    if (contact.yandexDriverId && contact.yandexDriverId !== driver.yandexDriverId) {
      throw new MergeError(
        'CONTACT_LINKED_TO_OTHER_DRIVER',
        `Contact ${contactId} is linked to driver ${contact.yandexDriverId}, cannot merge to ${driver.yandexDriverId}`,
      )
    }

    // 6. Find survivor — the Contact already linked to this Driver
    const survivor = await prisma.contact.findUnique({
      where: { yandexDriverId: driver.yandexDriverId },
      include: {
        phones: true,
        identities: true,
      },
    })

    // 7. Determine case
    if (!survivor) {
      // Case 1: Simple link — Driver has no Contact yet
      return this._executeSimpleLink(contact, driver)
    }

    // 8. Survivor not archived
    if (survivor.isArchived) {
      throw new MergeError('SURVIVOR_ARCHIVED', `Survivor contact ${survivor.id} is archived`)
    }

    // 9. Self-merge guard (should be caught by check 4, but defensive)
    if (contact.id === survivor.id) {
      return { status: 'already_linked', contactId, driverId }
    }

    // Case 2: Full merge — Driver already has a different Contact
    return this._executeFullMerge(contact, survivor, driver, mergedBy)
  }

  /**
   * Merge one Contact into another (lead-to-lead or lead-to-driver-linked).
   *
   * sourceId = the contact being merged (will be archived)
   * targetId = the survivor contact (receives all data)
   *
   * If source is driver-linked → abort with SOURCE_HAS_DRIVER (operator should use reverse path).
   * If target is driver-linked → allowed (source becomes part of driver contact).
   */
  static async mergeContactToContact(
    sourceId: string,
    targetId: string,
    mergedBy: string = 'system',
  ): Promise<MergeResult> {

    // ════════════════════════════════════════════════════════════════════════
    // PRECONDITION BLOCK
    // ════════════════════════════════════════════════════════════════════════

    // 1. Self-merge guard
    if (sourceId === targetId) {
      throw new MergeError('SELF_MERGE', 'Cannot merge contact into itself')
    }

    // 2. Source exists
    const source = await prisma.contact.findUnique({
      where: { id: sourceId },
      include: {
        phones: true,
        identities: true,
        chats: { select: { id: true } },
        tasks: { select: { id: true } },
      },
    })
    if (!source) {
      throw new MergeError('CONTACT_NOT_FOUND', `Source contact ${sourceId} not found`)
    }

    // 3. Source not archived
    if (source.isArchived) {
      // Check if already merged into this target (idempotent)
      const existingMerge = await prisma.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM "ContactMerge"
        WHERE "mergedId" = ${sourceId} AND "survivorId" = ${targetId} AND action = 'merge'
        LIMIT 1
      `
      if (existingMerge.length > 0) {
        return { status: 'already_merged', sourceId, targetId }
      }
      throw new MergeError('CONTACT_ARCHIVED', `Source contact ${sourceId} is archived`)
    }

    // 4. Source must NOT be driver-linked (use reverse path or driver merge)
    if (source.yandexDriverId) {
      throw new MergeError('SOURCE_HAS_DRIVER', `Source contact ${sourceId} is linked to driver ${source.yandexDriverId}. Use this contact as target instead.`)
    }

    // 5. Target exists
    const target = await prisma.contact.findUnique({
      where: { id: targetId },
      include: {
        phones: true,
        identities: true,
      },
    })
    if (!target) {
      throw new MergeError('CONTACT_NOT_FOUND', `Target contact ${targetId} not found`)
    }

    // 6. Target not archived
    if (target.isArchived) {
      throw new MergeError('SURVIVOR_ARCHIVED', `Target contact ${targetId} is archived`)
    }

    // 7. Execute merge — reuse full merge logic without driver specifics
    return this._executeContactMerge(source, target, mergedBy)
  }

  // ── Contact-to-Contact Full Merge ──────────────────────────────────────

  private static async _executeContactMerge(
    source: {
      id: string
      displayName: string
      displayNameSource: string
      masterSource: string
      yandexDriverId: string | null
      notes: string | null
      tags: string[]
      phones: Array<{ id: string; phone: string; isPrimary: boolean; source: string; isActive: boolean }>
      identities: Array<{ id: string; channel: string; externalId: string; displayName: string | null; reachabilityStatus: string }>
      chats: { id: string }[]
      tasks: { id: string }[]
    },
    target: {
      id: string
      yandexDriverId?: string | null
      phones: Array<{ id: string; phone: string }>
      identities: Array<{ id: string; channel: string; externalId: string }>
    },
    mergedBy: string,
  ): Promise<MergeResult> {

    let mergeRecordId: string = ''

    await prisma.$transaction(async (tx) => {

      // Step 0: Lock both contacts
      await tx.$queryRaw`
        SELECT id FROM "Contact"
        WHERE id IN (${target.id}, ${source.id})
        ORDER BY id
        FOR UPDATE
      `

      // Step 1: Snapshot
      const snapshot: SnapshotBefore = {
        contact: {
          id: source.id,
          displayName: source.displayName,
          displayNameSource: source.displayNameSource as string,
          masterSource: source.masterSource as string,
          yandexDriverId: source.yandexDriverId,
          notes: source.notes,
          tags: source.tags,
        },
        phones: source.phones.map(p => ({
          id: p.id, phone: p.phone, isPrimary: p.isPrimary, source: p.source as string, isActive: p.isActive,
        })),
        identities: source.identities.map(i => ({
          id: i.id, channel: i.channel as string, externalId: i.externalId, displayName: i.displayName, reachabilityStatus: i.reachabilityStatus as string,
        })),
        chatIds: source.chats.map(c => c.id),
        taskIds: source.tasks.map(t => t.id),
      }

      // Step 2: Identity dedup + remap
      const targetIdentityMap = new Map(target.identities.map(i => [`${i.channel}:${i.externalId}`, i.id]))
      const dupIdentityIds: string[] = []
      const identityRemaps: Array<{ oldId: string; newId: string }> = []

      for (const si of source.identities) {
        const targetId = targetIdentityMap.get(`${si.channel}:${si.externalId}`)
        if (targetId) {
          dupIdentityIds.push(si.id)
          identityRemaps.push({ oldId: si.id, newId: targetId })
        }
      }

      for (const r of identityRemaps) {
        await tx.chat.updateMany({ where: { contactIdentityId: r.oldId }, data: { contactIdentityId: r.newId } })
      }
      if (dupIdentityIds.length > 0) {
        await tx.contactIdentity.deleteMany({ where: { id: { in: dupIdentityIds } } })
      }
      await tx.contactIdentity.updateMany({ where: { contactId: source.id }, data: { contactId: target.id } })

      // Step 3: Phone dedup
      const targetPhones = new Set(target.phones.map(p => p.phone))
      const dupPhoneIds = source.phones.filter(p => targetPhones.has(p.phone)).map(p => p.id)
      if (dupPhoneIds.length > 0) {
        await tx.contactPhone.deleteMany({ where: { id: { in: dupPhoneIds } } })
      }
      await tx.contactPhone.updateMany({ where: { contactId: source.id }, data: { contactId: target.id } })

      // Step 4: Move chats (without setting driverId — that's driver-merge only)
      const chatUpdateData: any = { contactId: target.id }
      // If target has a driver, propagate driverId to moved chats
      if (target.yandexDriverId) {
        const driver = await tx.driver.findUnique({ where: { yandexDriverId: target.yandexDriverId }, select: { id: true } })
        if (driver) chatUpdateData.driverId = driver.id
      }
      await tx.chat.updateMany({ where: { contactId: source.id }, data: chatUpdateData })

      // Step 5: Move tasks
      await tx.task.updateMany({ where: { contactId: source.id }, data: { contactId: target.id } })

      // Step 6: Merge record — reason='manual' distinguishes from driver merge
      const mergeResult = await tx.$queryRaw<Array<{ id: string }>>`
        INSERT INTO "ContactMerge" (id, "survivorId", "mergedId", action, "mergedBy", reason, confidence, "driverYandexId", "snapshotBefore", "createdAt")
        VALUES (
          ${generateCuid()},
          ${target.id},
          ${source.id},
          'merge',
          ${mergedBy},
          'manual',
          ${1.0},
          ${target.yandexDriverId || null},
          ${JSON.stringify(snapshot)}::jsonb,
          NOW()
        )
        RETURNING id
      `
      mergeRecordId = mergeResult[0].id

      // Step 7: Archive source
      await tx.contact.update({ where: { id: source.id }, data: { isArchived: true } })

    }, { timeout: 15000 })

    console.log(`[ContactMergeService] Contact merge: source=${source.id} → target=${target.id} mergeRecord=${mergeRecordId}`)
    return { status: 'contact_merged', survivorId: target.id, mergedId: source.id, mergeRecordId }
  }

  // ── Case 1: Simple Link ──────────────────────────────────────────────────

  private static async _executeSimpleLink(
    contact: { id: string; displayNameSource: string; chats: { id: string }[] },
    driver: { id: string; yandexDriverId: string; fullName: string },
  ): Promise<MergeResult> {

    await prisma.$transaction(async (tx) => {
      // Link contact to driver
      const updateData: any = {
        yandexDriverId: driver.yandexDriverId,
        masterSource: 'yandex',
      }

      // Update displayName from driver if not manually set
      if (contact.displayNameSource !== 'manual') {
        updateData.displayName = driver.fullName
        updateData.displayNameSource = 'yandex'
      }

      await tx.contact.update({
        where: { id: contact.id },
        data: updateData,
      })

      // Set driverId on all chats of this contact that don't have one
      if (contact.chats.length > 0) {
        await tx.chat.updateMany({
          where: {
            contactId: contact.id,
            driverId: null,
          },
          data: { driverId: driver.id },
        })
      }
    })

    console.log(`[ContactMergeService] Simple link: contact=${contact.id} → driver=${driver.yandexDriverId}`)
    return { status: 'linked', contactId: contact.id, driverId: driver.id }
  }

  // ── Case 2: Full Merge ───────────────────────────────────────────────────

  private static async _executeFullMerge(
    merged: {
      id: string
      displayName: string
      displayNameSource: string
      masterSource: string
      yandexDriverId: string | null
      notes: string | null
      tags: string[]
      phones: Array<{ id: string; phone: string; isPrimary: boolean; source: string; isActive: boolean }>
      identities: Array<{ id: string; channel: string; externalId: string; displayName: string | null; reachabilityStatus: string }>
      chats: { id: string }[]
      tasks: { id: string }[]
    },
    survivor: {
      id: string
      phones: Array<{ id: string; phone: string }>
      identities: Array<{ id: string; channel: string; externalId: string }>
    },
    driver: { id: string; yandexDriverId: string; fullName: string },
    mergedBy: string,
  ): Promise<MergeResult> {

    let mergeRecordId: string = ''

    await prisma.$transaction(async (tx) => {

      // ── Step 0: Lock both contacts (prevent concurrent merge) ──────────
      await tx.$queryRaw`
        SELECT id FROM "Contact"
        WHERE id IN (${survivor.id}, ${merged.id})
        ORDER BY id
        FOR UPDATE
      `

      // ── Step 1: Build snapshot of merged contact ───────────────────────
      const snapshot: SnapshotBefore = {
        contact: {
          id: merged.id,
          displayName: merged.displayName,
          displayNameSource: merged.displayNameSource as string,
          masterSource: merged.masterSource as string,
          yandexDriverId: merged.yandexDriverId,
          notes: merged.notes,
          tags: merged.tags,
        },
        phones: merged.phones.map(p => ({
          id: p.id,
          phone: p.phone,
          isPrimary: p.isPrimary,
          source: p.source as string,
          isActive: p.isActive,
        })),
        identities: merged.identities.map(i => ({
          id: i.id,
          channel: i.channel as string,
          externalId: i.externalId,
          displayName: i.displayName,
          reachabilityStatus: i.reachabilityStatus as string,
        })),
        chatIds: merged.chats.map(c => c.id),
        taskIds: merged.tasks.map(t => t.id),
      }

      // ── Step 2: Handle ContactIdentity duplicates ──────────────────────
      // Find identities that exist on BOTH merged and survivor (same channel+externalId)
      const survivorIdentityMap = new Map(
        survivor.identities.map(i => [`${i.channel}:${i.externalId}`, i.id])
      )

      const duplicateIdentityIds: string[] = []
      const identityRemapping: Array<{ oldIdentityId: string; newIdentityId: string }> = []

      for (const mergedIdentity of merged.identities) {
        const key = `${mergedIdentity.channel}:${mergedIdentity.externalId}`
        const survivorIdentityId = survivorIdentityMap.get(key)
        if (survivorIdentityId) {
          duplicateIdentityIds.push(mergedIdentity.id)
          identityRemapping.push({
            oldIdentityId: mergedIdentity.id,
            newIdentityId: survivorIdentityId,
          })
        }
      }

      // Remap chats pointing to duplicate identities → survivor identities
      for (const remap of identityRemapping) {
        await tx.chat.updateMany({
          where: { contactIdentityId: remap.oldIdentityId },
          data: { contactIdentityId: remap.newIdentityId },
        })
      }

      // Delete duplicate identities from merged contact
      if (duplicateIdentityIds.length > 0) {
        await tx.contactIdentity.deleteMany({
          where: { id: { in: duplicateIdentityIds } },
        })
      }

      // Move remaining identities to survivor
      await tx.contactIdentity.updateMany({
        where: { contactId: merged.id },
        data: { contactId: survivor.id },
      })

      // ── Step 3: Handle ContactPhone duplicates ─────────────────────────
      const survivorPhones = new Set(survivor.phones.map(p => p.phone))
      const duplicatePhoneIds = merged.phones
        .filter(p => survivorPhones.has(p.phone))
        .map(p => p.id)

      // Delete duplicate phones from merged
      if (duplicatePhoneIds.length > 0) {
        await tx.contactPhone.deleteMany({
          where: { id: { in: duplicatePhoneIds } },
        })
      }

      // Move remaining phones to survivor
      await tx.contactPhone.updateMany({
        where: { contactId: merged.id },
        data: { contactId: survivor.id },
      })

      // ── Step 4: Move chats to survivor ─────────────────────────────────
      await tx.chat.updateMany({
        where: { contactId: merged.id },
        data: {
          contactId: survivor.id,
          driverId: driver.id,
        },
      })

      // Also set driverId on survivor's existing chats that don't have it
      await tx.chat.updateMany({
        where: {
          contactId: survivor.id,
          driverId: null,
        },
        data: { driverId: driver.id },
      })

      // ── Step 5: Move tasks to survivor ─────────────────────────────────
      await tx.task.updateMany({
        where: { contactId: merged.id },
        data: { contactId: survivor.id },
      })

      // ── Step 6: Create ContactMerge record ─────────────────────────────
      // Using $queryRaw because driverYandexId field is not in generated Prisma types yet (EPERM on generate)
      const mergeResult = await tx.$queryRaw<Array<{ id: string }>>`
        INSERT INTO "ContactMerge" (id, "survivorId", "mergedId", action, "mergedBy", reason, confidence, "driverYandexId", "snapshotBefore", "createdAt")
        VALUES (
          ${generateCuid()},
          ${survivor.id},
          ${merged.id},
          'merge',
          ${mergedBy},
          'yandex_link',
          ${1.0},
          ${driver.yandexDriverId},
          ${JSON.stringify(snapshot)}::jsonb,
          NOW()
        )
        RETURNING id
      `
      mergeRecordId = mergeResult[0].id

      // ── Step 7: Archive merged contact ─────────────────────────────────
      await tx.contact.update({
        where: { id: merged.id },
        data: { isArchived: true },
      })

    }, { timeout: 15000 })

    console.log(`[ContactMergeService] Full merge: merged=${merged.id} → survivor=${survivor.id} driver=${driver.yandexDriverId} mergeRecord=${mergeRecordId}`)
    return {
      status: 'merged',
      survivorId: survivor.id,
      mergedId: merged.id,
      driverId: driver.id,
      mergeRecordId,
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function generateCuid(): string {
  // Simple CUID-like ID generator (matches Prisma's @default(cuid()) format)
  const timestamp = Date.now().toString(36)
  const random = Math.random().toString(36).substring(2, 10)
  return `cm${timestamp}${random}`
}
