import {
  ChatChannel,
  ContactPhoneSource,
  type Prisma,
} from '@prisma/client'

import {
  assertContactOwnershipPostconditions,
  lockContactOwnershipRows,
  runContactOwnershipTransaction,
  type ContactOwnershipLockedScope,
} from '@/modules/contacts/internal/contact-ownership-coordinator'
import {
  identityEvidenceState,
  jsonRecord,
  phoneEvidenceState,
  providerAccountMatches,
  withPhoneEvidence,
  type ContactPhoneTrustV1,
} from '@/modules/contacts/public/v1/contact-evidence-state'

import {
  ContactResolutionService,
  createPrismaContactResolutionRepository,
} from './ContactResolutionService'
import type {
  ContactResolutionInput,
  ContactResolutionResult,
  ResolutionWarning,
} from './contact-resolution.types'

export type ResolvedContactRecord = { id: string; displayName: string }
export type ResolvedIdentityRecord = { id: string; channel: ChatChannel; externalId: string }

export type SafeContactResolutionSuccess = {
  status: 'resolved' | 'created' | 'identity_reused'
  contact: ResolvedContactRecord
  identity: ResolvedIdentityRecord | null
  phoneId: string | null
  isNew: boolean
  warnings: ResolutionWarning[]
}

export type SafeContactResolutionResult =
  | SafeContactResolutionSuccess
  | {
      status: 'ambiguous'
      candidateContactIds: string[]
      candidateCount: number
      warnings: ResolutionWarning[]
    }
  | {
      status: 'identity_phone_conflict'
      identityContactId: string
      phoneContactIds: string[]
      warnings: ResolutionWarning[]
    }
  | { status: 'archived'; contactId: string; warnings: ResolutionWarning[] }
  | { status: 'merge_cycle'; contactIds: string[]; warnings: ResolutionWarning[] }
  | { status: 'group_skipped'; warnings: ResolutionWarning[] }
  | { status: 'unknown_kind_limited'; warnings: ResolutionWarning[] }
  | { status: 'phone_evidence_blocked'; warnings: ResolutionWarning[] }
  | {
      status: 'error'
      reason:
        | 'invalid_input'
        | 'merge_ambiguous'
        | 'merge_depth_exceeded'
        | 'revalidation_changed'
        | 'canonical_contact_missing'
        | 'identity_required'
        | 'execution_failed'
      contactIds?: string[]
      warnings: ResolutionWarning[]
    }

export function isSafeContactResolutionSuccess(
  result: SafeContactResolutionResult,
): result is SafeContactResolutionSuccess {
  return result.status === 'resolved'
    || result.status === 'created'
    || result.status === 'identity_reused'
}

type ContactRow = {
  id: string
  displayName: string
  isArchived: boolean
  primaryPhoneId: string | null
}

type IdentityRow = {
  id: string
  contactId: string
  channel: ChatChannel
  externalId: string
  providerAccountId: string
  phoneId: string | null
}

type PhoneRow = {
  id: string
  contactId: string
  isActive: boolean
  isPrimary: boolean
}

async function storePhoneEvidence(
  tx: Prisma.TransactionClient,
  phone: PhoneRow & { phone: string; verifiedAt: Date | null },
  input: { trust: ContactPhoneTrustV1; evidenceRoot: string; verifiedAt: Date | null },
): Promise<void> {
  const contact = await tx.contact.findUnique({
    where: { id: phone.contactId },
    select: { customFields: true },
  })
  const now = new Date().toISOString()
  const previous = phoneEvidenceState(contact?.customFields, phone.id, phone)
  await tx.contact.update({
    where: { id: phone.contactId },
    data: {
      customFields: withPhoneEvidence(contact?.customFields, phone.id, {
        ...previous,
        lifecycle: 'current',
        trust: input.trust,
        freshness: 'fresh',
        resolutionState: 'unique',
        verifiedBy: 'system:contact-resolution',
        verificationBasis: input.trust,
        observedAt: previous.observedAt ?? now,
        lastSeenAt: now,
        lifecycleUpdatedAt: now,
        evidenceRoot: input.evidenceRoot,
      }) as Prisma.InputJsonObject,
    },
  })
}

function identityRow(row: {
  id: string
  contactId: string
  channel: ChatChannel
  externalId: string
  phoneId: string | null
  metadata: Prisma.JsonValue
}): IdentityRow {
  return { ...row, providerAccountId: identityEvidenceState(row.metadata).providerAccountId }
}

