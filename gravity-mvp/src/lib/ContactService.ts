import { prisma } from '@/lib/prisma'
import { ChatChannel, Prisma, type ContactPhoneSource } from '@prisma/client'
import { normalizePhoneE164 } from '@/modules/contacts/public/v1/phone-identity'
import {
  assertContactOwnershipPostconditions,
  lockContactOwnershipRows,
  runContactOwnershipTransaction,
  type ContactOwnershipLockedScope,
  type ContactOwnershipTransaction,
} from '@/modules/contacts/internal/contact-ownership-coordinator'
import {
  SafeContactResolutionExecutor,
  type SafeContactResolutionResult,
} from '@/lib/contacts/SafeContactResolutionExecutor'
import type { ContactResolutionInput } from '@/lib/contacts/contact-resolution.types'
import {
  identityEvidenceState,
  jsonRecord,
  phoneEvidenceState,
  withPhoneEvidence,
  type ContactPhoneEvidenceStateV1,
} from '@/modules/contacts/public/v1/contact-evidence-state'

const MAX_RETRIES = 2

export type ResolveContactPolicy = {
  chatKind?: NonNullable<ContactResolutionInput['chatKind']>
  phoneEvidence?: ContactResolutionInput['phoneEvidence']
  providerAccountId?: string
}

export type FleetContactOwnershipReconciliationResult = {
  action: 'created' | 'linked' | 'updated' | 'noop' | 'ambiguous' | 'ambiguous_phone_owner'
  phonesDeactivated: number
  phonesCreated: number
}

class FleetContactCreateConflictError extends Error {
  constructor(public readonly cause: unknown) {
    super('Fleet Contact creation lost a unique-key race')
    this.name = 'FleetContactCreateConflictError'
  }
}

class ContactOwnershipTargetNotFoundError extends Error {
  readonly code = 'CONTACT_NOT_FOUND'
}

function defaultPhoneEvidence(
  channel: ChatChannel,
  externalId: string,
  normalizedPhone: string | null,
): ContactResolutionInput['phoneEvidence'] {
  if (!normalizedPhone) return null
  if (channel === 'avito') {
    return { source: 'provider_profile', trustedForAutomaticResolution: true }
  }
  if (channel === 'whatsapp' && !/@lid$/i.test(externalId)) {
    return { source: 'whatsapp_phone_jid', trustedForAutomaticResolution: true }
  }
  return { source: 'unknown', trustedForAutomaticResolution: false }
}

function isTechnicalChannelName(value: string | null | undefined, externalId: string): boolean {
  const name = String(value || '').trim()
  if (!name) return true
  if (name === externalId) return true
  if (/@(?:lid|c\.us|s\.whatsapp\.net)$/i.test(name)) return true
  if (/^(?:Контакт\s+)?WhatsApp$/i.test(name)) return true
  return /^\+?[\d\s()\-]{10,}$/.test(name)
}

async function storePhoneEvidence(
  transaction: ContactOwnershipTransaction,
  phone: { id: string; contactId: string; phone: string; isActive: boolean; verifiedAt: Date | null },
  patch: Partial<ContactPhoneEvidenceStateV1>,
): Promise<void> {
  const contact = await transaction.contact.findUnique({
    where: { id: phone.contactId },
    select: { customFields: true },
  })
  const evidence = phoneEvidenceState(contact?.customFields, phone.id, phone)
  await transaction.contact.update({
    where: { id: phone.contactId },
    data: {
      customFields: withPhoneEvidence(contact?.customFields, phone.id, {
        ...evidence,
        ...patch,
      }) as Prisma.InputJsonObject,
    },
  })
}

function isTrustedUniqueCurrentPhone(row: {
  id: string
  phone: string
  isActive: boolean
  verifiedAt: Date | null
  contact: { customFields: Prisma.JsonValue }
}): boolean {
  const evidence = phoneEvidenceState(row.contact.customFields, row.id, row)
  return evidence.lifecycle === 'current'
    && ['provider_bound', 'manually_verified'].includes(evidence.trust)
    && evidence.freshness === 'fresh'
    && evidence.resolutionState === 'unique'
}

