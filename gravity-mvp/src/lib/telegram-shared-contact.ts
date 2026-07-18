import { Prisma, type PrismaClient } from '@prisma/client'

import { resolveStrictPhoneOwnership } from '@/lib/contacts/strict-phone-ownership'
import { normalizeRussianPhoneE164 } from '@/lib/phoneUtils'
import { prisma } from '@/lib/prisma'

export type TelegramSharedContactTransport = 'bot_webhook' | 'gramjs'

export type TelegramSharedContactInput = {
  senderTelegramUserId: string | number | bigint
  sharedContactUserId?: string | number | bigint | null
  phoneNumber?: string | null
  firstName?: string | null
  lastName?: string | null
  observedAt?: Date
  providerMessageId?: string | number | null
  transport: TelegramSharedContactTransport
}

export type TelegramSharedContactTrust =
  | 'trusted_own_contact'
  | 'foreign_contact'
  | 'owner_not_proven'
  | 'invalid_phone'

export type TelegramSharedContactResolution =
  | 'phone_added'
  | 'same_contact'
  | 'other_contact'
  | 'ambiguous'
  | 'ignored'

export type TelegramSharedContactDecision = {
  senderTelegramUserId: string
  sharedContactUserId: string | null
  normalizedPhone: string | null
  trustResult: TelegramSharedContactTrust
  trustedForAutomaticEnrichment: boolean
}

export type TelegramSharedContactResult = TelegramSharedContactDecision & {
  resolutionResult: TelegramSharedContactResolution
  contactId: string
  phoneId: string | null
  ownerContactIds: string[]
}

export type TelegramSharedContactMedia = {
  phoneNumber: string | null
  userId: string | null
  firstName: string | null
  lastName: string | null
}

type TelegramPhoneEvidenceRecord = {
  eventKey: string
  sourceKind: 'telegram_shared_contact'
  transport: TelegramSharedContactTransport
  observedAt: string
  providerMessageId: string | null
  providerIdentity: {
    channel: 'telegram'
    externalId: string
  }
  sharedContactUserId: string | null
  normalizedPhone: string | null
  trustResult: TelegramSharedContactTrust
  resolutionResult: TelegramSharedContactResolution
  ownerContactIds: string[]
}

type TelegramSharedContactDb = Pick<PrismaClient, '$transaction'>

function optionalId(value: string | number | bigint | null | undefined): string | null {
  if (value === null || value === undefined) return null
  const text = String(value).trim()
  return text || null
}

function optionalText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  return text || null
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function evidenceHistory(value: unknown): TelegramPhoneEvidenceRecord[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is TelegramPhoneEvidenceRecord => {
    const record = asRecord(item)
    return typeof record.eventKey === 'string'
  })
}

export function classifyTelegramSharedContact(
  input: TelegramSharedContactInput,
): TelegramSharedContactDecision {
  const senderTelegramUserId = optionalId(input.senderTelegramUserId)
  if (!senderTelegramUserId || !/^\d+$/.test(senderTelegramUserId)) {
    throw new Error('senderTelegramUserId must contain digits only')
  }

  const sharedContactUserId = optionalId(input.sharedContactUserId)
  const normalizedPhone = normalizeRussianPhoneE164(input.phoneNumber)
  let trustResult: TelegramSharedContactTrust

  if (!normalizedPhone) {
    trustResult = 'invalid_phone'
  } else if (!sharedContactUserId) {
    trustResult = 'owner_not_proven'
  } else if (sharedContactUserId !== senderTelegramUserId) {
    trustResult = 'foreign_contact'
  } else {
    trustResult = 'trusted_own_contact'
  }

  return {
    senderTelegramUserId,
    sharedContactUserId,
    normalizedPhone,
    trustResult,
    trustedForAutomaticEnrichment: trustResult === 'trusted_own_contact',
  }
}

export function readTelegramSharedContactMedia(media: unknown): TelegramSharedContactMedia | null {
  const record = asRecord(media)
  const className = optionalText(record.className) || ''
  const phoneNumber = optionalText(record.phoneNumber)
  if (!className.includes('Contact') && !phoneNumber) return null

  return {
    phoneNumber,
    userId: optionalId(record.userId as string | number | bigint | null | undefined),
    firstName: optionalText(record.firstName),
    lastName: optionalText(record.lastName),
  }
}

function appendEvidence(
  existing: unknown,
  evidence: TelegramPhoneEvidenceRecord,
): Prisma.InputJsonObject {
  const metadata = asRecord(existing)
  const history = evidenceHistory(metadata.phoneEvidenceHistory)
  const nextHistory = history.some(item => item.eventKey === evidence.eventKey)
    ? history
    : [...history, evidence]

  return {
    ...metadata as Prisma.InputJsonObject,
    phoneEvidence: evidence as unknown as Prisma.InputJsonObject,
    phoneEvidenceHistory: nextHistory as unknown as Prisma.InputJsonArray,
  }
}