export interface ContactResolutionExecutionTransaction {
  lockResolutionState(input: ContactResolutionInput): Promise<void>
  plan(input: ContactResolutionInput): Promise<ContactResolutionResult>
  findIdentity(channel: ChatChannel, providerAccountId: string, externalId: string): Promise<IdentityRow | null>
  findContact(contactId: string): Promise<ContactRow | null>
  findContactPhone(contactId: string, phone: string): Promise<PhoneRow | null>
  createContact(displayName: string): Promise<ContactRow>
  createPhone(input: {
    contactId: string
    phone: string
    source: ContactPhoneSource
    isPrimary: boolean
    verifiedAt: Date | null
    trust: 'provider_bound' | 'manually_verified'
    evidenceRoot: string
  }): Promise<PhoneRow>
  reactivatePhone(input: {
    phoneId: string
    source: ContactPhoneSource
    isPrimary: boolean
    verifiedAt: Date | null
    trust: 'provider_bound' | 'manually_verified'
    evidenceRoot: string
  }): Promise<PhoneRow>
  promotePhone(input: { phoneId: string; verifiedAt: Date | null }): Promise<PhoneRow>
  setPrimaryPhone(contactId: string, phoneId: string): Promise<void>
  createIdentity(input: {
    contactId: string
    channel: ChatChannel
    externalId: string
    providerAccountId: string
    phoneId: string | null
    displayName: string | null
  }): Promise<IdentityRow>
  updateIdentity(input: {
    identityId: string
    contactId: string
    phoneId: string | null
  }): Promise<IdentityRow>
  recordConflict(input: {
    contactId: string
    otherContactIds: string[]
    identityId: string | null
    conflictType: string
    evidenceRoot: string | null
    details: Record<string, unknown>
  }): Promise<void>
}

export interface ContactResolutionUnitOfWork {
  run<T>(work: (transaction: ContactResolutionExecutionTransaction) => Promise<T>): Promise<T>
}

function nonEmpty(value: string | null | undefined): string | null {
  const trimmed = String(value ?? '').trim()
  return trimmed ? trimmed : null
}

function hasTrustedPhone(input: ContactResolutionInput): boolean {
  return Boolean(
    input.normalizedPhone
      && input.phoneEvidence?.trustedForAutomaticResolution
      && input.phoneEvidence.source !== 'message_text',
  )
}

function canonicalContactId(result: ContactResolutionResult): string | null {
  switch (result.status) {
    case 'identity_found':
    case 'phone_matched':
    case 'merged_contact':
      return result.canonicalContactId
    default:
      return null
  }
}

function blockedResult(result: ContactResolutionResult): SafeContactResolutionResult | null {
  switch (result.status) {
    case 'ambiguous_phone':
      return {
        status: 'ambiguous',
        candidateContactIds: result.candidateContactIds,
        candidateCount: result.candidateContactIds.length,
        warnings: result.warnings,
      }
    case 'identity_phone_conflict':
      return {
        status: 'identity_phone_conflict',
        identityContactId: result.identityContactId,
        phoneContactIds: result.phoneContactIds,
        warnings: result.warnings,
      }
    case 'archived_without_merge':
      return { status: 'archived', contactId: result.contactId, warnings: result.warnings }
    case 'merge_cycle':
      return { status: 'merge_cycle', contactIds: result.contactIds, warnings: result.warnings }
    case 'skipped_group':
      return { status: 'group_skipped', warnings: result.warnings }
    case 'unknown_kind_limited':
      return { status: 'unknown_kind_limited', warnings: result.warnings }
    case 'ineligible_phone':
      return { status: 'phone_evidence_blocked', warnings: result.warnings }
    case 'invalid_input':
      return { status: 'error', reason: 'invalid_input', warnings: result.warnings }
    case 'merge_ambiguous':
      return {
        status: 'error',
        reason: 'merge_ambiguous',
        contactIds: result.contactIds,
        warnings: result.warnings,
      }
    case 'merge_depth_exceeded':
      return {
        status: 'error',
        reason: 'merge_depth_exceeded',
        contactIds: result.contactIds,
        warnings: result.warnings,
      }
    default:
      return null
  }
}