async function persistStableIdentityPhoneConflict(
  transaction: ContactOwnershipTransaction,
  input: {
    contactId: string
    contactCustomFields: Prisma.JsonValue | null
    identity: {
      id: string
      channel: ChatChannel
      externalId: string
      metadata: Prisma.JsonValue | null
    }
    normalizedPhone: string
    otherContactId: string
  },
): Promise<void> {
  const customFields = jsonRecord(input.contactCustomFields)
  const conflicts = Array.isArray(customFields.identityConflicts)
    ? customFields.identityConflicts
    : []
  const phoneOwners = await transaction.contactPhone.findMany({
    where: {
      phone: input.normalizedPhone,
      isActive: true,
      contactId: { not: input.contactId },
    },
    select: { contactId: true },
    orderBy: { contactId: 'asc' },
  })
  const otherContactIds = [...new Set([
    ...phoneOwners.map(owner => owner.contactId),
    input.otherContactId,
  ])].sort()
  const duplicate = conflicts.some(item => {
    const conflict = jsonRecord(item)
    const details = jsonRecord(conflict.details)
    const storedOtherContactIds = Array.isArray(conflict.otherContactIds)
      ? conflict.otherContactIds.filter((value): value is string => typeof value === 'string')
      : []
    return conflict.status === 'open'
      && conflict.conflictType === 'stable_identity_phone_contradiction'
      && conflict.identityId === input.identity.id
      && details.normalizedPhone === input.normalizedPhone
      && storedOtherContactIds.sort().join('\0') === otherContactIds.join('\0')
  })
  const identityMetadata = jsonRecord(input.identity.metadata)
  const identityEvidence = identityEvidenceState(identityMetadata)

  if (!duplicate) {
    await transaction.contact.update({
      where: { id: input.contactId },
      data: {
        customFields: {
          ...customFields,
          identityConflicts: [...conflicts, {
            otherContactIds,
            identityId: input.identity.id,
            conflictType: 'stable_identity_phone_contradiction',
            evidenceRoot: identityEvidence.evidenceRoot
              ?? `provider:${input.identity.channel}:${identityEvidence.providerAccountId}:${input.identity.externalId}`,
            source: 'attach-phone-to-identity',
            details: {
              channel: input.identity.channel,
              providerAccountId: identityEvidence.providerAccountId,
              externalUserId: input.identity.externalId,
              normalizedPhone: input.normalizedPhone,
              phoneContactIds: otherContactIds,
            },
            detectedAt: new Date().toISOString(),
            status: 'open',
          }].slice(-100),
        } as Prisma.InputJsonObject,
      },
    })
  }

  if (identityEvidence.conflictState !== 'conflicted') {
    await transaction.contactIdentity.update({
      where: { id: input.identity.id },
      data: {
        metadata: {
          ...identityMetadata,
          conflictState: 'conflicted',
        } as Prisma.InputJsonObject,
      },
    })
  }
}

/**
 * ContactService — единый сервис для работы с контактами.
 *
 * Покрываемые сценарии (Decision Table spec §6.1):
 *   1. Identity(channel, externalId) существует → вернуть существующий Contact
 *   2. Identity не найдена, но phone совпал с ContactPhone → создать Identity, вернуть Contact
 *   3. Identity не найдена, phone не найден, phone передан → создать Contact + Phone + Identity
 *   4. Identity не найдена, phone = null (MAX без номера) → создать Contact + Identity(phoneId=null)
 */
export class ContactService {

