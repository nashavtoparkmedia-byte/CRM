import {
    RECORD_BOT_USER_PROFILE_RESULT_V1,
    parseRecordBotUserProfileCommandV1,
    type RecordBotUserProfileCommandV1,
    type RecordBotUserProfileResultV1,
} from '../../../../contracts/telegram-channel/v1'

export interface BotUserProfilePersistencePortV1 {
    record(input: Omit<RecordBotUserProfileCommandV1, 'contract'>): Promise<void>
}

export function createRecordBotUserProfileHandlerV1(port: BotUserProfilePersistencePortV1) {
    return async function recordBotUserProfileV1(
        command: RecordBotUserProfileCommandV1 | unknown,
    ): Promise<RecordBotUserProfileResultV1> {
        const parsed = parseRecordBotUserProfileCommandV1(command)
        await port.record({
            telegramId: parsed.telegramId,
            username: parsed.username,
            firstName: parsed.firstName,
            lastName: parsed.lastName,
            phone: parsed.phone,
            phoneVerified: parsed.phoneVerified,
            observedAt: parsed.observedAt,
        })
        return { contract: RECORD_BOT_USER_PROFILE_RESULT_V1, recorded: true }
    }
}

export type PendingBotLinkRequest = {
    id: string
    telegramId: string
    phone: string | null
    username: string | null
    firstName: string | null
    lastName: string | null
    chatId: string | null
    createdAt: string
    lastSeenAt: string | null
}

type RegistryRow = {
    id: string
    telegramId: bigint
    phone: string | null
    username: string | null
    firstName: string | null
    lastName: string | null
    firstSeenAt: Date
    lastSeenAt: Date
}

type LegacyRequestRow = {
    id: string
    telegramId: bigint
    text: string
    createdAt: Date
}

export function buildPendingBotLinkRequests(input: {
    registryRows: RegistryRow[]
    legacyRequests: LegacyRequestRow[]
    linkedTelegramIds: Set<string>
    chatMap: Record<string, string>
}): PendingBotLinkRequest[] {
    const legacyByTelegramId = new Map(input.legacyRequests.map(row => [row.telegramId.toString(), row]))
    const pendingByTelegramId = new Map<string, PendingBotLinkRequest>()

    for (const row of input.registryRows) {
        const telegramId = row.telegramId.toString()
        if (input.linkedTelegramIds.has(telegramId)) continue

        const legacy = legacyByTelegramId.get(telegramId)
        const phoneMatch = legacy?.text.match(/Телефон:\s*([+\d]+)/)
        const usernameMatch = legacy?.text.match(/@(\S+)/)
        pendingByTelegramId.set(telegramId, {
            id: legacy?.id || row.id,
            telegramId,
            phone: row.phone || phoneMatch?.[1] || null,
            username: row.username || usernameMatch?.[1] || null,
            firstName: row.firstName || null,
            lastName: row.lastName || null,
            chatId: input.chatMap[telegramId] ?? null,
            createdAt: row.firstSeenAt.toISOString(),
            lastSeenAt: row.lastSeenAt.toISOString(),
        })
    }

    // Keep legacy phone-based requests visible during the registry transition.
    for (const row of input.legacyRequests) {
        const telegramId = row.telegramId.toString()
        if (input.linkedTelegramIds.has(telegramId) || pendingByTelegramId.has(telegramId)) continue
        const phoneMatch = row.text.match(/Телефон:\s*([+\d]+)/)
        const usernameMatch = row.text.match(/@(\S+)/)
        pendingByTelegramId.set(telegramId, {
            id: row.id,
            telegramId,
            phone: phoneMatch?.[1] ?? null,
            username: usernameMatch?.[1] ?? null,
            firstName: null,
            lastName: null,
            chatId: input.chatMap[telegramId] ?? null,
            createdAt: row.createdAt.toISOString(),
            lastSeenAt: null,
        })
    }

    return [...pendingByTelegramId.values()].sort((left, right) =>
        Date.parse(right.lastSeenAt || right.createdAt) - Date.parse(left.lastSeenAt || left.createdAt),
    )
}