function prismaExecutionTransaction(tx: Prisma.TransactionClient): ContactResolutionExecutionTransaction & {
  verifyPostconditions(): Promise<void>
} {
  const planner = new ContactResolutionService(createPrismaContactResolutionRepository(tx))
  let lockedScope: ContactOwnershipLockedScope | null = null
  let mutated = false
  return {
    async lockResolutionState(input) {
      lockedScope = await lockContactOwnershipRows(tx, {
        normalizedPhones: input.normalizedPhone ? [input.normalizedPhone] : [],
        identities: input.externalUserId
          ? [{
              channel: input.channel as ChatChannel,
              providerAccountId: nonEmpty(input.providerAccountId) ?? 'legacy',
              externalId: input.externalUserId,
            }]
          : [],
      })
    },
    plan: input => planner.resolve(input),
    async findIdentity(channel, providerAccountId, externalId) {
      const row = await tx.contactIdentity.findUnique({
        where: { channel_externalId: { channel, externalId } },
        select: { id: true, contactId: true, channel: true, externalId: true, phoneId: true, metadata: true },
      })
      if (!row) return null
      return identityRow(row)
    },
    async findContact(contactId) {
      return tx.contact.findUnique({
        where: { id: contactId },
        select: { id: true, displayName: true, isArchived: true, primaryPhoneId: true },
      })
    },
    async findContactPhone(contactId, phone) {
      return tx.contactPhone.findUnique({
        where: { contactId_phone: { contactId, phone } },
        select: { id: true, contactId: true, isActive: true, isPrimary: true },
      })
    },
    async createContact(displayName) {
      mutated = true
      const contact = await tx.contact.create({
        data: { displayName, displayNameSource: 'channel', masterSource: 'chat' },
        select: { id: true, displayName: true, isArchived: true, primaryPhoneId: true },
      })
      if (lockedScope) {
        lockedScope.contactIds = [...new Set([...lockedScope.contactIds, contact.id])].sort()
      }
      return contact
    },
    async createPhone(input) {
      mutated = true
      const phone = await tx.contactPhone.create({
        data: {
          contactId: input.contactId,
          phone: input.phone,
          source: input.source,
          isPrimary: input.isPrimary,
          verifiedAt: input.verifiedAt,
        },
        select: { id: true, contactId: true, phone: true, verifiedAt: true, isActive: true, isPrimary: true },
      })
      await storePhoneEvidence(tx, phone, input)
      return phone
    },
    async reactivatePhone(input) {
      mutated = true
      const phone = await tx.contactPhone.update({
        where: { id: input.phoneId },
        data: {
          isActive: true,
          isTemporary: false,
          expiresAt: null,
          source: input.source,
          isPrimary: input.isPrimary,
          ...(input.verifiedAt ? { verifiedAt: input.verifiedAt } : {}),
        },
        select: { id: true, contactId: true, phone: true, verifiedAt: true, isActive: true, isPrimary: true },
      })
      await storePhoneEvidence(tx, phone, input)
      return phone
    },
    async promotePhone(input) {
      mutated = true
      return tx.contactPhone.update({
        where: { id: input.phoneId },
        data: {
          isPrimary: true,
          ...(input.verifiedAt ? { verifiedAt: input.verifiedAt } : {}),
        },
        select: { id: true, contactId: true, isActive: true, isPrimary: true },
      })
    },
    async setPrimaryPhone(contactId, phoneId) {
      mutated = true
      await tx.contact.update({ where: { id: contactId }, data: { primaryPhoneId: phoneId } })
    },
    async createIdentity(input) {
      mutated = true
      const row = await tx.contactIdentity.create({
        data: {
          contactId: input.contactId,
          channel: input.channel,
          externalId: input.externalId,
          phoneId: input.phoneId,
          displayName: input.displayName,
          source: 'auto',
          confidence: 1.0,
          metadata: {
            providerAccountId: input.providerAccountId,
            origin: 'provider',
            evidenceRoot: `provider:${input.channel}:${input.providerAccountId}:${input.externalId}`,
            conflictState: 'clear',
          },
        },
        select: { id: true, contactId: true, channel: true, externalId: true, phoneId: true, metadata: true },
      })
      return identityRow(row)
    },
    async updateIdentity(input) {
      mutated = true
      const row = await tx.contactIdentity.update({
        where: { id: input.identityId },
        data: { contactId: input.contactId, phoneId: input.phoneId },
        select: { id: true, contactId: true, channel: true, externalId: true, phoneId: true, metadata: true },
      })
      return identityRow(row)
    },
    async recordConflict(input) {
      mutated = true
      const contact = await tx.contact.findUnique({
        where: { id: input.contactId },
        select: { customFields: true },
      })
      const fields = contact?.customFields && typeof contact.customFields === 'object' && !Array.isArray(contact.customFields)
        ? contact.customFields as Prisma.JsonObject
        : {}
      const conflicts = Array.isArray(fields.identityConflicts) ? fields.identityConflicts : []
      await tx.contact.update({
        where: { id: input.contactId },
        data: {
          customFields: {
            ...fields,
            identityConflicts: [...conflicts, {
              otherContactIds: input.otherContactIds,
              identityId: input.identityId,
              conflictType: input.conflictType,
              evidenceRoot: input.evidenceRoot,
              source: 'contact-resolution',
              details: input.details,
              detectedAt: new Date().toISOString(),
              status: 'open',
            }].slice(-100),
          } as Prisma.InputJsonObject,
        },
      })
      if (input.identityId) {
        const identity = await tx.contactIdentity.findUnique({
          where: { id: input.identityId },
          select: { metadata: true },
        })
        await tx.contactIdentity.update({
          where: { id: input.identityId },
          data: {
            metadata: {
              ...jsonRecord(identity?.metadata),
              conflictState: 'conflicted',
            } as Prisma.InputJsonObject,
          },
        })
      }
    },
    async verifyPostconditions() {
      if (!mutated || !lockedScope) return
      await assertContactOwnershipPostconditions(tx, lockedScope)
    },
  }
}

