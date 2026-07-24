export interface ChronologicalMessage {
    id: string
    sentAt: string
    createdAt?: string
    externalId?: string
}

function timestamp(value?: string): number {
    const result = value ? new Date(value).getTime() : 0
    return Number.isFinite(result) ? result : 0
}

function compareOptionalProviderIds(left?: string, right?: string): number {
    const a = String(left || '')
    const b = String(right || '')
    if (a === b) return 0
    if (!a) return 1
    if (!b) return -1
    return a < b ? -1 : 1
}

export function compareMessagesChronologically(
    left: ChronologicalMessage,
    right: ChronologicalMessage,
): number {
    const sentAtDelta = timestamp(left.sentAt) - timestamp(right.sentAt)
    if (sentAtDelta !== 0) return sentAtDelta

    const providerIdDelta = compareOptionalProviderIds(left.externalId, right.externalId)
    if (providerIdDelta !== 0) return providerIdDelta

    const createdAtDelta = timestamp(left.createdAt) - timestamp(right.createdAt)
    if (createdAtDelta !== 0) return createdAtDelta

    if (left.id === right.id) return 0
    return left.id < right.id ? -1 : 1
}

export function sortMessagesChronologically<T extends ChronologicalMessage>(
    messages: T[],
): T[] {
    return [...messages].sort(compareMessagesChronologically)
}
