const FORBIDDEN_MAX_PUBLIC_KEYS = new Set(['botToken'])

function assertMaxPublicMetadata(value: unknown, path = '$', seen = new WeakSet<object>()): void {
    if (value === null || typeof value !== 'object') return
    if (seen.has(value)) return
    seen.add(value)
    for (const [key, entry] of Object.entries(value)) {
        if (FORBIDDEN_MAX_PUBLIC_KEYS.has(key)) {
            throw new Error(`Credential-bearing key is forbidden in MAX public metadata: ${path}.${key}`)
        }
        assertMaxPublicMetadata(entry, `${path}.${key}`, seen)
    }
}

export interface MaxConnectionPublicMetadata {
    id: string
    name: string | null
    isActive: boolean
    isPaused: boolean
    isDefault: boolean
    createdAt: Date
    updatedAt: Date
    botTokenConfigured: boolean
}

export function projectMaxConnectionMetadata(source: {
    id: string
    name: string | null
    isActive: boolean
    isDefault: boolean
    createdAt: Date
    updatedAt: Date
    credentialConfigured: boolean
}): MaxConnectionPublicMetadata {
    const dto = {
        id: source.id,
        name: source.name,
        isActive: source.isActive,
        isPaused: !source.isActive,
        isDefault: source.isDefault,
        createdAt: source.createdAt,
        updatedAt: source.updatedAt,
        botTokenConfigured: source.credentialConfigured,
    }
    assertMaxPublicMetadata(dto)
    return dto
}

export const maxPublicMetadataBoundaryForTests = { assert: assertMaxPublicMetadata }