export const prismaContactResolutionUnitOfWork: ContactResolutionUnitOfWork = {
  run(work) {
    return runContactOwnershipTransaction(async tx => {
      const transaction = prismaExecutionTransaction(tx)
      const result = await work(transaction)
      await transaction.verifyPostconditions()
      return result
    })
  },
}

/**
 * Acquires Contacts ownership admission and row scope before invoking the
 * existing planner. No decision made outside the admitted transaction is used.
 */
export class SafeContactResolutionExecutor {
  constructor(
    // Retained as an explicit compatibility/negative-control seam: it must
    // never be called because outside-admission planning can become stale.
    private readonly planner: ContactResolutionService,
    private readonly unitOfWork: ContactResolutionUnitOfWork,
  ) {}

  static fromPrisma(): SafeContactResolutionExecutor {
    return new SafeContactResolutionExecutor(
      ContactResolutionService.fromPrisma(),
      prismaContactResolutionUnitOfWork,
    )
  }

  async execute(input: ContactResolutionInput): Promise<SafeContactResolutionResult> {
    return this.unitOfWork.run(async transaction => {
      await transaction.lockResolutionState(input)
      const admittedPlan = await transaction.plan(input)
      if (admittedPlan.status === 'identity_phone_conflict') {
        const identity = input.externalUserId
          ? await transaction.findIdentity(
              input.channel as ChatChannel,
              nonEmpty(input.providerAccountId) ?? 'legacy',
              input.externalUserId,
            )
          : null
        await transaction.recordConflict({
          contactId: admittedPlan.identityContactId,
          otherContactIds: admittedPlan.phoneContactIds,
          identityId: identity?.id ?? null,
          conflictType: 'stable_identity_phone_contradiction',
          evidenceRoot: input.phoneEvidence
            ? `${input.phoneEvidence.source}:${input.normalizedPhone ?? ''}`
            : null,
          details: {
            channel: input.channel,
            providerAccountId: nonEmpty(input.providerAccountId) ?? 'legacy',
            externalUserId: input.externalUserId ?? null,
            phoneContactIds: admittedPlan.phoneContactIds,
          },
        })
      }
      const admittedBlocked = blockedResult(admittedPlan)
      if (admittedBlocked) return admittedBlocked

      return this.executeRevalidated(transaction, input, admittedPlan)
    })
  }

