const FORBIDDEN_AI_CONFIG_PUBLIC_KEYS = new Set(['apiKeyEncrypted'])

function assertAiConfigPublicMetadata(value: unknown, path = '$', seen = new WeakSet<object>()): void {
    if (value === null || typeof value !== 'object') return
    if (seen.has(value)) return
    seen.add(value)
    for (const [key, entry] of Object.entries(value)) {
        if (FORBIDDEN_AI_CONFIG_PUBLIC_KEYS.has(key)) {
            throw new Error(`Credential-bearing key is forbidden in AI config public metadata: ${path}.${key}`)
        }
        assertAiConfigPublicMetadata(entry, `${path}.${key}`, seen)
    }
}

export function projectAiAgentConfigMetadata<
    T extends Record<string, unknown> & { apiKeyEncrypted?: unknown },
>(source: T): Omit<T, 'apiKeyEncrypted'> & { providerCredentialConfigured: boolean } {
    const { apiKeyEncrypted, ...metadata } = source
    const dto = {
        ...metadata,
        providerCredentialConfigured:
            typeof apiKeyEncrypted === 'string' && apiKeyEncrypted.trim().length > 0,
    } as Omit<T, 'apiKeyEncrypted'> & { providerCredentialConfigured: boolean }
    assertAiConfigPublicMetadata(dto)
    return dto
}

export const aiConfigPublicMetadataBoundaryForTests = { assert: assertAiConfigPublicMetadata }
