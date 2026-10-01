import { CONFIRM_DRIVER_PERSON_COMMAND_V1 } from '@/contracts/contacts/v1'
import { prisma } from '@/lib/prisma'
import {
  confirmDriverPersonV1,
  createRepairTelegramConversationPersonBindingV1,
  isContactConfirmedMainDriverV1,
  pinCanonicalContactV1,
  type RepairPreconditionStateV1,
} from '@/modules/contacts/public/v1'
import { searchYandexParksByDriverQueryV1 } from '@/modules/fleet-operations/public/v1'
import { mergeContactsV1 } from './contact-merge-composition'

/**
 * Composition for the bounded Telegram conversation person-binding repair.
 *
 * Reads live state through Prisma here, in shared infrastructure, so the
 * Contacts-owned capability holds no client and performs no persistence of its
 * own. Every mutation is delegated to an existing owner primitive: the directed
 * contact merge (phase 1) and `confirmDriverPersonV1` (phase 2).
 */

function digits(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.replace(/[^0-9]/g, '')
  return normalized.length > 0 ? normalized : null
}

function customFieldString(customFields: unknown, field: string): string | null {
  if (!customFields || typeof customFields !== 'object' || Array.isArray(customFields)) return null
  const value = (customFields as Record<string, unknown>)[field]
  return typeof value === 'string' && value.length > 0 ? value : null
}

async function readState(input: {
  canonicalContactId: string
  duplicateContactId: string
  representativeDriverId: string
  telegramExternalId: string
}): Promise<RepairPreconditionStateV1> {
  const [canonical, duplicate, driver, identity, chat, driverTelegram, mergeRelation] = await Promise.all([
    prisma.contact.findUnique({
      where: { id: input.canonicalContactId },
      select: {
        id: true,
        isArchived: true,
        customFields: true,
        yandexDriverId: true,
        primaryPhoneId: true,
        phones: { select: { id: true, phone: true, isPrimary: true, isActive: true, verifiedAt: true } },
      },
    }),
    prisma.contact.findUnique({
      where: { id: input.duplicateContactId },
      select: { id: true, isArchived: true, customFields: true },
    }),
    prisma.driver.findUnique({
      where: { id: input.representativeDriverId },
      select: { id: true, phone: true },
    }),
    prisma.contactIdentity.findFirst({
      where: { channel: 'telegram', externalId: input.telegramExternalId },
      select: { id: true, contactId: true, channel: true, externalId: true, isActive: true },
    }),
    prisma.chat.findUnique({
      where: { externalChatId: `telegram:${input.telegramExternalId}` },
      select: {
        id: true,
        channel: true,
        chatType: true,
        externalChatId: true,
        contactId: true,
        contactIdentityId: true,
        driverId: true,
      },
    }),
    prisma.driverTelegram.findFirst({
      where: { telegramId: BigInt(input.telegramExternalId) },
      select: { driverId: true, activeParkId: true, phoneVerified: true },
    }),
    prisma.contactMerge.findFirst({
      where: {
        OR: [
          { survivorId: input.canonicalContactId, mergedId: input.duplicateContactId },
          { survivorId: input.duplicateContactId, mergedId: input.canonicalContactId },
        ],
      },
      select: { id: true },
    }),
  ])

  // The canonical person proof uses the verified primary phone only. An
  // unverified or non-primary phone is deliberately not accepted.
  const verifiedPrimary = canonical?.phones.find(phone => (
    phone.isPrimary && phone.isActive && phone.verifiedAt !== null
    && (canonical.primaryPhoneId === null || canonical.primaryPhoneId === phone.id)
  )) ?? null

  return {
    canonicalContact: canonical
      ? {
          id: canonical.id,
          isArchived: canonical.isArchived,
          mergedIntoContactId: customFieldString(canonical.customFields, 'mergedIntoContactId'),
          yandexDriverId: canonical.yandexDriverId,
          verifiedPrimaryPhoneDigits: digits(verifiedPrimary?.phone ?? null),
          canonicalPinnedAt: customFieldString(canonical.customFields, 'canonicalPinnedAt'),
        }
      : null,
    duplicateContact: duplicate
      ? {
          id: duplicate.id,
          isArchived: duplicate.isArchived,
          mergedIntoContactId: customFieldString(duplicate.customFields, 'mergedIntoContactId'),
          canonicalPinnedAt: customFieldString(duplicate.customFields, 'canonicalPinnedAt'),
        }
      : null,
    representativeDriver: driver ? { id: driver.id, phoneDigits: digits(driver.phone) } : null,
    telegramIdentity: identity,
    telegramChat: chat,
    driverTelegram: driverTelegram ?? null,
    hasMergeRelation: Boolean(mergeRelation),
  }
}

