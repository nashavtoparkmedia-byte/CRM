import { ChatChannel, Prisma } from '@prisma/client'

import { prisma } from '@/lib/prisma'
import { normalizePhoneE164 } from '@/lib/phoneUtils'

import type {
  ContactResolutionChannel,
  ContactResolutionInput,
  ContactResolutionRepository,
  ContactResolutionResult,
  ResolutionContact,
  ResolutionWarning,
} from './contact-resolution.types'

const DEFAULT_MAX_MERGE_DEPTH = 16

type CanonicalContactResult =
  | {
      kind: 'canonical'
      originalContactId: string
      canonicalContactId: string
      merged: boolean
    }
  | { kind: 'archived_without_merge'; contactId: string }
  | { kind: 'merge_cycle'; contactIds: string[] }
  | { kind: 'merge_ambiguous'; contactIds: string[] }
  | { kind: 'merge_depth_exceeded'; contactIds: string[] }

type CanonicalContactMatch = Extract<CanonicalContactResult, { kind: 'canonical' }>

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b))
}

function appendWarning(warnings: ResolutionWarning[], warning: ResolutionWarning): void {
  if (!warnings.includes(warning)) warnings.push(warning)
}

function hasTrustedPhoneEvidence(input: ContactResolutionInput): boolean {
  return Boolean(
    input.phoneEvidence?.trustedForAutomaticResolution
      && input.phoneEvidence.source !== 'message_text',
  )
}

function validatedNormalizedPhone(value: string | null): string | null {
  if (!value) return null
  const normalized = normalizePhoneE164(value)
  // Stage 3A receives a normalized value. Do not turn arbitrary text into a
  // lookup key here: only an already-normalized E.164 value is accepted.
  return normalized === value ? value : null
}

/**
 * Adapter for the current Prisma schema. It intentionally exposes reads only.
 * providerAccountId cannot scope these queries yet: neither ContactIdentity
 * nor Chat currently persists it.
 */
export type ContactResolutionDb = Pick<
  Prisma.TransactionClient,
  'contactIdentity' | 'contactPhone' | 'contactMerge'
>

export function createPrismaContactResolutionRepository(
  db: ContactResolutionDb = prisma,
): ContactResolutionRepository {
  return {
  async findIdentity(channel, externalUserId) {
    const identity = await db.contactIdentity.findUnique({
      where: {
        channel_externalId: {
          channel: channel as ChatChannel,
          externalId: externalUserId,
        },
      },
      select: {
        contact: { select: { id: true, isArchived: true } },
      },
    })

    return identity?.contact ?? null
  },

  async findActivePhoneOwners(normalizedPhone) {
    const phones = await db.contactPhone.findMany({
      where: { phone: normalizedPhone, isActive: true },
      select: {
        contact: { select: { id: true, isArchived: true } },
      },
    })

    return phones.map(phone => phone.contact)
  },

  async findMergesFromContact(contactId) {
    return db.contactMerge.findMany({
      where: { mergedId: contactId, action: 'merge' },
      select: {
        mergedId: true,
        survivor: { select: { id: true, isArchived: true } },
      },
    })
  },
  }
}

export const prismaContactResolutionRepository = createPrismaContactResolutionRepository()

/**
 * Read-only planner for later shadow-mode comparison. It does not create,
 * modify, merge, archive, or attach any CRM entity.
 */
export class ContactResolutionService {
  constructor(
    private readonly repository: ContactResolutionRepository,
    private readonly maxMergeDepth = DEFAULT_MAX_MERGE_DEPTH,
  ) {}

  static fromPrisma(): ContactResolutionService {
    return new ContactResolutionService(prismaContactResolutionRepository)
  }

  static fromDb(db: ContactResolutionDb): ContactResolutionService {
    return new ContactResolutionService(createPrismaContactResolutionRepository(db))
  }

