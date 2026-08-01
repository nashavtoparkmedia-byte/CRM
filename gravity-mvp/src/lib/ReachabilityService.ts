import { prisma } from '@/lib/prisma'
import { normalizePhoneE164 } from '@/lib/phoneUtils'

export type ReachabilityIdentityResolution =
  | {
      kind: 'matched'
      identity: {
        id: string
        reachabilityStatus: 'confirmed' | 'unreachable' | 'unknown'
        reachabilityCheckedAt: Date | null
      }
    }
  | { kind: 'not_found' }
  | { kind: 'ambiguous'; identityIds: string[] }
  | { kind: 'invalid_requested_identity' }

export type ProviderConnectionHealth = 'connected' | 'disconnected' | 'unknown'
export type ReachabilityChannel = 'telegram' | 'whatsapp' | 'max'

export type PersonalMaxDurableRouteResolution =
  | {
      kind: 'active'
      accountId: string
      conversationKey: string
      routeVersion: number
      protocolChatId: string | null
      providerUserId: string | null
      webRouteId: string | null
      identityValues: string[]
    }
  | { kind: 'not_found' }
  | { kind: 'ambiguous'; conversationKeys: string[] }
  | { kind: 'unavailable' }

const MAX_ROUTE_IDENTITY_KINDS = new Set([
  'protocol_chat_id',
  'provider_user_id',
  'web_route_id',
])

function personalMaxAccountId(): string | null {
  const value = process.env.MAX_PERSONAL_ACCOUNT_ID || ''
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value) ? value : null
}

function exactRouteIdentity(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!/^\d{1,15}$/u.test(trimmed)) return null
  return trimmed
}

/**
 * Update the reachability status of a ContactIdentity.
 *
 * Called from two places:
 * 1. check-reachability API — after live pre-check
 * 2. MessageService.send() — after delivery outcome
 *
 * Rules:
 * - Only 'confirmed' and 'unreachable' are valid updates
 * - Soft fallback / timeout / errors must NOT call this function
 * - Always updates reachabilityCheckedAt timestamp
 */
export async function updateReachability(
  identityId: string,
  status: 'confirmed' | 'unreachable'
): Promise<void> {
  try {
    await prisma.contactIdentity.update({
      where: { id: identityId },
      data: {
        reachabilityStatus: status,
        reachabilityCheckedAt: new Date(),
      },
    })
  } catch (error: unknown) {
    // Non-critical — don't break the caller's flow
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[ReachabilityService] Failed to update ${identityId} → ${status}: ${message}`)
  }
}

/**
 * Find a ContactIdentity by phone number and channel.
 * Used by check-reachability API to persist the result.
 *
 * Strategy: first try externalId match (works for WA/MAX where externalId = phone digits),
 * then try via ContactPhone → ContactIdentity (works for TG where externalId = telegramUserId).
 */
export async function resolveReachabilityIdentity(
  phone: string,
  channel: ReachabilityChannel,
  requestedIdentityId?: string | null,
): Promise<ReachabilityIdentityResolution> {
  const normalized = normalizePhoneE164(phone)
  if (!normalized) return { kind: 'not_found' }
  const digits = normalized.replace(/\D/g, '')
  const phoneVariants = Array.from(new Set([normalized, digits, `+${digits}`]))

  if (requestedIdentityId) {
    const requested = await prisma.contactIdentity.findUnique({
      where: { id: requestedIdentityId },
      select: {
        id: true,
        channel: true,
        externalId: true,
        isActive: true,
        reachabilityStatus: true,
        reachabilityCheckedAt: true,
        phone: { select: { phone: true, isActive: true } },
        contact: {
          select: {
            isArchived: true,
            phones: {
              where: { isActive: true },
              select: { phone: true },
            },
          },
        },
      },
    })
    if (!requested || !requested.isActive || requested.contact.isArchived || requested.channel !== channel) {
      return { kind: 'invalid_requested_identity' }
    }
    const belongsToPhone = [
      requested.phone?.isActive ? requested.phone.phone : null,
      ...requested.contact.phones.map(item => item.phone),
      requested.externalId,
    ].some(value => normalizePhoneE164(value || '') === normalized)
    if (!belongsToPhone) return { kind: 'invalid_requested_identity' }
    return {
      kind: 'matched',
      identity: {
        id: requested.id,
        reachabilityStatus: requested.reachabilityStatus,
        reachabilityCheckedAt: requested.reachabilityCheckedAt,
      },
    }
  }

  const matches = await prisma.contactIdentity.findMany({
    where: {
      channel,
      isActive: true,
      contact: { isArchived: false },
      OR: [
        { externalId: { in: phoneVariants } },
        { phone: { isActive: true, phone: { in: phoneVariants } } },
        {
          contact: {
            isArchived: false,
            phones: {
              some: {
                isActive: true,
                phone: { in: phoneVariants },
              },
            },
          },
        },
      ],
    },
    select: {
      id: true,
      reachabilityStatus: true,
      reachabilityCheckedAt: true,
    },
    orderBy: { id: 'asc' },
    take: 3,
  })
  if (matches.length === 0) return { kind: 'not_found' }
  if (matches.length > 1) {
    return {
      kind: 'ambiguous',
      identityIds: matches.map(item => item.id).sort(),
    }
  }
  return { kind: 'matched', identity: matches[0] }
}

/**
 * Resolve the exact durable Personal MAX route for one ContactIdentity.
 *
 * This is deliberately stricter than phone reachability: it only trusts
 * account-scoped active route-registry bindings for the configured Personal
 * MAX account. It never creates routes, never selects a different account, and
 * never promotes a phone-only match into sendability.
 */
export async function resolvePersonalMaxDurableRouteForIdentity(
  identityId: string | null | undefined,
): Promise<PersonalMaxDurableRouteResolution> {
  const accountId = personalMaxAccountId()
  if (!accountId || !identityId) return { kind: 'not_found' }

  try {
    const identity = await prisma.contactIdentity.findUnique({
      where: { id: identityId },
      select: {
        id: true,
        channel: true,
        externalId: true,
        isActive: true,
        contactId: true,
        contact: {
          select: {
            isArchived: true,
            chats: {
              where: { channel: 'max' },
              select: { externalChatId: true, contactIdentityId: true },
            },
          },
        },
      },
    })
    if (!identity || !identity.isActive || identity.channel !== 'max' || identity.contact.isArchived) {
      return { kind: 'not_found' }
    }

    const candidates = new Set<string>()
    const identityExternalId = exactRouteIdentity(identity.externalId)
    if (identityExternalId) candidates.add(identityExternalId)
    for (const chat of identity.contact.chats) {
      if (chat.contactIdentityId !== identity.id) continue
      const value = exactRouteIdentity(chat.externalChatId)
      if (value) candidates.add(value)
    }
    if (candidates.size === 0) return { kind: 'not_found' }

    const bindings = await prisma.maxRouteIdentityBinding.findMany({
      where: {
        accountId,
        status: 'active',
        identityValue: { in: [...candidates] },
        conversation: { state: 'active' },
      },
      select: {
        identityKind: true,
        identityValue: true,
        conversationKey: true,
        conversation: {
          select: {
            routeVersion: true,
          },
        },
      },
      orderBy: [{ conversationKey: 'asc' }, { identityKind: 'asc' }, { identityValue: 'asc' }],
    })
    const exactBindings = bindings.filter(binding => MAX_ROUTE_IDENTITY_KINDS.has(binding.identityKind))
    if (exactBindings.length === 0) return { kind: 'not_found' }
    const conversationKeys = [...new Set(exactBindings.map(binding => binding.conversationKey))].sort()
    if (conversationKeys.length !== 1) return { kind: 'ambiguous', conversationKeys }

    const byKind = new Map(exactBindings.map(binding => [binding.identityKind, binding.identityValue]))
    return {
      kind: 'active',
      accountId,
      conversationKey: conversationKeys[0]!,
      routeVersion: exactBindings[0]!.conversation.routeVersion,
      protocolChatId: byKind.get('protocol_chat_id') || null,
      providerUserId: byKind.get('provider_user_id') || null,
      webRouteId: byKind.get('web_route_id') || null,
      identityValues: [...new Set(exactBindings.map(binding => binding.identityValue))].sort(),
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[ReachabilityService] Personal MAX route lookup unavailable for ${identityId}: ${message}`)
    return { kind: 'unavailable' }
  }
}

