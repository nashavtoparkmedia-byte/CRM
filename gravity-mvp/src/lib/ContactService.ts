import { prisma } from '@/lib/prisma'
import { ChatChannel } from '@prisma/client'
import { normalizePhoneE164, parseExternalChatId, looksLikePhone } from '@/lib/phoneUtils'

interface ResolveResult {
  contact: { id: string; displayName: string }
  identity: { id: string; channel: ChatChannel; externalId: string }
  isNew: boolean
}

const MAX_RETRIES = 2

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
   * Ensure Chat has contactId and contactIdentityId.
   * No-op if already set.
   */
  static async ensureChatLinked(chatId: string, contactId: string, identityId: string): Promise<void> {
    await prisma.chat.update({
      where: { id: chatId },
      data: {
        contactId,
        contactIdentityId: identityId,
      },
    })
  }
}