  async resolve(input: ContactResolutionInput): Promise<ContactResolutionResult> {
    const warnings = this.initialWarnings(input)

    if (input.chatKind === 'group') {
      return { status: 'skipped_group', warnings }
    }

    const externalUserId = nonEmptyString(input.externalUserId)
    const suppliedPhone = nonEmptyString(input.normalizedPhone)
    const normalizedPhone = validatedNormalizedPhone(suppliedPhone)
    if (suppliedPhone && !normalizedPhone) appendWarning(warnings, 'invalid_normalized_phone')

    const identity = externalUserId
      ? await this.repository.findIdentity(input.channel, externalUserId)
      : null
    const identityResolution = identity
      ? await this.resolveCanonicalContact(identity)
      : null

    const identityTerminal = this.asTerminalResult(identityResolution, warnings)
    if (identityTerminal) return identityTerminal
    const canonicalIdentity: CanonicalContactMatch | null = identityResolution?.kind === 'canonical'
      ? identityResolution
      : null

    if (!normalizedPhone) {
      if (suppliedPhone) return { status: 'invalid_input', warnings }
      return canonicalIdentity
        ? this.identitySuccess(canonicalIdentity, warnings)
        : { status: 'create_required', warnings }
    }

    if (!hasTrustedPhoneEvidence(input)) {
      appendWarning(warnings, 'phone_not_trusted_for_automatic_resolution')
      return canonicalIdentity
        ? this.identitySuccess(canonicalIdentity, warnings)
        : { status: 'untrusted_phone', warnings }
    }

    const phoneOwners = await this.repository.findActivePhoneOwners(normalizedPhone)
    const ownersById = new Map<string, ResolutionContact>()
    for (const owner of phoneOwners) ownersById.set(owner.id, owner)

    const phoneResolutions = await Promise.all(
      [...ownersById.values()]
        .sort((a, b) => a.id.localeCompare(b.id))
        .map(owner => this.resolveCanonicalContact(owner)),
    )

    const phoneTerminal = this.asPhoneTerminalResult(phoneResolutions, canonicalIdentity, warnings)
    if (phoneTerminal) return phoneTerminal

    const canonicalPhoneOwners = sortedUnique(
      phoneResolutions
        .filter((result): result is Extract<CanonicalContactResult, { kind: 'canonical' }> => result.kind === 'canonical')
        .map(result => result.canonicalContactId),
    )

    if (canonicalIdentity) {
      if (canonicalPhoneOwners.length === 0) return this.identitySuccess(canonicalIdentity, warnings)
      if (
        canonicalPhoneOwners.length === 1
        && canonicalPhoneOwners[0] === canonicalIdentity.canonicalContactId
      ) {
        return this.identitySuccess(canonicalIdentity, warnings)
      }
      return {
        status: 'identity_phone_conflict',
        identityContactId: canonicalIdentity.canonicalContactId,
        phoneContactIds: canonicalPhoneOwners,
        warnings,
      }
    }

    if (canonicalPhoneOwners.length === 0) return { status: 'create_required', warnings }
    if (canonicalPhoneOwners.length > 1) {
      return { status: 'ambiguous_phone', candidateContactIds: canonicalPhoneOwners, warnings }
    }

    const matchingPhoneResolutions = phoneResolutions.filter(
      (result): result is Extract<CanonicalContactResult, { kind: 'canonical' }> =>
        result.kind === 'canonical' && result.canonicalContactId === canonicalPhoneOwners[0],
    )
    const originalContactId = sortedUnique(
      matchingPhoneResolutions.map(result => result.originalContactId),
    )[0]
    const wasMerged = matchingPhoneResolutions.some(result => result.merged)

    return wasMerged
      ? {
          status: 'merged_contact',
          originalContactId,
          canonicalContactId: canonicalPhoneOwners[0],
          warnings,
        }
      : {
          status: 'phone_matched',
          contactId: originalContactId,
          canonicalContactId: canonicalPhoneOwners[0],
          warnings,
        }
  }

