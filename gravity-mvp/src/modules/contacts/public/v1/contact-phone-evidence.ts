import { type ChatChannel, type Prisma } from '@prisma/client'
import { randomUUID } from 'node:crypto'

import { normalizePhoneE164 } from './phone-identity'
import {
  identityEvidenceState,
  jsonRecord,
  phoneEvidenceState,
  withPhoneEvidence,
  type ContactPhoneEvidenceStateV1,
  type ContactPhoneFreshnessV1,
  type ContactPhoneLifecycleV1,
  type ContactPhoneResolutionStateV1,
} from './contact-evidence-state'
import {
  assertContactOwnershipPostconditions,
  lockContactOwnershipRows,
  runContactOwnershipTransaction,
} from '../../internal/contact-ownership-coordinator'

export type ManualPhoneEvidenceCommandV1 =
  | {
      operation: 'add_or_verify'
      contactId: string
      rawPhone: string
      actor: string
      basis: string
      makePrimary?: boolean
      resolutionState?: ContactPhoneResolutionStateV1
  }
  | {
      operation: 'set_state'
      contactId: string
      phoneId: string
      actor: string
      basis: string
      lifecycle?: ContactPhoneLifecycleV1
      freshness?: ContactPhoneFreshnessV1
      resolutionState?: ContactPhoneResolutionStateV1
      makePrimary?: boolean
  }
  | {
      operation: 'attach_identity'
      contactId: string
      phoneId: string
      identityId: string
      actor: string
      basis: string
    }

export type ManualPhoneEvidenceResultV1 = {
  contactId: string
  phoneId: string
  auditId: string
}

function required(value: string, field: string): string {
  const normalized = value.trim()
  if (!normalized) throw new TypeError(`${field} is required`)
  return normalized
}

function auditState(phone: { isActive: boolean; isPrimary: boolean; verifiedAt: Date | null }, evidence: ContactPhoneEvidenceStateV1) {
  return {
    lifecycle: evidence.lifecycle,
    trust: evidence.trust,
    freshness: evidence.freshness,
    resolutionState: evidence.resolutionState,
    isActive: phone.isActive,
    isPrimary: phone.isPrimary,
    verifiedAt: phone.verifiedAt?.toISOString() ?? null,
    verifiedBy: evidence.verifiedBy,
    verificationBasis: evidence.verificationBasis,
  }
}

