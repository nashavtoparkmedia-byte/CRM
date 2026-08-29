import { prisma } from '@/lib/prisma'
import { ChatChannel } from '@prisma/client'
import { normalizePhoneE164 } from '@/modules/contacts/public/v1/phone-identity'

interface ResolveResult {
  contact: { id: string; displayName: string }
  identity: { id: string; channel: ChatChannel; externalId: string }
  isNew: boolean
}

const MAX_RETRIES = 2

function isTechnicalChannelName(value: string | null | undefined, externalId: string): boolean {
  const name = String(value || '').trim()
  if (!name) return true
  if (name === externalId) return true
  if (/@(?:lid|c\.us|s\.whatsapp\.net)$/i.test(name)) return true
  if (/^(?:Контакт\s+)?WhatsApp$/i.test(name)) return true
  return /^\+?[\d\s()\-]{10,}$/.test(name)
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
  ): Promise<ResolveResult> {
    const normalized = phone ? normalizePhoneE164(phone) : null

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await this._resolve(channel, externalId, normalized, displayName || null)
      } catch (e: any) {
        // P2002 = unique constraint violation (race condition)
        if (e.code === 'P2002' && attempt < MAX_RETRIES) {
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
    channel: ChatChannel,
    externalId: string,
    normalized: string | null,
    displayName: string | null,
  ): Promise<ResolveResult> {

    // ── Scenario 1: Identity already exists ──────────────────────────────
    const existingIdentity = await prisma.contactIdentity.findUnique({
      where: { channel_externalId: { channel, externalId } },
      include: { contact: { select: { id: true, displayName: true } } },
    })

    if (existingIdentity) {
      if (normalized) {
        const phoneLink = await this.attachPhoneToIdentity(
          existingIdentity.contactId,
          existingIdentity.id,
          normalized,
          { source: channel, confirmed: channel === 'whatsapp' },
        )
        if (phoneLink.kind === 'conflict') {
          console.warn(
            `[ContactService] Identity/phone conflict: identity=${existingIdentity.id} `
            + `contact=${existingIdentity.contactId} phone=${normalized} owner=${phoneLink.otherContactId}`,
          )
        }
      }
      console.log(`[ContactService] Resolved via identity: contact=${existingIdentity.contactId} channel=${channel} externalId=${externalId}`)
      return {
        contact: existingIdentity.contact,
        identity: { id: existingIdentity.id, channel: existingIdentity.channel, externalId: existingIdentity.externalId },
        isNew: false,
      }
    }

    // ── Scenario 2: Phone match → create Identity on existing Contact ────
    if (normalized) {
      const phoneRecord = await prisma.contactPhone.findFirst({
        where: { phone: normalized, isActive: true },
        include: { contact: { select: { id: true, displayName: true } } },
      })

      if (phoneRecord) {
        const identity = await prisma.contactIdentity.create({
          data: {
            contactId: phoneRecord.contactId,
            channel,
            externalId,
            phoneId: phoneRecord.id,
            displayName,
            source: 'auto',
            confidence: 1.0,
          },
        })

        console.log(`[ContactService] Created identity via phone match: contact=${phoneRecord.contactId} identity=${identity.id} phone=${normalized}`)
        return {
          contact: phoneRecord.contact,
          identity: { id: identity.id, channel, externalId },
          isNew: false,
        }
      }
    }

    // ── Scenario 3 & 4: Create new Contact ───────────────────────────────
    const contactDisplayName = displayName || normalized || externalId

    const contact = await prisma.contact.create({
      data: {
        displayName: contactDisplayName,
        displayNameSource: 'channel',
        masterSource: 'chat',
      },
    })

    let phoneId: string | null = null

    // Create ContactPhone if phone is known
    if (normalized) {
      const newPhone = await prisma.contactPhone.create({
        data: {
          contactId: contact.id,
          phone: normalized,
          source: channel as any, // ChatChannel → ContactPhoneSource mapping
          isPrimary: true,
        },
      })
      phoneId = newPhone.id

      await prisma.contact.update({
        where: { id: contact.id },
        data: { primaryPhoneId: newPhone.id },
      })
    }

    // Create ContactIdentity
    const identity = await prisma.contactIdentity.create({
      data: {
        contactId: contact.id,
        channel,
        externalId,
        phoneId,
        displayName,
        source: 'auto',
        confidence: 1.0,
      },
    })

    console.log(`[ContactService] Created new contact=${contact.id} identity=${identity.id} phone=${normalized || 'none'} name="${contactDisplayName}"`)
    return {
      contact: { id: contact.id, displayName: contactDisplayName },
      identity: { id: identity.id, channel, externalId },
      isNew: true,
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

    // Skip expired temporary phones — Avito recycles its disposable numbers,
    // and an old temporary from a previous lead would otherwise mis-attach a
    // new call to the wrong Contact.
    const existing = await prisma.contactPhone.findFirst({
      where: {
        phone: normalized,
        isActive: true,
        OR: [
          { isTemporary: false },
          { isTemporary: true, expiresAt: null },
          { isTemporary: true, expiresAt: { gt: new Date() } },
        ],
      },
      include: { contact: { select: { id: true, displayName: true } } },
    })
    if (existing) {
      return { contact: existing.contact, phoneId: existing.id, isNew: false }
    }

    const fallbackName = (displayName && displayName.trim()) || normalized
    const contact = await prisma.contact.create({
      data: {
        displayName: fallbackName,
        displayNameSource: 'channel',
        masterSource: 'chat',
      },
    })
    const newPhone = await prisma.contactPhone.create({
      data: {
        contactId: contact.id,
        phone: normalized,
        source: 'manual',
        isPrimary: true,
      },
    })
    await prisma.contact.update({
      where: { id: contact.id },
      data: { primaryPhoneId: newPhone.id },
    })
    console.log(`[ContactService] Created contact via phone: contact=${contact.id} phone=${normalized}`)
    return {
      contact: { id: contact.id, displayName: fallbackName },
      phoneId: newPhone.id,
      isNew: true,
    }
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
      source?: 'manual' | 'avito' | 'whatsapp' | 'telegram' | 'max' | 'phone' | 'yandex'
      label?: string | null
      makePrimary?: boolean
      deactivateTemporaries?: boolean
    },
  ): Promise<
    | { kind: 'added'; phoneId: string; contactId: string }
    | { kind: 'exists_same_contact'; phoneId: string; contactId: string }
    | { kind: 'conflict'; otherContactId: string; otherContactName: string }
  > {
    const normalized = normalizePhoneE164(phone)
    if (!normalized) throw new Error('Invalid phone number')

    // Already on the target contact?
    const same = await prisma.contactPhone.findFirst({
      where: { contactId, phone: normalized },
    })
    if (same) {
      // If row exists but inactive — reactivate.
      if (!same.isActive) {
        await prisma.contactPhone.update({
          where: { id: same.id },
          data: { isActive: true },
        })
      }
      return { kind: 'exists_same_contact', phoneId: same.id, contactId }
    }

    // Phone owned by ANOTHER contact?
    const otherOwner = await prisma.contactPhone.findFirst({
      where: { phone: normalized, isActive: true, NOT: { contactId } },
      include: { contact: { select: { id: true, displayName: true } } },
    })
    if (otherOwner) {
      return {
        kind: 'conflict',
        otherContactId: otherOwner.contact.id,
        otherContactName: otherOwner.contact.displayName,
      }
    }

    // Clean slate — create. Optionally deactivate this contact's old
    // temporaries (used when the real number arrives for an Avito lead).
    return await prisma.$transaction(async (tx) => {
      if (opts?.deactivateTemporaries) {
        await (tx.contactPhone as any).updateMany({
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
      const created = await (tx.contactPhone as any).create({
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

    const [identity, contact] = await Promise.all([
      prisma.contactIdentity.findUnique({
        where: { id: identityId },
        select: {
          id: true,
          contactId: true,
          externalId: true,
          phoneId: true,
          reachabilityStatus: true,
          phone: { select: { phone: true, isActive: true, isPrimary: true, verifiedAt: true } },
        },
      }),
      prisma.contact.findUnique({
        where: { id: contactId },
        select: { id: true, displayName: true, displayNameSource: true, primaryPhoneId: true },
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

    let result
    try {
      result = await this.addPhoneToContact(contactId, normalized, {
        source: opts?.source ?? 'manual',
        makePrimary,
      })
    } catch (error: any) {
      if (error?.code !== 'P2002') throw error
      result = await this.addPhoneToContact(contactId, normalized, {
        source: opts?.source ?? 'manual',
        makePrimary,
      })
    }

    if (result.kind === 'conflict') return result

    const now = new Date()
    const updates: any[] = [
      prisma.contactPhone.update({
        where: { id: result.phoneId },
        data: {
          isActive: true,
          ...(opts?.confirmed ? { verifiedAt: now } : {}),
          ...(makePrimary ? { isPrimary: true } : {}),
        },
      }),
      prisma.contactIdentity.update({
        where: { id: identityId },
        data: {
          phoneId: result.phoneId,
          ...(opts?.confirmed ? {
            reachabilityStatus: 'confirmed',
            reachabilityCheckedAt: now,
          } : {}),
        },
      }),
    ]

    if (makePrimary) {
      updates.push(prisma.contact.update({
        where: { id: contactId },
        data: { primaryPhoneId: result.phoneId },
      }))
    }
    if (updateTechnicalName) {
      updates.push(prisma.contact.update({
        where: { id: contactId },
        data: { displayName: normalized },
      }))
    }

    await prisma.$transaction(updates)
    console.log(
      `[ContactService] Attached phone ${normalized} to identity=${identityId} `
      + `contact=${contactId} primary=${makePrimary}`,
    )
    return result
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

    const result = await prisma.$executeRawUnsafe(
      `DELETE FROM "ContactIdentity"
       WHERE "contactId" = ANY($1::text[])
         AND id NOT IN (
           SELECT "contactIdentityId" FROM "Chat"
           WHERE "contactIdentityId" IS NOT NULL
         )`,
      contactIds,
    )
    if (result > 0) {
      console.log(`[ContactService] Cleaned up ${result} dangling identities for ${contactIds.length} contacts`)
    }
    return result
  }
}
