import { normalizeRussianPhoneE164 } from '@/lib/phoneUtils'

export const REAL_PERSONAL_MAX_MESSAGE_ID = /^d301[0-9a-f]{14}$/i

export type PersonalMaxProviderMessage = {
  providerMessageId: string
  direction: 'inbound' | 'outbound'
  providerUserId: string
  timestamp: number
  text: string | null
  textDisposition: 'exact_unicode' | 'not_text' | 'quarantined'
  quarantineReason?: string | null
  messageType?: string
  attachmentCount?: number
}

export type PersonalMaxExistingMessage = {
  id: string
  externalId: string | null
  clientMessageId?: string | null
  direction: 'inbound' | 'outbound' | 'system'
  content: string
  sentAt: Date | string
  metadata?: unknown
}

export type PersonalMaxDispatch = {
  providerMessageId: string | null
  clientMessageId: string | null
  state: string
}

export type PersonalMaxHistoryPlan = {
  creates: PersonalMaxProviderMessage[]
  repairs: Array<{ messageId: string; providerMessageId: string; exactText: string }>
  echoLinks: Array<{ messageId: string; providerMessageId: string; clientMessageId: string }>
  quarantined: PersonalMaxProviderMessage[]
  unchangedProviderMessageIds: string[]
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

export function hasDamagedPersonalMaxText(value: string): boolean {
  const lower = value.toLocaleLowerCase('ru-RU')
  return value.includes('\uFFFD')
    || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value)
    || /attaches.{0,32}prevm|prevmsg|\bttl.{0,16}unread/.test(lower)
}

export function normalizePersonalMaxProfilePhone(value: unknown): string | null {
  return typeof value === 'string' ? normalizeRussianPhoneE164(value) : null
}

export function personalMaxNativeMetadata(input: {
  accountId: string
  protocolChatId: string
  uiRouteId: string
  providerUserId: string
  source: 'live' | 'history' | 'provider_store_recovery'
}) {
  return {
    origin: 'max_native',
    source: input.source,
    retryable: false,
    personalMaxIdentity: {
      accountId: input.accountId,
      protocolChatId: input.protocolChatId,
      uiRouteId: input.uiRouteId,
      providerUserId: input.providerUserId,
    },
    maxDelivery: {
      status: 'provider_present',
      deliveryConfirmed: false,
      retryable: false,
    },
  }
}

export function isPersonalMaxNativeMessage(metadata: unknown): boolean {
  return record(metadata).origin === 'max_native'
}

export function buildPersonalMaxHistoryPlan(input: {
  providerMessages: PersonalMaxProviderMessage[]
  existingMessages: PersonalMaxExistingMessage[]
  dispatches: PersonalMaxDispatch[]
}): PersonalMaxHistoryPlan {
  const byProviderId = new Map(
    input.existingMessages
      .filter(message => message.externalId && REAL_PERSONAL_MAX_MESSAGE_ID.test(message.externalId))
      .map(message => [message.externalId!.toLowerCase(), message]),
  )
  const byClientId = new Map(
    input.existingMessages
      .filter(message => message.clientMessageId)
      .map(message => [message.clientMessageId!, message]),
  )
  const dispatchByProviderId = new Map(
    input.dispatches
      .filter(dispatch => dispatch.providerMessageId && REAL_PERSONAL_MAX_MESSAGE_ID.test(dispatch.providerMessageId))
      .map(dispatch => [dispatch.providerMessageId!.toLowerCase(), dispatch]),
  )
  const seen = new Set<string>()
  const plan: PersonalMaxHistoryPlan = {
    creates: [],
    repairs: [],
    echoLinks: [],
    quarantined: [],
    unchangedProviderMessageIds: [],
  }

  const ordered = [...input.providerMessages].sort((left, right) =>
    left.timestamp - right.timestamp
      || left.providerMessageId.localeCompare(right.providerMessageId))
  for (const provider of ordered) {
    const providerKey = provider.providerMessageId.toLowerCase()
    if (!REAL_PERSONAL_MAX_MESSAGE_ID.test(provider.providerMessageId) || seen.has(providerKey)) continue
    seen.add(providerKey)
    if (provider.textDisposition === 'quarantined'
      || (provider.text !== null && hasDamagedPersonalMaxText(provider.text))) {
      plan.quarantined.push(provider)
      continue
    }

    const existing = byProviderId.get(providerKey)
    if (existing) {
      if (provider.text !== null && existing.content !== provider.text) {
        plan.repairs.push({
          messageId: existing.id,
          providerMessageId: provider.providerMessageId,
          exactText: provider.text,
        })
      } else {
        plan.unchangedProviderMessageIds.push(provider.providerMessageId)
      }
      continue
    }

    const dispatch = dispatchByProviderId.get(providerKey)
    const optimistic = dispatch?.clientMessageId
      ? byClientId.get(dispatch.clientMessageId)
      : null
    if (provider.direction === 'outbound' && dispatch?.state === 'provider_confirmed'
      && dispatch.clientMessageId && optimistic) {
      plan.echoLinks.push({
        messageId: optimistic.id,
        providerMessageId: provider.providerMessageId,
        clientMessageId: dispatch.clientMessageId,
      })
      continue
    }
    if (provider.direction === 'outbound' && dispatch) {
      plan.quarantined.push(provider)
      continue
    }
    if (provider.text === null && Number(provider.attachmentCount || 0) === 0) {
      plan.quarantined.push(provider)
      continue
    }
    plan.creates.push(provider)
  }
  return plan
}