export async function manageContactPhoneEvidenceV1(
  command: ManualPhoneEvidenceCommandV1,
): Promise<ManualPhoneEvidenceResultV1> {
  const actor = required(command.actor, 'actor')
  const basis = required(command.basis, 'basis')
  if (command.operation === 'set_state') {
    if (command.lifecycle && !['current', 'superseded', 'removed', 'unknown'].includes(command.lifecycle)) {
      throw new TypeError('unsupported phone lifecycle')
    }
    if (command.freshness && !['fresh', 'stale', 'unknown'].includes(command.freshness)) {
      throw new TypeError('unsupported phone freshness')
    }
    if (command.resolutionState && !['unique', 'shared', 'disputed', 'unknown'].includes(command.resolutionState)) {
      throw new TypeError('unsupported phone resolution state')
    }
  }
  return runContactOwnershipTransaction(async transaction => {
    const normalizedPhone = command.operation === 'add_or_verify'
      ? normalizePhoneE164(command.rawPhone)
      : null
    if (command.operation === 'add_or_verify' && !normalizedPhone) {
      throw new TypeError('rawPhone must normalize to E.164')
    }
    const scope = await lockContactOwnershipRows(transaction, {
      contactIds: [command.contactId],
      phoneIds: command.operation === 'add_or_verify' ? [] : [command.phoneId],
      normalizedPhones: normalizedPhone ? [normalizedPhone] : [],
      identityIds: command.operation === 'attach_identity' ? [command.identityId] : [],
    })
    const contact = await transaction.contact.findUnique({
      where: { id: command.contactId },
      select: { id: true, primaryPhoneId: true, isArchived: true, customFields: true },
    })
    if (!contact || contact.isArchived) throw new Error('CONTACT_NOT_ELIGIBLE')

    let phone = command.operation === 'add_or_verify'
      ? await transaction.contactPhone.findUnique({
          where: { contactId_phone: { contactId: command.contactId, phone: normalizedPhone! } },
        })
      : await transaction.contactPhone.findFirst({
          where: { id: command.phoneId, contactId: command.contactId },
        })
    const beforeEvidence = phone
      ? phoneEvidenceState(contact.customFields, phone.id, phone)
      : null
    const before = phone && beforeEvidence ? auditState(phone, beforeEvidence) : null
    const now = new Date()
    let evidence: ContactPhoneEvidenceStateV1

    if (command.operation === 'add_or_verify') {
      const otherOwners = await transaction.contactPhone.findMany({
        where: { phone: normalizedPhone!, isActive: true, NOT: { contactId: command.contactId } },
        select: {
          id: true,
          contactId: true,
          phone: true,
          isActive: true,
          verifiedAt: true,
          contact: { select: { customFields: true } },
        },
      })
      const requestedResolution = command.resolutionState ?? 'unique'
      if (otherOwners.length > 0 && requestedResolution === 'unique') {
        throw new Error('PHONE_BELONGS_TO_OTHER')
      }
      for (const owner of otherOwners) {
        const ownerEvidence = phoneEvidenceState(owner.contact.customFields, owner.id, owner)
        await transaction.contact.update({
          where: { id: owner.contactId },
          data: {
            customFields: withPhoneEvidence(owner.contact.customFields, owner.id, {
              ...ownerEvidence,
              resolutionState: requestedResolution,
            }) as Prisma.InputJsonObject,
          },
        })
      }
      phone = phone
        ? await transaction.contactPhone.update({
            where: { id: phone.id },
            data: {
              source: 'manual',
              isActive: true,
              verifiedAt: now,
              isTemporary: false,
              expiresAt: null,
            },
          })
        : await transaction.contactPhone.create({
            data: {
              contactId: command.contactId,
              phone: normalizedPhone!,
              source: 'manual',
              isActive: true,
              isPrimary: false,
              verifiedAt: now,
            },
          })
      const previous = phoneEvidenceState(contact.customFields, phone.id, phone)
      evidence = {
        ...previous,
        rawPhone: command.rawPhone,
        lifecycle: 'current',
        trust: 'manually_verified',
        freshness: 'fresh',
        resolutionState: requestedResolution,
        verifiedBy: actor,
        verificationBasis: basis,
        observedAt: previous.observedAt ?? now.toISOString(),
        lastSeenAt: now.toISOString(),
        lifecycleUpdatedAt: now.toISOString(),
        evidenceRoot: `manual:${actor}:${now.toISOString()}`,
      }
    } else if (!phone) {
      throw new Error('PHONE_NOT_FOUND')
    } else {
      const previous = phoneEvidenceState(contact.customFields, phone.id, phone)
      evidence = previous
      if (command.operation === 'set_state') {
        const lifecycle = command.lifecycle ?? previous.lifecycle
        phone = await transaction.contactPhone.update({
          where: { id: phone.id },
          data: {
            isActive: lifecycle === 'current',
            ...(lifecycle !== 'current' ? { isPrimary: false } : {}),
          },
        })
        evidence = {
          ...previous,
          lifecycle,
          freshness: command.freshness ?? previous.freshness,
          resolutionState: command.resolutionState ?? previous.resolutionState,
          lifecycleUpdatedAt: now.toISOString(),
        }
      } else {
        const identity = await transaction.contactIdentity.findFirst({
          where: { id: command.identityId, contactId: command.contactId },
        })
        if (!identity) throw new Error('IDENTITY_NOT_FOUND')
        await transaction.contactIdentity.update({
          where: { id: identity.id },
          data: {
            phoneId: phone.id,
            source: 'manual',
            metadata: {
              ...jsonRecord(identity.metadata),
              origin: 'manual',
            } as Prisma.InputJsonObject,
          },
        })
      }
    }

    const makePrimary = command.operation !== 'attach_identity' && command.makePrimary === true
    if (makePrimary) {
      if (evidence.lifecycle !== 'current') throw new Error('PRIMARY_PHONE_MUST_BE_CURRENT')
      await transaction.contactPhone.updateMany({
        where: { contactId: command.contactId, NOT: { id: phone.id } },
        data: { isPrimary: false },
      })
      phone = await transaction.contactPhone.update({
        where: { id: phone.id },
        data: { isPrimary: true },
      })
      await transaction.contact.update({
        where: { id: command.contactId },
        data: { primaryPhoneId: phone.id },
      })
    } else if (evidence.lifecycle !== 'current' && contact.primaryPhoneId === phone.id) {
      await transaction.contact.update({
        where: { id: command.contactId },
        data: { primaryPhoneId: null },
      })
    }

    const auditId = randomUUID()
    evidence = {
      ...evidence,
      auditTrail: [...evidence.auditTrail, {
        id: auditId,
        actor,
        action: command.operation,
        basis,
        beforeState: before,
        afterState: auditState(phone, evidence),
        evidenceRoot: evidence.evidenceRoot,
        createdAt: now.toISOString(),
      }].slice(-100),
    }
    await transaction.contact.update({
      where: { id: command.contactId },
      data: {
        customFields: withPhoneEvidence(contact.customFields, phone.id, evidence) as Prisma.InputJsonObject,
      },
    })
    await assertContactOwnershipPostconditions(transaction, {
      ...scope,
      contactIds: [...new Set([...scope.contactIds, command.contactId])],
      phoneIds: [...new Set([...scope.phoneIds, phone.id])],
      normalizedPhones: [...new Set([...scope.normalizedPhones, phone.phone])],
    })
    return { contactId: command.contactId, phoneId: phone.id, auditId }
  })
}