  /**
   * Resolve or create Contact + ContactIdentity for an incoming message.
   *
   * @param channel   - канал сообщения (whatsapp, telegram, max)
   * @param externalId - идентификатор отправителя в канале
   * @param phone     - номер телефона (может быть null, например MAX)
   * @param displayName - отображаемое имя из канала
   */
  static async resolveContact(
    channel: ChatChannel,
    externalId: string,
    phone: string | null | undefined,
    displayName?: string | null,
    policy?: ResolveContactPolicy,
  ): Promise<SafeContactResolutionResult> {
    const normalized = phone ? normalizePhoneE164(phone) : null
    const chatKind = policy?.chatKind
      ?? (channel === 'whatsapp' && /@g\.us$/i.test(externalId) ? 'group' : 'private')
    const input: ContactResolutionInput = {
      channel,
      externalUserId: externalId,
      providerAccountId: policy?.providerAccountId?.trim() || 'legacy',
      channelDisplayName: displayName || null,
      normalizedPhone: normalized,
      phoneEvidence: policy?.phoneEvidence
        ?? defaultPhoneEvidence(channel, externalId, normalized),
      chatKind,
    }

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await SafeContactResolutionExecutor.fromPrisma().execute(input)
      } catch (e: any) {
        // Compatibility-only retry for database uniqueness/write-conflict
        // errors. Correctness comes from admission; each retry builds a fresh
        // executor and begins a new admitted transaction.
        if ((e?.code === 'P2002' || e?.code === 'P2034') && attempt < MAX_RETRIES) {
          console.log(`[ContactService] Retry ${attempt + 1}/${MAX_RETRIES} after ${e.code}`)
          continue
        }
        console.error('[ContactService] Safe resolution failed:', e)
        return { status: 'error', reason: 'execution_failed', warnings: [] }
      }
    }

    return { status: 'error', reason: 'execution_failed', warnings: [] }
  }

  /**
   * Resolve or create a Contact for a phone number — used by the ESL call
   * handler when a Call comes in and the contact-by-phone lookup misses.
   *
   * Differs from resolveContact() in that calls have no per-channel external
   * id (no Telegram user id, no MAX userId, no WhatsApp JID). The phone IS
   * the only handle, so we only touch Contact + ContactPhone — no
   * ContactIdentity row. Later MAX/TG/WA messages from the same person will
   * hit resolveContact() and that path's "phone match" branch will attach
   * a fresh ContactIdentity to this same Contact, completing the merge.
   *
   * @returns existing or newly created Contact with primary phone attached,
   *          or null if the phone string could not be normalised.
   */
  static async resolveByPhone(
    phone: string,
    displayName?: string | null,
  ): Promise<SafeContactResolutionResult> {
    const normalized = normalizePhoneE164(phone)
    if (!normalized) {
      return { status: 'error', reason: 'invalid_input', warnings: [] }
    }

    const input: ContactResolutionInput = {
      channel: 'phone',
      normalizedPhone: normalized,
      channelDisplayName: displayName || normalized,
      phoneEvidence: { source: 'manual_verified', trustedForAutomaticResolution: true },
      chatKind: 'private',
    }

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await SafeContactResolutionExecutor.fromPrisma().execute(input)
      } catch (e: any) {
        if ((e?.code === 'P2002' || e?.code === 'P2034') && attempt < MAX_RETRIES) continue
        console.error('[ContactService] Safe phone resolution failed:', e)
        return { status: 'error', reason: 'execution_failed', warnings: [] }
      }
    }
    return { status: 'error', reason: 'execution_failed', warnings: [] }
  }

  private static async addPhoneInAdmittedTransaction(
    transaction: ContactOwnershipTransaction,
    scope: ContactOwnershipLockedScope,
    contactId: string,
    normalized: string,
    opts: {
      isTemporary?: boolean
      expiresAt?: Date | null
      source?: ContactPhoneSource
      label?: string | null
      makePrimary?: boolean
      deactivateTemporaries?: boolean
      reactivateExisting?: boolean
    } = {},
    verify = true,
  ): Promise<
    | { kind: 'added'; phoneId: string; contactId: string }
    | { kind: 'exists_same_contact'; phoneId: string; contactId: string }
    | { kind: 'conflict'; otherContactId: string; otherContactName: string }
  > {
    const contact = await transaction.contact.findUnique({
      where: { id: contactId },
      select: { id: true, isArchived: true, primaryPhoneId: true },
    })
    if (!contact || contact.isArchived) {
      throw new ContactOwnershipTargetNotFoundError(`Contact ${contactId} not found`)
    }

    const owners = await transaction.contactPhone.findMany({
      where: { phone: normalized, isActive: true },
      include: { contact: { select: { id: true, displayName: true } } },
      orderBy: { id: 'asc' },
    })
    const otherOwner = owners.find(owner => owner.contactId !== contactId)
    if (otherOwner) {
      return {
        kind: 'conflict',
        otherContactId: otherOwner.contact.id,
        otherContactName: otherOwner.contact.displayName,
      }
    }

    const same = await transaction.contactPhone.findUnique({
      where: { contactId_phone: { contactId, phone: normalized } },
    })
    if (same && opts.reactivateExisting === false) {
      return { kind: 'exists_same_contact', phoneId: same.id, contactId }
    }
    const makePrimary = opts.makePrimary ?? false

    if (opts.deactivateTemporaries) {
      const temporaries = await transaction.contactPhone.findMany({
        where: { contactId, isTemporary: true, isActive: true, NOT: { id: same?.id } },
      })
      await transaction.contactPhone.updateMany({
        where: { contactId, isTemporary: true, isActive: true, NOT: { id: same?.id } },
        data: { isActive: false, isPrimary: false },
      })
      for (const temporary of temporaries) {
        await storePhoneEvidence(transaction, { ...temporary, isActive: false }, {
          lifecycle: 'superseded',
          freshness: 'stale',
          lifecycleUpdatedAt: new Date().toISOString(),
        })
      }
    }
    if (makePrimary) {
      await transaction.contactPhone.updateMany({
        where: { contactId, isPrimary: true, NOT: { id: same?.id } },
        data: { isPrimary: false },
      })
    }

    if (same) {
      const updated = await transaction.contactPhone.update({
        where: { id: same.id },
        data: {
          isActive: true,
          ...(makePrimary ? { isPrimary: true } : {}),
          ...(opts.isTemporary !== undefined ? { isTemporary: opts.isTemporary } : {}),
          ...(opts.expiresAt !== undefined ? { expiresAt: opts.expiresAt } : {}),
          ...(opts.source ? { source: opts.source } : {}),
          ...(opts.label !== undefined ? { label: opts.label } : {}),
        },
      })
      await storePhoneEvidence(transaction, updated, {
        lifecycle: 'current',
        freshness: 'fresh',
        trust: opts.source === 'yandex' ? 'source_asserted' : 'claimed',
        resolutionState: 'unique',
        lastSeenAt: new Date().toISOString(),
        lifecycleUpdatedAt: new Date().toISOString(),
      })
      if (makePrimary) {
        await transaction.contact.update({
          where: { id: contactId },
          data: { primaryPhoneId: same.id },
        })
      }
      if (verify) await assertContactOwnershipPostconditions(transaction, scope)
      return { kind: 'exists_same_contact', phoneId: same.id, contactId }
    }

    const created = await transaction.contactPhone.create({
      data: {
        contactId,
        phone: normalized,
        source: opts.source ?? 'manual',
        label: opts.label ?? null,
        isPrimary: makePrimary,
        isTemporary: opts.isTemporary ?? false,
        expiresAt: opts.expiresAt ?? null,
      },
    })
    const observedAt = new Date().toISOString()
    await storePhoneEvidence(transaction, created, {
      rawPhone: normalized,
      lifecycle: 'current',
      trust: opts.source === 'yandex' ? 'source_asserted' : 'claimed',
      freshness: 'fresh',
      resolutionState: 'unique',
      observedAt,
      lastSeenAt: observedAt,
      lifecycleUpdatedAt: observedAt,
      evidenceRoot: opts.source ? `${opts.source}:${normalized}` : null,
    })
    if (makePrimary) {
      await transaction.contact.update({
        where: { id: contactId },
        data: { primaryPhoneId: created.id },
      })
    }
    if (verify) await assertContactOwnershipPostconditions(transaction, scope)
    return { kind: 'added', phoneId: created.id, contactId }
  }

  /** Add/reactivate one phone after authoritative admitted ownership checks. */
  static async addPhoneToContact(
    contactId: string,
    phone: string,
    opts?: {
      isTemporary?: boolean
      expiresAt?: Date | null
      source?: 'manual' | 'avito' | 'whatsapp' | 'telegram' | 'max' | 'phone' | 'yandex'
      label?: string | null
      makePrimary?: boolean
      deactivateTemporaries?: boolean
      reactivateExisting?: boolean
    },
  ) {
    const normalized = normalizePhoneE164(phone)
    if (!normalized) throw new Error('Invalid phone number')

    return runContactOwnershipTransaction(async transaction => {
      const scope = await lockContactOwnershipRows(transaction, {
        contactIds: [contactId],
        normalizedPhones: [normalized],
      })
      return this.addPhoneInAdmittedTransaction(transaction, scope, contactId, normalized, opts)
    })
  }

  /**
   * Attach a provider-confirmed phone to an existing channel identity without
   * stealing a phone owned by another contact.
   */
  static async attachPhoneToIdentity(
    contactId: string,
    identityId: string,
    phone: string,
    opts?: {
      source?: 'manual' | 'avito' | 'whatsapp' | 'telegram' | 'max' | 'phone' | 'yandex'
      confirmed?: boolean
    },
  ): Promise<
    | { kind: 'added' | 'exists_same_contact'; phoneId: string; contactId: string }
    | { kind: 'conflict'; otherContactId: string; otherContactName: string }
  > {
    const normalized = normalizePhoneE164(phone)
    if (!normalized) throw new Error('Invalid phone number')

    return runContactOwnershipTransaction(async transaction => {
      const scope = await lockContactOwnershipRows(transaction, {
        contactIds: [contactId],
        identityIds: [identityId],
        normalizedPhones: [normalized],
      })
      const [identity, contact] = await Promise.all([
        transaction.contactIdentity.findUnique({
        where: { id: identityId },
        select: {
          id: true,
          contactId: true,
          externalId: true,
          phoneId: true,
          reachabilityStatus: true,
          channel: true,
          metadata: true,
          phone: { select: { phone: true, isActive: true, isPrimary: true, verifiedAt: true } },
        },
      }),
        transaction.contact.findUnique({
        where: { id: contactId },
        select: {
          id: true,
          displayName: true,
          displayNameSource: true,
          primaryPhoneId: true,
          customFields: true,
        },
      }),
      ])

    if (!identity || identity.contactId !== contactId) {
      throw new Error(`Identity ${identityId} does not belong to contact ${contactId}`)
    }
    if (!contact) throw new Error(`Contact ${contactId} not found`)

    const makePrimary = !contact.primaryPhoneId
    const updateTechnicalName = contact.displayNameSource === 'channel'
      && isTechnicalChannelName(contact.displayName, identity.externalId)
      && contact.displayName !== normalized

    if (
      identity.phoneId
      && identity.phone?.phone === normalized
      && identity.phone.isActive
      && (!makePrimary || identity.phone.isPrimary)
      && (!opts?.confirmed || (
        identity.reachabilityStatus === 'confirmed'
        && !!identity.phone.verifiedAt
      ))
      && !updateTechnicalName
    ) {
      return { kind: 'exists_same_contact', phoneId: identity.phoneId, contactId }
    }

      const result = await this.addPhoneInAdmittedTransaction(
        transaction,
        scope,
        contactId,
        normalized,
        {
          source: opts?.source ?? 'manual',
          makePrimary,
        },
        false,
      )

      if (result.kind === 'conflict') {
        await persistStableIdentityPhoneConflict(transaction, {
          contactId,
          contactCustomFields: contact.customFields,
          identity,
          normalizedPhone: normalized,
          otherContactId: result.otherContactId,
        })
        await assertContactOwnershipPostconditions(transaction, scope)
        return result
      }

    const now = new Date()
      if (makePrimary || updateTechnicalName) {
        await transaction.contact.update({
          where: { id: contactId },
          data: {
            ...(makePrimary ? { primaryPhoneId: result.phoneId } : {}),
            ...(updateTechnicalName ? { displayName: normalized } : {}),
          },
        })
      }
      await transaction.contactIdentity.update({
        where: { id: identityId },
        data: {
          phoneId: result.phoneId,
          ...(opts?.confirmed ? {
            reachabilityStatus: 'confirmed',
            reachabilityCheckedAt: now,
          } : {}),
        },
      })
      const attachedPhone = await transaction.contactPhone.update({
        where: { id: result.phoneId },
        data: {
          isActive: true,
          ...(opts?.confirmed ? {
            verifiedAt: now,
          } : {}),
          ...(makePrimary ? { isPrimary: true } : {}),
        },
      })
      await storePhoneEvidence(transaction, attachedPhone, {
        lifecycle: 'current',
        freshness: 'fresh',
        lastSeenAt: now.toISOString(),
        lifecycleUpdatedAt: now.toISOString(),
        ...(opts?.confirmed ? {
          verifiedBy: 'system:provider-confirmation',
          verificationBasis: opts.source ?? 'provider',
          trust: opts.source === 'manual' ? 'manually_verified' : 'provider_bound',
          resolutionState: 'unique',
          evidenceRoot: `${opts.source ?? 'provider'}:${normalized}`,
        } : {}),
      })
      await assertContactOwnershipPostconditions(transaction, scope)
    console.log(
      `[ContactService] Attached phone ${normalized} to identity=${identityId} `
      + `contact=${contactId} primary=${makePrimary}`,
    )
    return result
    })
  }

  static async deactivateContactPhone(contactPhoneId: string, expectedContactId?: string): Promise<boolean> {
    return runContactOwnershipTransaction(async transaction => {
      const scope = await lockContactOwnershipRows(transaction, {
        contactIds: expectedContactId ? [expectedContactId] : [],
        phoneIds: [contactPhoneId],
      })
      const phone = await transaction.contactPhone.findUnique({ where: { id: contactPhoneId } })
      if (!phone || !phone.isActive || (expectedContactId && phone.contactId !== expectedContactId)) {
        return false
      }
      const removed = await transaction.contactPhone.update({
        where: { id: phone.id },
        data: {
          isActive: false,
          isPrimary: false,
        },
      })
      await storePhoneEvidence(transaction, removed, {
        lifecycle: 'removed',
        freshness: 'stale',
        lifecycleUpdatedAt: new Date().toISOString(),
      })
      await transaction.contact.updateMany({
        where: { id: phone.contactId, primaryPhoneId: phone.id },
        data: { primaryPhoneId: null },
      })
      await assertContactOwnershipPostconditions(transaction, scope)
      return true
    })
  }

  static async setPrimaryContactPhone(contactId: string, phoneId: string): Promise<boolean> {
    return runContactOwnershipTransaction(async transaction => {
      const scope = await lockContactOwnershipRows(transaction, {
        contactIds: [contactId],
        phoneIds: [phoneId],
      })
      const phone = await transaction.contactPhone.findFirst({
        where: { id: phoneId, contactId, isActive: true },
        include: { contact: { select: { customFields: true } } },
      })
      if (!phone || phoneEvidenceState(phone.contact.customFields, phone.id, phone).lifecycle !== 'current') {
        return false
      }
      await transaction.contactPhone.updateMany({
        where: { contactId, isPrimary: true, NOT: { id: phoneId } },
        data: { isPrimary: false },
      })
      await transaction.contactPhone.update({ where: { id: phoneId }, data: { isPrimary: true } })
      await transaction.contact.update({ where: { id: contactId }, data: { primaryPhoneId: phoneId } })
      await assertContactOwnershipPostconditions(transaction, scope)
      return true
    })
  }

  static async patchContact(
    contactId: string,
    data: Prisma.ContactUncheckedUpdateInput,
  ) {
    return runContactOwnershipTransaction(async transaction => {
      const requestedPrimary = Object.prototype.hasOwnProperty.call(data, 'primaryPhoneId')
        ? data.primaryPhoneId
        : undefined
      const primaryPhoneId = typeof requestedPrimary === 'string' ? requestedPrimary : null
      const scope = await lockContactOwnershipRows(transaction, {
        contactIds: [contactId],
        phoneIds: primaryPhoneId ? [primaryPhoneId] : [],
        yandexDriverIds: typeof data.yandexDriverId === 'string' ? [data.yandexDriverId] : [],
      })
      const contact = await transaction.contact.findUnique({ where: { id: contactId } })
      if (!contact || contact.isArchived) return null

      if (requestedPrimary !== undefined) {
        if (primaryPhoneId) {
          const phone = await transaction.contactPhone.findFirst({
            where: { id: primaryPhoneId, contactId, isActive: true },
          })
          if (!phone) return false
          await transaction.contactPhone.updateMany({
            where: { contactId, isPrimary: true, NOT: { id: primaryPhoneId } },
            data: { isPrimary: false },
          })
          await transaction.contactPhone.update({
            where: { id: primaryPhoneId },
            data: { isPrimary: true },
          })
        } else {
          await transaction.contactPhone.updateMany({
            where: { contactId, isPrimary: true },
            data: { isPrimary: false },
          })
        }
      }

      const updated = await transaction.contact.update({ where: { id: contactId }, data })
      await assertContactOwnershipPostconditions(transaction, scope)
      return updated
    })
  }

  static async createFleetContact(input: Prisma.ContactUncheckedCreateInput) {
    return runContactOwnershipTransaction(async transaction => {
      const scope = await lockContactOwnershipRows(transaction, {
        yandexDriverIds: typeof input.yandexDriverId === 'string' ? [input.yandexDriverId] : [],
      })
      const created = await transaction.contact.create({ data: input })
      await assertContactOwnershipPostconditions(transaction, {
        ...scope,
        contactIds: [...new Set([...scope.contactIds, created.id])].sort(),
      })
      return created
    })
  }

  /** One admitted ownership transaction for a provider payload already fetched by Fleet. */
  static async reconcileFleetContactOwnership(input: {
    yandexDriverId: string
    fullName: string
    phone: string | null
  }): Promise<FleetContactOwnershipReconciliationResult> {
    const normalized = input.phone ? normalizePhoneE164(input.phone) : null
    const execute = (): Promise<FleetContactOwnershipReconciliationResult> => (
      runContactOwnershipTransaction(async transaction => {
      let scope = await lockContactOwnershipRows(transaction, {
        normalizedPhones: normalized ? [normalized] : [],
        yandexDriverIds: [input.yandexDriverId],
      })
      const activePhoneRows = normalized
        ? await transaction.contactPhone.findMany({
            where: {
              phone: normalized,
              isActive: true,
            },
            include: { contact: true },
            orderBy: { id: 'asc' },
          })
        : []
      const activeOwners = activePhoneRows.filter(isTrustedUniqueCurrentPhone)
      const ownerContactIds = new Set(activeOwners.map(owner => owner.contactId))

      const existing = await transaction.contact.findUnique({
        where: { yandexDriverId: input.yandexDriverId },
        include: {
          phones: {
            where: { isActive: true, source: 'yandex' },
            orderBy: [{ isPrimary: 'desc' }, { id: 'asc' }],
          },
        },
      })

      if (ownerContactIds.size > 1) {
        return {
          action: existing ? 'ambiguous_phone_owner' : 'ambiguous',
          phonesDeactivated: 0,
          phonesCreated: 0,
        }
      }

      if (existing) {
        const otherOwner = activeOwners.find(owner => owner.contactId !== existing.id)
        if (otherOwner) {
          return { action: 'ambiguous_phone_owner', phonesDeactivated: 0, phonesCreated: 0 }
        }
        const updates: Prisma.ContactUncheckedUpdateInput = {}
        if (existing.displayNameSource === 'yandex' && existing.displayName !== input.fullName) {
          updates.displayName = input.fullName
        }
        let deactivated = 0
        let created = 0
        const currentYandexPhone = existing.phones[0]

        if (normalized) {
          let same = (currentYandexPhone?.phone === normalized
            ? currentYandexPhone
            : activeOwners.find(owner => owner.contactId === existing.id))
            ?? await transaction.contactPhone.findUnique({
                where: { contactId_phone: { contactId: existing.id, phone: normalized } },
              })
          if (currentYandexPhone && currentYandexPhone.phone !== normalized) {
            const historical = await transaction.contactPhone.update({
              where: { id: currentYandexPhone.id },
              data: { isActive: false, isPrimary: false },
            })
            await storePhoneEvidence(transaction, historical, {
              lifecycle: 'superseded',
              freshness: 'stale',
              lifecycleUpdatedAt: new Date().toISOString(),
            })
            deactivated += 1
          }
          if (!same) {
            same = await transaction.contactPhone.create({
              data: {
                contactId: existing.id,
                phone: normalized,
                source: 'yandex',
                isPrimary: !existing.primaryPhoneId || existing.primaryPhoneId === currentYandexPhone?.id,
              },
            })
            const observedAt = new Date().toISOString()
            await storePhoneEvidence(transaction, same, {
              rawPhone: normalized,
              lifecycle: 'current',
              trust: 'provider_bound',
              freshness: 'fresh',
              resolutionState: 'unique',
              observedAt,
              lastSeenAt: observedAt,
              lifecycleUpdatedAt: observedAt,
              evidenceRoot: `yandex:${input.yandexDriverId}:${normalized}`,
            })
            created += 1
          } else if (same.isActive === false) {
            same = await transaction.contactPhone.update({
              where: { id: same.id },
              data: {
                isActive: true,
                source: 'yandex',
              },
            })
            await storePhoneEvidence(transaction, same, {
              lifecycle: 'current',
              trust: 'provider_bound',
              freshness: 'fresh',
              resolutionState: 'unique',
              lastSeenAt: new Date().toISOString(),
              lifecycleUpdatedAt: new Date().toISOString(),
              evidenceRoot: `yandex:${input.yandexDriverId}:${normalized}`,
            })
          }
          const shouldPromote = !existing.primaryPhoneId
            || (
              existing.primaryPhoneId === currentYandexPhone?.id
              && currentYandexPhone.id !== same.id
            )
          if (shouldPromote) {
            await transaction.contactPhone.updateMany({
              where: { contactId: existing.id, isPrimary: true, NOT: { id: same.id } },
              data: { isPrimary: false },
            })
            await transaction.contactPhone.update({ where: { id: same.id }, data: { isPrimary: true } })
            updates.primaryPhoneId = same.id
          }
        }
        if (Object.keys(updates).length > 0) {
          await transaction.contact.update({ where: { id: existing.id }, data: updates })
        }
        await assertContactOwnershipPostconditions(transaction, scope)
        return {
          action: Object.keys(updates).length > 0 || deactivated > 0 || created > 0 ? 'updated' : 'noop',
          phonesDeactivated: deactivated,
          phonesCreated: created,
        }
      }

      const owner = activeOwners[0]
      if (owner) {
        if (owner.contact.yandexDriverId && owner.contact.yandexDriverId !== input.yandexDriverId) {
          return { action: 'noop', phonesDeactivated: 0, phonesCreated: 0 }
        }
        await transaction.contact.update({
          where: { id: owner.contactId },
          data: {
            yandexDriverId: input.yandexDriverId,
            masterSource: 'yandex',
            ...(owner.contact.displayNameSource !== 'manual'
              ? { displayName: input.fullName, displayNameSource: 'yandex' as const }
              : {}),
            ...(!owner.contact.primaryPhoneId ? { primaryPhoneId: owner.id } : {}),
          },
        })
        if (!owner.contact.primaryPhoneId) {
          await transaction.contactPhone.updateMany({
            where: { contactId: owner.contactId, isPrimary: true, NOT: { id: owner.id } },
            data: { isPrimary: false },
          })
          await transaction.contactPhone.update({ where: { id: owner.id }, data: { isPrimary: true } })
        }
        await assertContactOwnershipPostconditions(transaction, scope)
        return { action: 'linked', phonesDeactivated: 0, phonesCreated: 0 }
      }

      let createdContact: { id: string; primaryPhoneId: string | null }
      try {
        createdContact = await transaction.contact.create({
          data: {
            displayName: input.fullName,
            displayNameSource: 'yandex',
            masterSource: 'yandex',
            yandexDriverId: input.yandexDriverId,
          },
          select: { id: true, primaryPhoneId: true },
        })
      } catch (error: unknown) {
        if ((error as { code?: string })?.code === 'P2002') {
          throw new FleetContactCreateConflictError(error)
        }
        throw error
      }
      let createdPhoneId: string | null = null
      if (normalized) {
        const createdPhone = await transaction.contactPhone.create({
          data: {
            contactId: createdContact.id,
            phone: normalized,
            source: 'yandex',
            isPrimary: true,
          },
        })
        const observedAt = new Date().toISOString()
        await storePhoneEvidence(transaction, createdPhone, {
          rawPhone: normalized,
          lifecycle: 'current',
          trust: 'provider_bound',
          freshness: 'fresh',
          resolutionState: 'unique',
          observedAt,
          lastSeenAt: observedAt,
          lifecycleUpdatedAt: observedAt,
          evidenceRoot: `yandex:${input.yandexDriverId}:${normalized}`,
        })
        createdPhoneId = createdPhone.id
        await transaction.contact.update({
          where: { id: createdContact.id },
          data: { primaryPhoneId: createdPhone.id },
        })
      }
      scope = {
        ...scope,
        contactIds: [...new Set([...scope.contactIds, createdContact.id])].sort(),
      }
      await assertContactOwnershipPostconditions(transaction, scope)
      return {
        action: 'created',
        phonesDeactivated: 0,
        phonesCreated: createdPhoneId ? 1 : 0,
      }
      }, { transactionTimeoutMs: 15_000 })
    )
    try {
      return await execute()
    } catch (error: unknown) {
      const contactCreateConflict = error instanceof FleetContactCreateConflictError
      if (!contactCreateConflict && (error as { code?: string })?.code !== 'P2002') throw error
      // Compatibility retry starts from a new admitted transaction and redoes
      // every authoritative read; failed-attempt state is never reused.
      const recovered = await execute()
      if (
        contactCreateConflict
        && (recovered.action === 'updated' || recovered.action === 'noop')
      ) {
        return { ...recovered, action: 'created' }
      }
      return recovered
    }
  }

  static async markTemporaryContactPhone(input: {
    contactId: string
    phone: string
    expiresAt: Date
    label?: string | null
  }): Promise<number> {
    const normalized = normalizePhoneE164(input.phone)
    if (!normalized) return 0
    return runContactOwnershipTransaction(async transaction => {
      const scope = await lockContactOwnershipRows(transaction, {
        contactIds: [input.contactId],
        normalizedPhones: [normalized],
      })
      const result = await transaction.contactPhone.updateMany({
        where: { contactId: input.contactId, phone: normalized, isTemporary: false },
        data: { isTemporary: true, expiresAt: input.expiresAt, label: input.label },
      })
      await assertContactOwnershipPostconditions(transaction, scope)
      return result.count
    })
  }

  static async expireTemporaryContactPhones(before = new Date(), limit = 100): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 512) {
      throw new TypeError('Temporary phone expiry limit must be between 1 and 512')
    }
    return runContactOwnershipTransaction(async transaction => {
      const candidates = await transaction.contactPhone.findMany({
        where: { isTemporary: true, isActive: true, expiresAt: { lt: before } },
        orderBy: { id: 'asc' },
        take: limit,
        select: { id: true },
      })
      if (candidates.length === 0) return 0
      const scope = await lockContactOwnershipRows(transaction, {
        phoneIds: candidates.map(candidate => candidate.id),
      })
      const authoritative = await transaction.contactPhone.findMany({
        where: {
          id: { in: candidates.map(candidate => candidate.id) },
          isTemporary: true,
          isActive: true,
          expiresAt: { lt: before },
        },
        select: { id: true, contactId: true },
      })
      const ids = authoritative.map(candidate => candidate.id)
      if (ids.length === 0) return 0
      await transaction.contactPhone.updateMany({
        where: { id: { in: ids } },
        data: { isActive: false, isPrimary: false },
      })
      for (const candidate of authoritative) {
        const phone = await transaction.contactPhone.findUnique({ where: { id: candidate.id } })
        if (phone) {
          await storePhoneEvidence(transaction, phone, {
            lifecycle: 'removed',
            freshness: 'stale',
            lifecycleUpdatedAt: new Date().toISOString(),
          })
        }
        await transaction.contact.updateMany({
          where: { id: candidate.contactId, primaryPhoneId: candidate.id },
          data: { primaryPhoneId: null },
        })
      }
      await assertContactOwnershipPostconditions(transaction, scope)
      return ids.length
    })
  }

  static async deleteContactForRetention(
    contactId: string,
  ): Promise<'deleted' | 'missing' | 'ineligible'> {
    return runContactOwnershipTransaction(async transaction => {
      const scope = await lockContactOwnershipRows(transaction, { contactIds: [contactId] })
      const contact = await transaction.contact.findUnique({
        where: { id: contactId },
        select: { id: true },
      })
      if (!contact) return 'missing'

      // Fixed v1 policy: repeat every Contacts-owned retention predicate only
      // after CNT1 admission. Foreign-owner preflight/preparation remains in
      // RetentionCleanup and no foreign table is mutated here.
      const eligible = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT contact.id FROM "Contact" AS contact
        WHERE contact.id = ${contactId}
          AND contact."isArchived" = true
          AND contact."updatedAt" < (NOW() AT TIME ZONE 'UTC') - INTERVAL '365 days'
          AND NOT EXISTS (
            SELECT 1 FROM "ContactMerge" AS edge
            WHERE edge."survivorId" = contact.id OR edge."mergedId" = contact.id
          )
        LIMIT 1
      `)
      if (!eligible[0]) return 'ineligible'

      await transaction.contact.deleteMany({ where: { id: contactId } })
      await assertContactOwnershipPostconditions(transaction, scope)
      return 'deleted'
    })
  }

  /**
   * Cleanup dangling ContactIdentities after channel data deletion.
   * Scoped: only checks identities belonging to the specified contactIds.
   *
   * A ContactIdentity is "dangling" if no Chat references it via contactIdentityId.
   *
   * Returns: number of deleted identities.
   */
  static async cleanupDanglingIdentities(contactIds: string[]): Promise<number> {
    if (contactIds.length === 0) return 0

    const result = await runContactOwnershipTransaction(async transaction => {
      const scope = await lockContactOwnershipRows(transaction, { contactIds })
      const referenced = await transaction.chat.findMany({
        where: { contactIdentityId: { in: scope.identityIds } },
        select: { contactIdentityId: true },
      })
      const deleted = await transaction.contactIdentity.deleteMany({
        where: {
          contactId: { in: contactIds },
          id: { notIn: referenced.flatMap(row => row.contactIdentityId ? [row.contactIdentityId] : []) },
        },
      })
      await assertContactOwnershipPostconditions(transaction, scope)
      return deleted.count
    })
    if (result > 0) {
      console.log(`[ContactService] Cleaned up ${result} dangling identities for ${contactIds.length} contacts`)
    }
    return result
  }
}