  private initialWarnings(input: ContactResolutionInput): ResolutionWarning[] {
    // Message.externalId is global in the current schema. The planner does
    // not receive a message id, but every plan is still subject to this
    // unscoped provider limitation.
    const warnings: ResolutionWarning[] = [
      'provider_account_scope_not_persisted',
      'global_message_key',
    ]
    if (nonEmptyString(input.providerAccountId)) appendWarning(warnings, 'provider_account_scope_not_persisted')
    if (nonEmptyString(input.externalUserId)) appendWarning(warnings, 'global_identity_key')
    if (nonEmptyString(input.externalChatId)) appendWarning(warnings, 'global_chat_key')
    if (nonEmptyString(input.normalizedPhone)) appendWarning(warnings, 'phone_verification_model_limited')
    return warnings
  }

  private async resolveCanonicalContact(contact: ResolutionContact): Promise<CanonicalContactResult> {
    const originalContactId = contact.id
    let current = contact
    const visited = [current.id]

    for (let depth = 0; depth < this.maxMergeDepth; depth += 1) {
      const edges = await this.repository.findMergesFromContact(current.id)
      const survivors = new Map<string, ResolutionContact>()
      for (const edge of edges) survivors.set(edge.survivor.id, edge.survivor)

      if (survivors.size === 0) {
        if (current.isArchived) return { kind: 'archived_without_merge', contactId: current.id }
        return {
          kind: 'canonical',
          originalContactId,
          canonicalContactId: current.id,
          merged: current.id !== originalContactId,
        }
      }

      if (survivors.size > 1) {
        return { kind: 'merge_ambiguous', contactIds: sortedUnique([current.id, ...survivors.keys()]) }
      }

      const survivor = survivors.values().next().value as ResolutionContact
      if (visited.includes(survivor.id)) {
        return { kind: 'merge_cycle', contactIds: sortedUnique([...visited, survivor.id]) }
      }

      current = survivor
      visited.push(current.id)
    }

    return { kind: 'merge_depth_exceeded', contactIds: sortedUnique(visited) }
  }

  private asTerminalResult(
    resolution: CanonicalContactResult | null,
    warnings: ResolutionWarning[],
  ): ContactResolutionResult | null {
    if (!resolution || resolution.kind === 'canonical') return null
    if (resolution.kind === 'archived_without_merge') {
      return { status: 'archived_without_merge', contactId: resolution.contactId, warnings }
    }
    if (resolution.kind === 'merge_cycle') {
      return { status: 'merge_cycle', contactIds: resolution.contactIds, warnings }
    }
    if (resolution.kind === 'merge_ambiguous') {
      return { status: 'merge_ambiguous', contactIds: resolution.contactIds, warnings }
    }
    appendWarning(warnings, 'merge_depth_exceeded')
    return { status: 'merge_depth_exceeded', contactIds: resolution.contactIds, warnings }
  }

  private asPhoneTerminalResult(
    resolutions: CanonicalContactResult[],
    identityResolution: Extract<CanonicalContactResult, { kind: 'canonical' }> | null,
    warnings: ResolutionWarning[],
  ): ContactResolutionResult | null {
    for (const resolution of resolutions) {
      if (resolution.kind === 'canonical') continue
      if (identityResolution && resolution.kind === 'archived_without_merge') {
        return {
          status: 'identity_phone_conflict',
          identityContactId: identityResolution.canonicalContactId,
          phoneContactIds: sortedUnique([resolution.contactId]),
          warnings,
        }
      }
      return this.asTerminalResult(resolution, warnings)
    }
    return null
  }

  private identitySuccess(
    identity: Extract<CanonicalContactResult, { kind: 'canonical' }>,
    warnings: ResolutionWarning[],
  ): ContactResolutionResult {
    if (identity.merged) {
      return {
        status: 'merged_contact',
        originalContactId: identity.originalContactId,
        canonicalContactId: identity.canonicalContactId,
        warnings,
      }
    }
    return {
      status: 'identity_found',
      contactId: identity.originalContactId,
      canonicalContactId: identity.canonicalContactId,
      warnings,
    }
  }
}