  private async executeRevalidated(
    transaction: ContactResolutionExecutionTransaction,
    input: ContactResolutionInput,
    plan: ContactResolutionResult,
  ): Promise<SafeContactResolutionResult> {
    const externalId = nonEmpty(input.externalUserId)
    if (input.channel !== 'phone' && !externalId) {
      return { status: 'error', reason: 'identity_required', warnings: plan.warnings }
    }
    const trustedPhone = input.chatKind !== 'unknown' && hasTrustedPhone(input)
      ? nonEmpty(input.normalizedPhone)
      : null
    const existingIdentity = externalId
      ? await transaction.findIdentity(
          input.channel as ChatChannel,
          nonEmpty(input.providerAccountId) ?? 'legacy',
          externalId,
        )
      : null
    const requestedProviderAccountId = nonEmpty(input.providerAccountId) ?? 'legacy'
    if (existingIdentity && !providerAccountMatches(
      { providerAccountId: existingIdentity.providerAccountId },
      requestedProviderAccountId,
    )) {
      const plannedId = canonicalContactId(plan)
      await transaction.recordConflict({
        contactId: existingIdentity.contactId,
        otherContactIds: plannedId && plannedId !== existingIdentity.contactId ? [plannedId] : [],
        identityId: existingIdentity.id,
        conflictType: 'provider_account_identity_collision',
        evidenceRoot: `provider:${input.channel}:${requestedProviderAccountId}:${externalId}`,
        details: {
          channel: input.channel,
          externalId,
          storedProviderAccountId: existingIdentity.providerAccountId,
          requestedProviderAccountId,
        },
      })
      return {
        status: 'identity_phone_conflict',
        identityContactId: existingIdentity.contactId,
        phoneContactIds: plannedId && plannedId !== existingIdentity.contactId ? [plannedId] : [],
        warnings: plan.warnings,
      }
    }

    let contact: ContactRow | null = null
    const plannedContactId = canonicalContactId(plan)
    if (plannedContactId) {
      contact = await transaction.findContact(plannedContactId)
      if (!contact || contact.isArchived) {
        return {
          status: 'error',
          reason: 'canonical_contact_missing',
          warnings: plan.warnings,
        }
      }
    } else if (plan.status === 'create_required' || plan.status === 'untrusted_phone') {
      const displayName = nonEmpty(input.channelDisplayName)
        || trustedPhone
        || externalId
        || nonEmpty(input.normalizedPhone)
      if (!displayName) {
        return { status: 'error', reason: 'identity_required', warnings: plan.warnings }
      }
      contact = await transaction.createContact(displayName)
    }

    if (!contact) {
      return { status: 'error', reason: 'execution_failed', warnings: plan.warnings }
    }

    const phone = trustedPhone
      ? await this.ensureCanonicalPhone(transaction, contact, trustedPhone, input)
      : null

    let identity = existingIdentity
    if (identity) {
      const nextPhoneId = phone?.id ?? identity.phoneId
      if (identity.contactId !== contact.id || identity.phoneId !== nextPhoneId) {
        identity = await transaction.updateIdentity({
          identityId: identity.id,
          contactId: contact.id,
          phoneId: nextPhoneId,
        })
      }
    } else if (externalId) {
      identity = await transaction.createIdentity({
        contactId: contact.id,
        channel: input.channel as ChatChannel,
        externalId,
        providerAccountId: nonEmpty(input.providerAccountId) ?? 'legacy',
        phoneId: phone?.id ?? null,
        displayName: nonEmpty(input.channelDisplayName),
      })
    } else if (input.channel !== 'phone') {
      return { status: 'error', reason: 'identity_required', warnings: plan.warnings }
    }

    const created = plan.status === 'create_required' || plan.status === 'untrusted_phone'
    return {
      status: created ? 'created' : existingIdentity ? 'identity_reused' : 'resolved',
      contact: { id: contact.id, displayName: contact.displayName },
      identity: identity
        ? { id: identity.id, channel: identity.channel, externalId: identity.externalId }
        : null,
      phoneId: phone?.id ?? identity?.phoneId ?? null,
      isNew: created,
      warnings: plan.warnings,
    }
  }

  private async ensureCanonicalPhone(
    transaction: ContactResolutionExecutionTransaction,
    contact: ContactRow,
    phone: string,
    input: ContactResolutionInput,
  ): Promise<PhoneRow> {
    const source = input.channel === 'phone'
      ? ContactPhoneSource.phone
      : input.channel as ContactPhoneSource
    const verifiedAt = input.phoneEvidence?.trustedForAutomaticResolution ? new Date() : null
    const trust = input.phoneEvidence?.source === 'manual_verified'
      ? 'manually_verified' as const
      : 'provider_bound' as const
    const evidenceRoot = `${input.phoneEvidence?.source ?? 'unknown'}:${phone}`
    const makePrimary = !contact.primaryPhoneId
    const existing = await transaction.findContactPhone(contact.id, phone)
    let record: PhoneRow
    if (!existing) {
      record = await transaction.createPhone({
        contactId: contact.id,
        phone,
        source,
        isPrimary: makePrimary,
        verifiedAt,
        trust,
        evidenceRoot,
      })
    } else if (!existing.isActive) {
      record = await transaction.reactivatePhone({
        phoneId: existing.id,
        source,
        isPrimary: contact.primaryPhoneId === existing.id || makePrimary,
        verifiedAt,
        trust,
        evidenceRoot,
      })
    } else if (makePrimary && !existing.isPrimary) {
      record = await transaction.promotePhone({ phoneId: existing.id, verifiedAt })
    } else {
      record = existing
    }

    if (makePrimary) await transaction.setPrimaryPhone(contact.id, record.id)
    return record
  }
}