export type ProviderIdentityAliasCommandV1 = {
  identityId: string
  channel: ChatChannel
  providerAccountId: string
  aliasType: 'wa_lid' | 'wa_phone_jid' | 'provider_alias'
  aliasValue: string
  provenance: string
  evidenceRoot?: string | null
}

export async function attachProviderIdentityAliasV1(command: ProviderIdentityAliasCommandV1) {
  const result = await runContactOwnershipTransaction(async transaction => {
    let scope = await lockContactOwnershipRows(transaction, { identityIds: [command.identityId] })
    const identity = await transaction.contactIdentity.findUnique({
      where: { id: command.identityId },
      select: { id: true, contactId: true, channel: true, isActive: true, metadata: true },
    })
    if (!identity
      || !identity.isActive
      || identity.channel !== command.channel
      || identityEvidenceState(identity.metadata).providerAccountId !== command.providerAccountId) {
      throw new Error('IDENTITY_ALIAS_SCOPE_MISMATCH')
    }
    const candidates = await transaction.contactIdentity.findMany({
      where: {
        id: { not: identity.id },
        channel: command.channel,
        isActive: true,
        OR: [
          { externalId: command.aliasValue },
          { metadata: { path: ['providerAliasValues'], array_contains: [command.aliasValue] } },
        ],
      },
      select: { id: true, contactId: true, externalId: true, metadata: true },
    })
    const scopedCandidates = candidates.filter(candidate => (
      identityEvidenceState(candidate.metadata).providerAccountId === command.providerAccountId
    ))
    // Redundant legacy identities on the already-owned Contact must not turn
    // into cross-person conflict, but attaching an alias that is another
    // primary key would make lookup ambiguous. Leave both primaries unchanged;
    // their exact Contact owner is already the same.
    const collision = scopedCandidates.find(candidate => candidate.contactId !== identity.contactId)
    const sameContactPrimary = scopedCandidates.find(candidate => (
      candidate.contactId === identity.contactId && candidate.externalId === command.aliasValue
    ))
    if (collision) {
      // CNT1 serializes discovery, and this expanded row scope protects both
      // persisted sides while the durable contradiction is written.
      scope = await lockContactOwnershipRows(transaction, {
        contactIds: [identity.contactId, collision.contactId],
        identityIds: [identity.id, collision.id],
      })
      const contactIds = [...new Set([identity.contactId, collision.contactId])].sort()
      const contacts = await transaction.contact.findMany({
        where: { id: { in: contactIds } },
        select: { id: true, customFields: true },
      })
      const now = new Date().toISOString()
      const evidenceRoot = command.evidenceRoot
        ?? `provider-alias:${command.channel}:${command.providerAccountId}:${command.aliasType}:${command.aliasValue}`
      for (const contact of contacts) {
        const customFields = jsonRecord(contact.customFields)
        const conflicts = Array.isArray(customFields.identityConflicts)
          ? customFields.identityConflicts
          : []
        const localIdentityId = contact.id === identity.contactId ? identity.id : collision.id
        const otherIdentityId = localIdentityId === identity.id ? collision.id : identity.id
        const otherContactIds = contactIds.filter(id => id !== contact.id)
        const duplicate = conflicts.some(item => {
          const conflict = jsonRecord(item)
          const details = jsonRecord(conflict.details)
          return conflict.status === 'open'
            && conflict.conflictType === 'provider_identity_alias_collision'
            && conflict.identityId === localIdentityId
            && details.channel === command.channel
            && details.providerAccountId === command.providerAccountId
            && details.aliasType === command.aliasType
            && details.aliasValue === command.aliasValue
            && details.otherIdentityId === otherIdentityId
        })
        if (!duplicate) {
          await transaction.contact.update({
            where: { id: contact.id },
            data: {
              customFields: {
                ...customFields,
                identityConflicts: [...conflicts, {
                  id: randomUUID(),
                  otherContactIds,
                  identityId: localIdentityId,
                  conflictType: 'provider_identity_alias_collision',
                  evidenceRoot,
                  source: command.provenance,
                  details: {
                    channel: command.channel,
                    providerAccountId: command.providerAccountId,
                    aliasType: command.aliasType,
                    aliasValue: command.aliasValue,
                    otherIdentityId,
                  },
                  detectedAt: now,
                  status: 'open',
                }].slice(-100),
              } as Prisma.InputJsonObject,
            },
          })
        }
      }
      for (const candidate of [identity, collision]) {
        const metadata = jsonRecord(candidate.metadata)
        if (identityEvidenceState(metadata).conflictState !== 'conflicted') {
          await transaction.contactIdentity.update({
            where: { id: candidate.id },
            data: {
              metadata: {
                ...metadata,
                conflictState: 'conflicted',
              } as Prisma.InputJsonObject,
            },
          })
        }
      }
      await assertContactOwnershipPostconditions(transaction, scope)
      return { status: 'collision' as const }
    }
    if (sameContactPrimary) {
      await assertContactOwnershipPostconditions(transaction, scope)
      return {
        status: 'already_owned' as const,
        identityId: identity.id,
        aliasType: command.aliasType,
        aliasValue: command.aliasValue,
        observedAt: new Date().toISOString(),
      }
    }
    const metadata = jsonRecord(identity.metadata)
    const aliases = Array.isArray(metadata.providerAliases) ? metadata.providerAliases : []
    const withoutAlias = aliases.filter(item => (
      !item || typeof item !== 'object' || Array.isArray(item)
      || (item as Record<string, unknown>).value !== command.aliasValue
    ))
    const providerAliasValues = [...new Set([
      ...(Array.isArray(metadata.providerAliasValues)
        ? metadata.providerAliasValues.filter((item): item is string => typeof item === 'string')
        : []),
      command.aliasValue,
    ])]
    const observedAt = new Date().toISOString()
    await transaction.contactIdentity.update({
      where: { id: identity.id },
      data: {
        metadata: {
          ...metadata,
          providerAliasValues,
          providerAliases: [...withoutAlias, {
            type: command.aliasType,
            value: command.aliasValue,
            provenance: command.provenance,
            evidenceRoot: command.evidenceRoot ?? null,
            observedAt,
            active: true,
          }].slice(-50),
        } as Prisma.InputJsonObject,
      },
    })
    await assertContactOwnershipPostconditions(transaction, scope)
    return {
      status: 'attached' as const,
      identityId: identity.id,
      aliasType: command.aliasType,
      aliasValue: command.aliasValue,
      observedAt,
    }
  })
  // Throw only after the transaction commits, so callers retain their existing
  // fail-closed control flow without rolling back the collision evidence.
  if (result.status === 'collision') throw new Error('IDENTITY_ALIAS_COLLISION')
  const { status: _status, ...attached } = result
  return attached
}