/**
 * Backward-compatible helper. Ambiguous ownership intentionally resolves to
 * null so callers cannot persist a provider result on an arbitrary identity.
 */
export async function findIdentityByPhoneAndChannel(
  phone: string,
  channel: ReachabilityChannel,
): Promise<string | null> {
  const result = await resolveReachabilityIdentity(phone, channel)
  return result.kind === 'matched' ? result.identity.id : null
}

/**
 * Read-only CRM connection state. This is deliberately separate from account
 * reachability: a cached "account exists" answer remains true while a local
 * provider session is disconnected.
 */
export async function getProviderConnectionHealth(
  channel: ReachabilityChannel,
): Promise<ProviderConnectionHealth> {
  if (channel === 'whatsapp') {
    const connections = await prisma.whatsAppConnection.findMany({
      select: { status: true },
    })
    if (connections.some(item => item.status === 'ready')) {
      return 'connected'
    }
    return connections.length > 0 ? 'disconnected' : 'unknown'
  }

  if (channel === 'telegram') {
    const connections = await prisma.telegramConnection.findMany({
      select: { isActive: true },
    })
    if (connections.some(item => item.isActive)) return 'connected'
    return connections.length > 0 ? 'disconnected' : 'unknown'
  }

  const [personalSessions, botConnections] = await Promise.all([
    prisma.maxPersonalSession.findMany({
      select: { isActive: true, connectedAt: true },
    }),
    prisma.maxConnection.findMany({
      select: { isActive: true },
    }),
  ])
  if (
    personalSessions.some(item => item.isActive && item.connectedAt)
    || botConnections.some(item => item.isActive)
  ) {
    return 'connected'
  }
  return personalSessions.length > 0 || botConnections.length > 0
    ? 'disconnected'
    : 'unknown'
}

/**
 * Update reachability for a Chat's linked ContactIdentity.
 * Used by MessageService after delivery outcome.
 */
export async function updateReachabilityByChatId(
  chatId: string,
  status: 'confirmed' | 'unreachable'
): Promise<void> {
  try {
    const chat = await prisma.chat.findUnique({
      where: { id: chatId },
      select: { contactIdentityId: true },
    })

    if (chat?.contactIdentityId) {
      await updateReachability(chat.contactIdentityId, status)
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[ReachabilityService] Failed to update by chatId ${chatId}: ${message}`)
  }
}
