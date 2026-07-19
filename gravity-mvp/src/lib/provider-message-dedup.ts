import type { Prisma } from '@prisma/client'

export type ProviderMessageDirection = 'inbound' | 'outbound'

type ProviderDedupInput = {
    externalId?: string | null
    chatId: string
    content: string
    direction: ProviderMessageDirection
    sentAt: Date
    fallbackWindowMs: number
    allowOptimisticOutbound?: boolean
}

/**
 * Provider message identity is authoritative whenever it exists.
 *
 * Content/time matching is intentionally limited to:
 * - legacy events that have no provider message ID; and
 * - the optimistic outbound row created before a provider echo arrives.
 *
 * This preserves two legitimate messages with equal text and different IDs,
 * while still reconciling a provider echo with the CRM optimistic row.
 */
export function buildProviderMessageDedupWhere(
    input: ProviderDedupInput,
): Prisma.MessageWhereInput {
    const fingerprint: Prisma.MessageWhereInput = {
        chatId: input.chatId,
        content: input.content,
        direction: input.direction,
        sentAt: {
            gte: new Date(input.sentAt.getTime() - input.fallbackWindowMs),
            lte: new Date(input.sentAt.getTime() + input.fallbackWindowMs),
        },
    }

    if (!input.externalId) {
        return fingerprint
    }

    if (input.allowOptimisticOutbound && input.direction === 'outbound') {
        return {
            OR: [
                { externalId: input.externalId },
                {
                    ...fingerprint,
                    externalId: null,
                    status: 'sent',
                },
            ],
        }
    }

    return { externalId: input.externalId }
}

export function buildScopedProviderMessageId(
    provider: string,
    scope: string | number | null | undefined,
    rawMessageId: string | number | null | undefined,
): string | null {
    if (rawMessageId === null || rawMessageId === undefined || rawMessageId === '') {
        return null
    }

    const normalizedProvider = provider.trim().toLowerCase()
    const normalizedScope = String(scope ?? 'unknown').trim() || 'unknown'
    return `${normalizedProvider}:${normalizedScope}:${String(rawMessageId)}`
}

export function readRawProviderMessageId(externalId: string | null | undefined): string | null {
    if (!externalId) return null
    const separator = externalId.lastIndexOf(':')
    return separator >= 0 ? externalId.slice(separator + 1) : externalId
}