export type TelegramPersonBindingRepairRequestV1 = {
  canonicalContactId: string
  duplicateContactId: string
  representativeDriverId: string
  telegramExternalId: string
  actorId: string
}

export function runTelegramConversationPersonBindingRepairV1(
  request: TelegramPersonBindingRepairRequestV1,
) {
  const repair = createRepairTelegramConversationPersonBindingV1({
    readState,
    readFleetEvidence: (query) => searchYandexParksByDriverQueryV1(query),
    async pinCanonicalContact({ contactId, actorId }) {
      return await pinCanonicalContactV1({ contactId, pinnedBy: actorId })
    },
    // The one composed cross-owner merge operation, unchanged. The canonical pin
    // written in phase 1 is what makes its survivor heuristic elect the canonical
    // Contact, so no directed variant of this handler exists.
    async mergeDuplicateIntoCanonical({ duplicateContactId, canonicalContactId, actorId }) {
      const result = await mergeContactsV1({
        contract: 'contacts.MergeContactsCommand.v1',
        operation: 'contact_to_contact',
        sourceId: duplicateContactId,
        targetId: canonicalContactId,
        mergedBy: actorId,
      })
      const record = result as { status: string; survivorId?: string; mergedId?: string }
      return { status: record.status, survivorId: record.survivorId, mergedId: record.mergedId }
    },
    async confirmRepresentativeDriver({
      contactId, profileClusterKey, representativeDriverId, actorId, searchInput,
      evidenceProfiles, evidenceWarnings,
    }) {
      const confirmed = await confirmDriverPersonV1({
        contract: CONFIRM_DRIVER_PERSON_COMMAND_V1,
        contactId,
        profileClusterKey,
        representativeDriverId,
        confirmedBy: actorId,
        // The repair proves the person by the canonical Contact's verified
        // primary phone, so the basis is 'phone' by construction.
        confirmationBasis: 'phone',
        searchInput,
        evidenceSnapshot: { profiles: evidenceProfiles, warnings: evidenceWarnings },
      })
      return { status: confirmed.status, confirmationId: confirmed.confirmationId }
    },
    isContactConfirmedMainDriver: (contactId, driverId) => isContactConfirmedMainDriverV1(contactId, driverId),
    log: (message) => console.log(message),
  })

  return repair(request)
}

/** Exposed for the route's audit snapshot. Read-only. */
export function readTelegramPersonBindingRepairBeforeStateV1(input: {
  canonicalContactId: string
  duplicateContactId: string
  representativeDriverId: string
  telegramExternalId: string
}): Promise<RepairPreconditionStateV1> {
  return readState(input)
}

async function activeNumericTelegramIds(contactId: string): Promise<string[]> {
  const identities = await prisma.contactIdentity.findMany({
    where: { contactId, channel: 'telegram', isActive: true },
    select: { externalId: true },
  })
  return identities
    .map(identity => identity.externalId)
    .filter(externalId => /^\d+$/.test(externalId))
}

/**
 * Resolves the Telegram peer id for the named pair, so the request contract stays
 * the three explicit ids and no production peer id is hardcoded anywhere in
 * application code.
 *
 * Before the repair the peer comes from the duplicate Contact's single active
 * Telegram identity. After phase 1 the merge has moved that identity onto the
 * canonical Contact, so the duplicate owns none: without the second branch the
 * route could never reach the capability's resume path and the two-phase
 * `retryResumesPhase2` contract would be unreachable. The fallback is bounded —
 * it requires a completed merge ledger row for exactly this pair, in exactly
 * this direction, and still demands a single unambiguous identity. Anything
 * else fails closed.
 */
export async function resolveDuplicateTelegramExternalIdV1(
  duplicateContactId: string,
  canonicalContactId: string,
): Promise<{ externalId: string } | { error: 'NO_TELEGRAM_IDENTITY' | 'AMBIGUOUS_TELEGRAM_IDENTITY' }> {
  const duplicateIds = await activeNumericTelegramIds(duplicateContactId)
  if (duplicateIds.length > 1) return { error: 'AMBIGUOUS_TELEGRAM_IDENTITY' }
  if (duplicateIds.length === 1) return { externalId: duplicateIds[0] }

  const mergedIntoCanonical = await prisma.contactMerge.findFirst({
    where: { survivorId: canonicalContactId, mergedId: duplicateContactId, action: 'merge' },
    select: { id: true },
  })
  if (!mergedIntoCanonical) return { error: 'NO_TELEGRAM_IDENTITY' }

  const canonicalIds = await activeNumericTelegramIds(canonicalContactId)
  if (canonicalIds.length === 0) return { error: 'NO_TELEGRAM_IDENTITY' }
  if (canonicalIds.length > 1) return { error: 'AMBIGUOUS_TELEGRAM_IDENTITY' }
  return { externalId: canonicalIds[0] }
}
