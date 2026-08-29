const FORBIDDEN_TELEGRAM_PUBLIC_KEYS = new Set(['apiHash', 'sessionString'])

function assertTelegramPublicMetadata(value: unknown, path = '$', seen = new WeakSet<object>()): void {
    if (value === null || typeof value !== 'object') return
    if (seen.has(value)) return
    seen.add(value)
    for (const [key, entry] of Object.entries(value)) {
        if (FORBIDDEN_TELEGRAM_PUBLIC_KEYS.has(key)) {
            throw new Error(`Credential-bearing key is forbidden in Telegram public metadata: ${path}.${key}`)
        }
        assertTelegramPublicMetadata(entry, `${path}.${key}`, seen)
    }
}

export interface TelegramConnectionPublicMetadata {
    id: string
    apiId: number
    isActive: boolean
    isPaused: boolean
    phoneNumber: string | null
    createdAt: Date
    updatedAt: Date
    isDefault: boolean
    name: string | null
    apiHashConfigured: boolean
    sessionConfigured: boolean
}

export function projectTelegramConnectionMetadata(source: {
    id: string
    apiId: number
    isActive: boolean
    phoneNumber: string | null
    createdAt: Date
    updatedAt: Date
    isDefault: boolean
    name: string | null
    apiHashConfigured: boolean
    sessionConfigured: boolean
}): TelegramConnectionPublicMetadata {
    const dto = {
        id: source.id,
        apiId: source.apiId,
        isActive: source.isActive,
        isPaused: !source.isActive,
        phoneNumber: source.phoneNumber,
        createdAt: source.createdAt,
        updatedAt: source.updatedAt,
        isDefault: source.isDefault,
        name: source.name,
        apiHashConfigured: source.apiHashConfigured,
        sessionConfigured: source.sessionConfigured,
    }
    assertTelegramPublicMetadata(dto)
    return dto
}

export const telegramPublicMetadataBoundaryForTests = { assert: assertTelegramPublicMetadata }
