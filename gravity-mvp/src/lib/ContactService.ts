import { prisma } from '@/lib/prisma'
import { ChatChannel, ContactPhoneSource, Prisma } from '@prisma/client'
import { normalizePhoneE164 } from '@/lib/phoneUtils'
import type { PhoneEvidenceSource } from '@/lib/contacts/contact-resolution.types'
import { resolveStrictPhoneOwnership } from '@/lib/contacts/strict-phone-ownership'

export type ProviderPhoneOwnership =
  | 'not_provided'
  | 'untrusted'
  | 'not_found'
  | 'matched'
  | 'conflict'
  | 'ambiguous'

export type ResolveContactOptions = {
  phoneEvidence?: {
    source: PhoneEvidenceSource
    trustedForAutomaticResolution: boolean
    observedAt?: Date | string
    providerIdentityId?: string | null
    protocolChatId?: string | null
    uiRouteId?: string | null
    trustResult?: string | null
  } | null
  ambiguousPhone?: 'provider_only' | 'reject'
}

export interface ResolveResult {
  contact: { id: string; displayName: string }
  identity: { id: string; channel: ChatChannel; externalId: string }
  isNew: boolean
  resolutionStatus:
    | 'identity_found'
    | 'phone_matched'
    | 'contact_created'
    | 'provider_only_ambiguous'
    | 'provider_only_untrusted'
  phoneOwnership: ProviderPhoneOwnership
}

export function classifyProviderPhoneOwners(
  records: Array<{ contactId: string; isArchived?: boolean }>,
): { kind: 'not_found' } | { kind: 'matched'; contactId: string } | { kind: 'ambiguous'; contactIds: string[] } {
  const contactIds = [...new Set(records.map(record => record.contactId))].sort()
  if (contactIds.length === 0) return { kind: 'not_found' }
  if (records.some(record => record.isArchived)) return { kind: 'ambiguous', contactIds }
  if (contactIds.length === 1) return { kind: 'matched', contactId: contactIds[0] }
  return { kind: 'ambiguous', contactIds }
}

const MAX_RETRIES = 2

function isPrismaErrorWithCode(value: unknown, code: string): boolean {
  return typeof value === 'object'
    && value !== null
    && 'code' in value
    && (value as { code?: unknown }).code === code
}

function phoneSourceForChannel(channel: ChatChannel): ContactPhoneSource {
  switch (channel) {
    case ChatChannel.telegram:
      return ContactPhoneSource.telegram
    case ChatChannel.whatsapp:
      return ContactPhoneSource.whatsapp
    case ChatChannel.max:
      return ContactPhoneSource.max
    case ChatChannel.phone:
      return ContactPhoneSource.phone
    case ChatChannel.avito:
      return ContactPhoneSource.avito
  }
}

function defaultPhoneEvidence(
  channel: ChatChannel,
  externalId: string,
  normalizedPhone: string | null,
): NonNullable<ResolveContactOptions['phoneEvidence']> | null {
  if (!normalizedPhone) return null
  if (channel === ChatChannel.whatsapp) {
    const identityDigits = externalId.split('@')[0]?.replace(/\D/g, '') || ''
    const phoneDigits = normalizedPhone.replace(/\D/g, '')
    const trusted = identityDigits.length >= 10 && identityDigits.slice(-10) === phoneDigits.slice(-10)
    return {
      source: trusted ? 'whatsapp_phone_jid' : 'unknown',
      trustedForAutomaticResolution: trusted,
    }
  }
  if (channel === ChatChannel.avito || channel === ChatChannel.phone) {
    return { source: 'manual_verified', trustedForAutomaticResolution: true }
  }
  return { source: 'unknown', trustedForAutomaticResolution: false }
}

function metadataRecord(value: Prisma.JsonValue | null | undefined): Record<string, Prisma.JsonValue> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, Prisma.JsonValue>
    : {}
}

