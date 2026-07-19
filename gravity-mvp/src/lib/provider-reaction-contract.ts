type JsonRecord = Record<string, unknown>

type ReactionEvent = {
    provider: string
    senderId: string
    emoji: string
    observedAt: Date
}

export function applyProviderReactionEvent(
    metadataValue: unknown,
    event: ReactionEvent,
): JsonRecord {
    const metadata = isRecord(metadataValue) ? { ...metadataValue } : {}
    const reactions = isNumberMap(metadata.reactions) ? { ...metadata.reactions } : {}
    const allActors = isRecord(metadata.providerReactionActors)
        ? { ...metadata.providerReactionActors }
        : {}
    const providerActors = isStringMap(allActors[event.provider])
        ? { ...(allActors[event.provider] as Record<string, string>) }
        : {}

    const previousEmoji = providerActors[event.senderId] || null
    const isRemoving = !event.emoji

    if (previousEmoji && (isRemoving || previousEmoji !== event.emoji)) {
        const nextCount = Math.max(0, (reactions[previousEmoji] || 0) - 1)
        if (nextCount > 0) reactions[previousEmoji] = nextCount
        else delete reactions[previousEmoji]
    }

    if (isRemoving) {
        delete providerActors[event.senderId]
    } else {
        providerActors[event.senderId] = event.emoji
        const knownCount = Object.values(providerActors)
            .filter(value => value === event.emoji)
            .length
        reactions[event.emoji] = Math.max(reactions[event.emoji] || 0, knownCount)
    }

    allActors[event.provider] = providerActors
    return {
        ...metadata,
        reactions,
        providerReactionActors: allActors,
        lastProviderReactionAt: event.observedAt.toISOString(),
    }
}

function isRecord(value: unknown): value is JsonRecord {
    return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isNumberMap(value: unknown): value is Record<string, number> {
    return isRecord(value) && Object.values(value).every(item => typeof item === 'number')
}

function isStringMap(value: unknown): value is Record<string, string> {
    return isRecord(value) && Object.values(value).every(item => typeof item === 'string')
}