function buildEvidence(
  input: TelegramSharedContactInput,
  decision: TelegramSharedContactDecision,
  resolutionResult: TelegramSharedContactResolution,
  ownerContactIds: string[],
): TelegramPhoneEvidenceRecord {
  const observedAt = input.observedAt || new Date()
  if (Number.isNaN(observedAt.getTime())) throw new Error('observedAt must be a valid date')
  const providerMessageId = optionalId(input.providerMessageId)
  const eventKey = [
    input.transport,
    decision.senderTelegramUserId,
    providerMessageId || observedAt.toISOString(),
    decision.sharedContactUserId || 'unknown',
    decision.normalizedPhone || 'invalid',
  ].join(':')

  return {
    eventKey,
    sourceKind: 'telegram_shared_contact',
    transport: input.transport,
    observedAt: observedAt.toISOString(),
    providerMessageId,
    providerIdentity: {
      channel: 'telegram',
      externalId: decision.senderTelegramUserId,
    },
    sharedContactUserId: decision.sharedContactUserId,
    normalizedPhone: decision.normalizedPhone,
    trustResult: decision.trustResult,
    resolutionResult,
    ownerContactIds: [...new Set(ownerContactIds)].sort(),
  }
}

export async function applyTelegramSharedContactPhone(
  input: TelegramSharedContactInput & {
    contactId: string
    identityId: string
  },
  db: TelegramSharedContactDb = prisma,
): Promise<TelegramSharedContactResult> {
  const decision = classifyTelegramSharedContact(input)

  return db.$transaction(async tx => {
    const identity = await tx.contactIdentity.findUnique({
      where: { id: input.identityId },
      select: {
        id: true,
        contactId: true,
        channel: true,
        externalId: true,
        isActive: true,
        metadata: true,
        phoneId: true,
      },
    })
    const contact = await tx.contact.findUnique({
      where: { id: input.contactId },
      select: { id: true, isArchived: true },
    })
    if (
      !identity
      || !identity.isActive
      || identity.channel !== 'telegram'
      || identity.contactId !== input.contactId
      || identity.externalId !== decision.senderTelegramUserId
      || !contact
      || contact.isArchived
    ) {
      throw new Error('Telegram identity does not belong to the active Contact')
    }

    let resolutionResult: TelegramSharedContactResolution = 'ignored'
    let phoneId: string | null = null
    let ownerContactIds: string[] = []

    if (decision.trustedForAutomaticEnrichment && decision.normalizedPhone) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`contact-phone:${decision.normalizedPhone}`}))`
      const ownership = await resolveStrictPhoneOwnership(tx, decision.normalizedPhone)

      if (ownership.kind === 'ambiguous') {
        resolutionResult = 'ambiguous'
        ownerContactIds = ownership.contactIds
      } else if (ownership.kind === 'matched' && ownership.contactId !== input.contactId) {
        resolutionResult = 'other_contact'
        ownerContactIds = [ownership.contactId]
      } else {
        const existing = await tx.contactPhone.findUnique({
          where: {
            contactId_phone: {
              contactId: input.contactId,
              phone: decision.normalizedPhone,
            },
          },
        })
        const activePhoneCount = await tx.contactPhone.count({
          where: { contactId: input.contactId, isActive: true },
        })
        const makePrimary = activePhoneCount === 0
        const phone = existing
          ? await tx.contactPhone.update({
              where: { id: existing.id },
              data: {
                isActive: true,
                verifiedAt: existing.verifiedAt || input.observedAt || new Date(),
              },
            })
          : await tx.contactPhone.create({
              data: {
                contactId: input.contactId,
                phone: decision.normalizedPhone,
                source: 'telegram',
                label: 'Telegram: свой контакт',
                verifiedAt: input.observedAt || new Date(),
                isPrimary: makePrimary,
              },
            })

        phoneId = phone.id
        resolutionResult = existing || ownership.kind === 'matched'
          ? 'same_contact'
          : 'phone_added'
        ownerContactIds = [input.contactId]

        if (makePrimary) {
          await tx.contact.update({
            where: { id: input.contactId },
            data: { primaryPhoneId: phone.id },
          })
        }
      }
    }

    const evidence = buildEvidence(input, decision, resolutionResult, ownerContactIds)
    await tx.contactIdentity.update({
      where: { id: identity.id },
      data: {
        metadata: appendEvidence(identity.metadata, evidence),
        ...(phoneId ? { phoneId } : {}),
      },
    })
    await tx.contactDriverProfileAudit.create({
      data: {
        contactId: input.contactId,
        action: 'telegram_phone_evidence_observed',
        selectedBy: 'system:telegram',
        reason: `${decision.trustResult}:${resolutionResult}`,
        metadata: evidence as unknown as Prisma.InputJsonObject,
      },
    })

    return {
      ...decision,
      resolutionResult,
      contactId: input.contactId,
      phoneId,
      ownerContactIds: evidence.ownerContactIds,
    }
  }, {
    isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
    timeout: 15000,
  })
}