function withPhoneEvidenceMetadata(
  metadata: Prisma.JsonValue | null | undefined,
  normalizedPhone: string | null,
  externalId: string,
  evidence: NonNullable<ResolveContactOptions['phoneEvidence']> | null,
  result: ProviderPhoneOwnership,
): Prisma.InputJsonValue {
  if (!normalizedPhone || !evidence) return metadataRecord(metadata) as Prisma.InputJsonValue
  const observedAt = evidence.observedAt instanceof Date
    ? evidence.observedAt.toISOString()
    : evidence.observedAt || new Date().toISOString()
  return {
    ...metadataRecord(metadata),
    phoneEvidence: {
      normalizedPhone,
      sourceKind: evidence.source,
      observedAt,
      providerIdentity: externalId,
      providerIdentityId: evidence.providerIdentityId || null,
      protocolChatId: evidence.protocolChatId || null,
      uiRouteId: evidence.uiRouteId || null,
      trustResult: evidence.trustResult || null,
      trustedForAutomaticResolution: evidence.trustedForAutomaticResolution,
      result,
    },
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
    options: ResolveContactOptions = {},
  ): Promise<ResolveResult> {
    const normalized = phone ? normalizePhoneE164(phone) : null
    const phoneEvidence = options.phoneEvidence === undefined
      ? defaultPhoneEvidence(channel, externalId, normalized)
      : options.phoneEvidence

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await prisma.$transaction(async tx => {
          if (normalized) {
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`contact-phone:${normalized}`}))`
          }
          return this._resolve(
            tx,
            channel,
            externalId,
            normalized,
            displayName || null,
            phoneEvidence,
            options.ambiguousPhone ?? 'provider_only',
          )
        }, {
          isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
          timeout: 15000,
        })
      } catch (e: unknown) {
        // P2002 = unique constraint violation (race condition)
        if (isPrismaErrorWithCode(e, 'P2002') && attempt < MAX_RETRIES) {
          console.log(`[ContactService] Retry ${attempt + 1}/${MAX_RETRIES} after unique constraint violation`)
          continue
        }
        throw e
      }
    }

    // Unreachable, but TypeScript needs it
    throw new Error('[ContactService] Max retries exceeded')
  }

  private static async _resolve(
    db: Prisma.TransactionClient,
    channel: ChatChannel,
    externalId: string,
    normalized: string | null,
    displayName: string | null,
    phoneEvidence: NonNullable<ResolveContactOptions['phoneEvidence']> | null,
    ambiguousPhone: 'provider_only' | 'reject',
  ): Promise<ResolveResult> {

    // ── Scenario 1: Identity already exists ──────────────────────────────
    const existingIdentity = await db.contactIdentity.findUnique({
      where: { channel_externalId: { channel, externalId } },
      include: { contact: { select: { id: true, displayName: true, isArchived: true } } },
    })
    const trustedPhone = Boolean(normalized && phoneEvidence?.trustedForAutomaticResolution)

    if (existingIdentity) {
      let phoneOwnership: ProviderPhoneOwnership = normalized ? 'not_found' : 'not_provided'

      if (normalized && existingIdentity.contact.isArchived) {
        phoneOwnership = 'ambiguous'
      } else if (normalized && !trustedPhone) {
        phoneOwnership = 'untrusted'
      } else if (normalized) {
        const ownership = await resolveStrictPhoneOwnership(db, normalized)

        if (ownership.kind === 'ambiguous') {
          if (ambiguousPhone === 'reject') throw new Error('PHONE_OWNERSHIP_AMBIGUOUS')
          phoneOwnership = 'ambiguous'
        } else if (ownership.kind === 'matched' && ownership.contactId !== existingIdentity.contactId) {
          if (ambiguousPhone === 'reject') throw new Error('PHONE_IDENTITY_CONFLICT')
          phoneOwnership = 'conflict'
        } else {
          let phoneId = ownership.kind === 'matched'
            ? (await db.contactPhone.findUnique({
                where: {
                  contactId_phone: {
                    contactId: existingIdentity.contactId,
                    phone: normalized,
                  },
                },
                select: { id: true },
              }))?.id || null
            : null

          if (!phoneId) {
            const inactivePhone = await db.contactPhone.findUnique({
              where: { contactId_phone: { contactId: existingIdentity.contactId, phone: normalized } },
              select: { id: true, isActive: true },
            })
            if (inactivePhone) {
              if (!inactivePhone.isActive) {
                await db.contactPhone.update({
                  where: { id: inactivePhone.id },
                  data: { isActive: true },
                })
              }
              phoneId = inactivePhone.id
            } else {
              const createdPhone = await db.contactPhone.create({
                data: {
                  contactId: existingIdentity.contactId,
                  phone: normalized,
                  source: phoneSourceForChannel(channel),
                  isPrimary: false,
                },
              })
              phoneId = createdPhone.id
            }
          }

          if (!existingIdentity.phoneId && phoneId) {
            await db.contactIdentity.update({
              where: { id: existingIdentity.id },
              data: { phoneId },
            })
          }
          phoneOwnership = 'matched'
        }
      }
      if (normalized && phoneEvidence) {
        await db.contactIdentity.update({
          where: { id: existingIdentity.id },
          data: {
            metadata: withPhoneEvidenceMetadata(existingIdentity.metadata, normalized, externalId, phoneEvidence, phoneOwnership),
          },
        })
      }

      console.log(`[ContactService] Resolved via identity: contact=${existingIdentity.contactId} channel=${channel} externalId=${externalId}`)
      return {
        contact: existingIdentity.contact,
        identity: { id: existingIdentity.id, channel: existingIdentity.channel, externalId: existingIdentity.externalId },
        isNew: false,
        resolutionStatus: 'identity_found',
        phoneOwnership,
      }
    }

    // ── Scenario 2: Phone match → create Identity on existing Contact ────
    if (normalized && trustedPhone) {
      const ownership = await resolveStrictPhoneOwnership(db, normalized)

      if (ownership.kind === 'matched') {
        const phoneRecord = await db.contactPhone.findUnique({
          where: { contactId_phone: { contactId: ownership.contactId, phone: normalized } },
          include: { contact: { select: { id: true, displayName: true, isArchived: true } } },
        })
        if (!phoneRecord || phoneRecord.contact.isArchived) throw new Error('PHONE_OWNER_NOT_ACTIVE')
        const identity = await db.contactIdentity.create({
          data: {
            contactId: phoneRecord.contactId,
            channel,
            externalId,
            phoneId: phoneRecord.id,
            displayName,
            source: 'auto',
            confidence: 1.0,
            metadata: withPhoneEvidenceMetadata(null, normalized, externalId, phoneEvidence, 'matched'),
          },
        })

        console.log(`[ContactService] Created identity via phone match: contact=${phoneRecord.contactId} identity=${identity.id} phone=${normalized}`)
        return {
          contact: phoneRecord.contact,
          identity: { id: identity.id, channel, externalId },
          isNew: false,
          resolutionStatus: 'phone_matched',
          phoneOwnership: 'matched',
        }
      }

      if (ownership.kind === 'ambiguous') {
        if (ambiguousPhone === 'reject') throw new Error('PHONE_OWNERSHIP_AMBIGUOUS')
        const contactDisplayName = displayName || externalId
        const contact = await db.contact.create({
          data: {
            displayName: contactDisplayName,
            displayNameSource: 'channel',
            masterSource: 'chat',
          },
        })
        const identity = await db.contactIdentity.create({
          data: {
            contactId: contact.id,
            channel,
            externalId,
            phoneId: null,
            displayName,
            source: 'auto',
            confidence: 1.0,
            metadata: {
              observedPhone: normalized,
              phoneOwnership: 'ambiguous',
              candidateContactIds: ownership.contactIds,
              phoneEvidence: {
                normalizedPhone: normalized,
                sourceKind: phoneEvidence?.source || 'unknown',
                observedAt: new Date().toISOString(),
                providerIdentity: externalId,
                trustedForAutomaticResolution: true,
                result: 'ambiguous',
              },
            },
          },
        })
        console.warn(`[ContactService] Ambiguous phone ownership: provider-only contact=${contact.id} phone=${normalized} candidates=${ownership.contactIds.join(',')}`)
        return {
          contact: { id: contact.id, displayName: contactDisplayName },
          identity: { id: identity.id, channel, externalId },
          isNew: true,
          resolutionStatus: 'provider_only_ambiguous',
          phoneOwnership: 'ambiguous',
        }
      }
    }

    // ── Scenario 3 & 4: Create new Contact ───────────────────────────────
    const contactDisplayName = displayName || normalized || externalId

    const contact = await db.contact.create({
      data: {
        displayName: contactDisplayName,
        displayNameSource: 'channel',
        masterSource: 'chat',
      },
    })

    let phoneId: string | null = null

    // Only trusted provider evidence may become ContactPhone automatically.
    if (normalized && trustedPhone) {
      const newPhone = await db.contactPhone.create({
        data: {
          contactId: contact.id,
          phone: normalized,
          source: phoneSourceForChannel(channel),
          isPrimary: true,
        },
      })
      phoneId = newPhone.id

      await db.contact.update({
        where: { id: contact.id },
        data: { primaryPhoneId: newPhone.id },
      })
    }

    // Create ContactIdentity
    const identity = await db.contactIdentity.create({
      data: {
        contactId: contact.id,
        channel,
        externalId,
        phoneId,
        displayName,
        source: 'auto',
        confidence: 1.0,
        metadata: withPhoneEvidenceMetadata(
          null,
          normalized,
          externalId,
          phoneEvidence,
          normalized && trustedPhone ? 'not_found' : normalized ? 'untrusted' : 'not_provided',
        ),
      },
    })

    console.log(`[ContactService] Created new contact=${contact.id} identity=${identity.id} phone=${normalized || 'none'} name="${contactDisplayName}"`)
    return {
      contact: { id: contact.id, displayName: contactDisplayName },
      identity: { id: identity.id, channel, externalId },
      isNew: true,
      resolutionStatus: normalized && !trustedPhone ? 'provider_only_untrusted' : 'contact_created',
      phoneOwnership: normalized && trustedPhone
        ? 'not_found'
        : normalized ? 'untrusted' : 'not_provided',
    }
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
  ): Promise<{ contact: { id: string; displayName: string }; phoneId: string; isNew: boolean } | null> {
    const normalized = normalizePhoneE164(phone)
    if (!normalized) return null

    return prisma.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`contact-phone:${normalized}`}))`

      const ownership = await resolveStrictPhoneOwnership(tx, normalized)
      if (ownership.kind === 'matched') {
        const contact = await tx.contact.findUnique({
          where: { id: ownership.contactId },
          select: { id: true, displayName: true, isArchived: true },
        })
        const phoneRows = await tx.contactPhone.findMany({
          where: { phone: normalized, isActive: true },
          orderBy: { id: 'asc' },
          select: { id: true, contactId: true },
        })
        const phoneRow = phoneRows.find(record => record.contactId === ownership.contactId) ?? phoneRows[0]
        if (contact && !contact.isArchived && phoneRow) {
          return { contact, phoneId: phoneRow.id, isNew: false }
        }
      }
      if (ownership.kind === 'ambiguous') {
        console.warn(`[ContactService] Call phone ownership is ambiguous: phone=${normalized} contacts=${ownership.contactIds.join(',')}`)
        return null
      }

      const fallbackName = (displayName && displayName.trim()) || normalized
      const contact = await tx.contact.create({
        data: {
          displayName: fallbackName,
          displayNameSource: 'channel',
          masterSource: 'chat',
        },
      })
      const newPhone = await tx.contactPhone.create({
        data: {
          contactId: contact.id,
          phone: normalized,
          source: 'manual',
          isPrimary: true,
        },
      })
      await tx.contact.update({
        where: { id: contact.id },
        data: { primaryPhoneId: newPhone.id },
      })
      console.log(`[ContactService] Created contact via phone: contact=${contact.id} phone=${normalized}`)
      return {
        contact: { id: contact.id, displayName: fallbackName },
        phoneId: newPhone.id,
        isNew: true,
      }
    })
  }

  /**
   * Add a phone number to an existing Contact. Used both by the LeadIntake
   * service (when Avito-worker reveals the real number) and by the manual
   * "+ Add number" button in the contact profile drawer.
   *
   * Returns:
   *   - { kind: 'added', phoneId, contactId }                     — phone added cleanly
   *   - { kind: 'exists_same_contact', phoneId, contactId }       — already attached, no-op
   *   - { kind: 'conflict', otherContactId, otherContactName }    — phone belongs to a DIFFERENT contact;
   *                                                                  caller (UI) should prompt for merge
   *   - { kind: 'ambiguous', ownerContactIds }                    — multiple or archived owners;
   *                                                                  automatic attachment is blocked
   *
   * For Avito → real-phone transition LeadIntake should call this with
   * `deactivateTemporaries:true` so all the contact's temp Avito numbers go
   * inactive in the same transaction (the real number is now known, the
   * disposable ones are no longer useful and would only confuse merge later).
   */
  static async addPhoneToContact(
    contactId: string,
    phone: string,
    opts?: {
      isTemporary?: boolean
      expiresAt?: Date | null
      source?: 'manual' | 'avito' | 'whatsapp' | 'telegram' | 'phone' | 'yandex'
      label?: string | null
      makePrimary?: boolean
      deactivateTemporaries?: boolean
    },
  ): Promise<
    | { kind: 'added'; phoneId: string; contactId: string }
    | { kind: 'exists_same_contact'; phoneId: string; contactId: string }
    | { kind: 'conflict'; otherContactId: string; otherContactName: string }
    | { kind: 'ambiguous'; ownerContactIds: string[] }
  > {
    const normalized = normalizePhoneE164(phone)
    if (!normalized) throw new Error('Invalid phone number')

    return await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`contact-phone:${normalized}`}))`

      const target = await tx.contact.findUnique({
        where: { id: contactId },
        select: { id: true, isArchived: true },
      })
      if (!target || target.isArchived) {
        throw new Error('Cannot add a phone to a missing, archived, or merged Contact')
      }

      const same = await tx.contactPhone.findUnique({
        where: { contactId_phone: { contactId, phone: normalized } },
      })
      const ownership = await resolveStrictPhoneOwnership(tx, normalized)
      if (ownership.kind === 'ambiguous') {
        return {
          kind: 'ambiguous' as const,
          ownerContactIds: ownership.contactIds,
        }
      }
      if (ownership.kind === 'matched' && ownership.contactId !== contactId) {
        const otherOwner = await tx.contact.findUnique({
          where: { id: ownership.contactId },
          select: { id: true, displayName: true },
        })
        return {
          kind: 'conflict' as const,
          otherContactId: ownership.contactId,
          otherContactName: otherOwner?.displayName ?? 'Другой контакт',
        }
      }

      if (same) {
        if (!same.isActive) {
          await tx.contactPhone.update({
            where: { id: same.id },
            data: { isActive: true },
          })
        }
        return { kind: 'exists_same_contact' as const, phoneId: same.id, contactId }
      }

      if (opts?.deactivateTemporaries) {
        await tx.contactPhone.updateMany({
          where: { contactId, isTemporary: true, isActive: true },
          data: { isActive: false, isPrimary: false },
        })
      }
      // If this is the new primary, demote the previous one.
      if (opts?.makePrimary) {
        await tx.contactPhone.updateMany({
          where: { contactId, isPrimary: true },
          data: { isPrimary: false },
        })
      }
      const created = await tx.contactPhone.create({
        data: {
          contactId,
          phone: normalized,
          source: opts?.source ?? 'manual',
          label: opts?.label ?? null,
          isPrimary: opts?.makePrimary ?? false,
          isTemporary: opts?.isTemporary ?? false,
          expiresAt: opts?.expiresAt ?? null,
        },
      })
      if (opts?.makePrimary) {
        await tx.contact.update({
          where: { id: contactId },
          data: { primaryPhoneId: created.id },
        })
      }
      return { kind: 'added', phoneId: created.id, contactId }
    }, {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      timeout: 15000,
    })
  }

  /**
   * Ensure Chat has contactId, contactIdentityId, and driverId (if the
   * canonical Contact has a main DriverProfile). yandexDriverId remains only
   * as a legacy fallback for Contacts that predate multi-park profiles.
   */
  static async ensureChatLinked(chatId: string, contactId: string, identityId: string): Promise<void> {
    const updateData: Prisma.ChatUncheckedUpdateInput = {
      contactId,
      contactIdentityId: identityId,
    }

    // Auto-link driverId if Contact is linked to a Driver and Chat doesn't have driverId yet
    const chat = await prisma.chat.findUnique({
      where: { id: chatId },
      select: { driverId: true },
    })

    if (chat && !chat.driverId) {
      const contact = await prisma.contact.findUnique({
        where: { id: contactId },
        select: { mainDriverId: true, yandexDriverId: true },
      })

      if (contact?.mainDriverId) {
        const driver = await prisma.driver.findUnique({
          where: { id: contact.mainDriverId },
          select: { id: true },
        })
        if (driver) {
          updateData.driverId = driver.id
        }
      } else if (contact?.yandexDriverId) {
        const driver = await prisma.driver.findUnique({
          where: { yandexDriverId: contact.yandexDriverId },
          select: { id: true },
        })
        if (driver) updateData.driverId = driver.id
      }
    }

    await prisma.chat.update({
      where: { id: chatId },
      data: updateData,
    })
  }

  /**
   * Creates or reuses a provider identity for an explicitly selected Contact.
   * This is intentionally different from phone-based resolution: a manual
   * DriverProfile choice is the proof, so it never searches by name or adopts
   * a phone owner from another Contact.
   */
  static async ensureIdentityForContact(
    contactId: string,
    channel: ChatChannel,
    externalId: string,
    displayName?: string | null,
  ): Promise<{ contact: { id: string; displayName: string }; identity: { id: string; channel: ChatChannel; externalId: string } }> {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await prisma.$transaction(async tx => {
          const contact = await tx.contact.findUnique({
            where: { id: contactId },
            select: { id: true, displayName: true, isArchived: true },
          })
          if (!contact) throw new Error('CONTACT_NOT_FOUND')
          if (contact.isArchived) throw new Error('CONTACT_ARCHIVED')

          const existing = await tx.contactIdentity.findUnique({
            where: { channel_externalId: { channel, externalId } },
            select: { id: true, contactId: true, channel: true, externalId: true },
          })
          if (existing) {
            if (existing.contactId !== contactId) throw new Error('CONTACT_IDENTITY_CONFLICT')
            return {
              contact: { id: contact.id, displayName: contact.displayName },
              identity: { id: existing.id, channel: existing.channel, externalId: existing.externalId },
            }
          }

          const identity = await tx.contactIdentity.create({
            data: {
              contactId,
              channel,
              externalId,
              displayName: displayName || null,
              source: 'manual',
              confidence: 1,
            },
            select: { id: true, channel: true, externalId: true },
          })
          return {
            contact: { id: contact.id, displayName: contact.displayName },
            identity,
          }
        }, {
          isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
          timeout: 15000,
        })
      } catch (error: unknown) {
        if (isPrismaErrorWithCode(error, 'P2002') && attempt < MAX_RETRIES) continue
        throw error
      }
    }
    throw new Error('[ContactService] Max retries exceeded while creating ContactIdentity')
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

    const result = await prisma.$executeRaw`
      DELETE FROM "ContactIdentity"
      WHERE "contactId" = ANY(${contactIds}::text[])
        AND id NOT IN (
          SELECT "contactIdentityId" FROM "Chat"
          WHERE "contactIdentityId" IS NOT NULL
        )
    `
    if (result > 0) {
      console.log(`[ContactService] Cleaned up ${result} dangling identities for ${contactIds.length} contacts`)
    }
    return result
  }
}
