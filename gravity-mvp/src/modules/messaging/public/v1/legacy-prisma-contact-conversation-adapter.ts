import { prisma } from '@/lib/prisma'
import type {
  ContactConversationChannelV1,
  ContactConversationV1,
} from '../../../../contracts/messaging/v1'
import type { ContactConversationPersistencePortV1 } from './contact-conversation-handler'

const CONVERSATION_SELECT = {
  id: true,
  channel: true,
  externalChatId: true,
  status: true,
  contactId: true,
  contactIdentityId: true,
  metadata: true,
} as const

type StoredContactConversationV1 = {
  id: string
  channel: ContactConversationV1['channel']
  externalChatId: string
  status: string
  contactId: string | null
  contactIdentityId: string | null
  metadata: unknown
}

type ExactIdentityBindingV1 = {
  contactId: string
  contactIdentityId: string
  channel: ContactConversationChannelV1
  identityExternalId: string
  exactExternalChatIds: string[]
  providerAccountId: string | null
}

function metadataRecord(metadata: unknown): Record<string, unknown> {
  return metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? metadata as Record<string, unknown>
    : {}
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

function storedProviderAccountId(conversation: StoredContactConversationV1): string | null {
  const providerAccountId = nonEmptyString(metadataRecord(conversation.metadata).providerAccountId)
  return providerAccountId === 'legacy' ? null : providerAccountId
}

function storedTransportConnectionId(conversation: StoredContactConversationV1): string | null {
  return nonEmptyString(metadataRecord(conversation.metadata).connectionId)
}

function toConversation(
  conversation: StoredContactConversationV1,
  input: ExactIdentityBindingV1,
): ContactConversationV1 {
  // The account reported for a conversation is the one its route carries. The
  // identity's providerAccountId is first-writer telemetry about the person and
  // is never substituted for it. See docs/design/provider-account-identity-v1.md.
  const providerAccountId = storedProviderAccountId(conversation)
  return {
    id: conversation.id,
    channel: conversation.channel,
    externalChatId: conversation.externalChatId,
    status: conversation.status,
    contactId: conversation.contactId ?? input.contactId,
    contactIdentityId: conversation.contactIdentityId ?? input.contactIdentityId,
    providerAccountId,
    transportConnectionId: storedTransportConnectionId(conversation),
  }
}

function assertExactConversationTarget(
  conversation: StoredContactConversationV1,
  input: ExactIdentityBindingV1,
): void {
  if (conversation.channel !== input.channel || conversation.externalChatId.trim() === '') {
    throw new Error('CONTACT_CONVERSATION_PROVIDER_KEY_MISMATCH')
  }
  if (input.channel === 'max') {
    // MAX senderId is a person identity, while externalChatId is the
    // conversation id. The channel-owned sender alias is the proof tying them.
    if (nonEmptyString(metadataRecord(conversation.metadata).senderId) !== input.identityExternalId) {
      throw new Error('CONTACT_CONVERSATION_PROVIDER_KEY_MISMATCH')
    }
    return
  }
  if (!input.exactExternalChatIds.includes(conversation.externalChatId)) {
    throw new Error('CONTACT_CONVERSATION_PROVIDER_KEY_MISMATCH')
  }
}

function assertCompatibleOwnership(
  conversation: StoredContactConversationV1,
  input: ExactIdentityBindingV1,
): void {
  if (
    (conversation.contactId !== null && conversation.contactId !== input.contactId)
    || (
      conversation.contactIdentityId !== null
      && conversation.contactIdentityId !== input.contactIdentityId
    )
  ) {
    throw new Error('CONTACT_CONVERSATION_OWNERSHIP_MISMATCH')
  }
}

function assertExactOwnership(
  conversation: StoredContactConversationV1,
  input: ExactIdentityBindingV1,
): void {
  if (
    conversation.contactId !== input.contactId
    || conversation.contactIdentityId !== input.contactIdentityId
  ) {
    throw new Error('CONTACT_CONVERSATION_OWNERSHIP_MISMATCH')
  }
}

function uniqueCandidate(
  conversations: StoredContactConversationV1[],
): StoredContactConversationV1 | null {
  const unique = [...new Map(conversations.map(conversation => [conversation.id, conversation])).values()]
  if (unique.length > 1) throw new Error('CONTACT_CONVERSATION_AMBIGUOUS')
  return unique[0] ?? null
}

async function readExactBinding(
  conversation: StoredContactConversationV1,
  input: ExactIdentityBindingV1,
): Promise<ContactConversationV1 | null> {
  assertExactConversationTarget(conversation, input)
  assertCompatibleOwnership(conversation, input)
  // Contacts prepared the identity under CNT1, but that lock is released
  // before Messaging reads the Chat. A cross-owner backfill here cannot
  // atomically prove that the ContactIdentity still belongs to this Contact.
  // Therefore an incomplete legacy binding is read-only and fails closed;
  // only a Chat already carrying the exact owner pair can be returned.
  //
  // Provider account is not compared against the identity and its absence is
  // not a rejection: that stamp describes the person's first observed transport,
  // not which route may carry this conversation. Route safety is enforced where
  // the route is actually used, by the bound transport check and send-time
  // provider attestation in outbound preparation.
  if (conversation.contactId === null || conversation.contactIdentityId === null) return null
  assertExactOwnership(conversation, input)
  return toConversation(conversation, input)
}

async function findCandidates(input: ExactIdentityBindingV1 & { allowContactFallback: boolean }) {
  let conversation = uniqueCandidate(await prisma.chat.findMany({
    where: { contactIdentityId: input.contactIdentityId, channel: input.channel },
    orderBy: [{ lastMessageAt: 'desc' }, { createdAt: 'desc' }],
    take: 2,
    select: CONVERSATION_SELECT,
  }))
  if (conversation || !input.allowContactFallback) return conversation

  // The identity's providerAccountId never narrows the route search. If one
  // sender has conversations under two accounts, uniqueCandidate fails closed as
  // ambiguous instead of silently preferring whichever account saw them first.
  const providerTarget = input.channel === 'max'
    ? { metadata: { path: ['senderId'], equals: input.identityExternalId } }
    : { externalChatId: { in: input.exactExternalChatIds } }
  conversation = uniqueCandidate(await prisma.chat.findMany({
    where: {
      contactId: input.contactId,
      channel: input.channel,
      ...providerTarget,
      OR: [
        { contactIdentityId: input.contactIdentityId },
        { contactIdentityId: null },
      ],
    },
    orderBy: [{ lastMessageAt: 'desc' }, { createdAt: 'desc' }],
    take: 2,
    select: CONVERSATION_SELECT,
  }))
  return conversation
}

export const legacyPrismaContactConversationPortV1: ContactConversationPersistencePortV1 = {
  async findAndBackfill(input) {
    const conversation = await findCandidates(input)
    if (!conversation) return null
    return readExactBinding(conversation, input)
  },

  async openFallback(input) {
    const exactExternalChatIds = input.channel === 'max'
      ? []
      : input.exactExternalChatIds
    const conversation = exactExternalChatIds.length > 0
      ? uniqueCandidate(await prisma.chat.findMany({
          where: {
            channel: input.channel,
            externalChatId: { in: exactExternalChatIds },
          },
          orderBy: [{ lastMessageAt: 'desc' }, { createdAt: 'desc' }],
          take: 2,
          select: CONVERSATION_SELECT,
        }))
      : uniqueCandidate(await prisma.chat.findMany({
          where: {
            contactId: input.contactId,
            contactIdentityId: input.contactIdentityId,
            channel: 'max',
            metadata: { path: ['senderId'], equals: input.identityExternalId },
          },
          orderBy: [{ lastMessageAt: 'desc' }, { createdAt: 'desc' }],
          take: 2,
          select: CONVERSATION_SELECT,
        }))

    if (conversation) {
      assertExactOwnership(conversation, input)
      const prepared = await readExactBinding(conversation, input)
      // Unreachable after assertExactOwnership; kept as a closed door.
      if (!prepared) throw new Error('CONTACT_CONVERSATION_OWNERSHIP_MISMATCH')
      if (!prepared.transportConnectionId) return { status: 'transport_unbound' }
      return { status: 'ready', conversation: prepared, isNew: false }
    }

    if (input.channel === 'max' || exactExternalChatIds.length === 0) {
      return { status: 'conversation_target_unproven' }
    }
    // No owner capability currently proves a transport for a brand-new Chat.
    // Only an existing channel-owned Chat may authorize outbound routing.
    return { status: 'transport_unbound' }
  },
}
