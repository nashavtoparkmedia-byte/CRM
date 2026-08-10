const FORBIDDEN_API_CONNECTION_PUBLIC_KEYS = new Set(['apiKey'])

function assertApiConnectionPublicMetadata(value: unknown, path = '$', seen = new WeakSet<object>()): void {
    if (value === null || typeof value !== 'object') return
    if (seen.has(value)) return
    seen.add(value)

    for (const [key, entry] of Object.entries(value)) {
        if (FORBIDDEN_API_CONNECTION_PUBLIC_KEYS.has(key)) {
            throw new Error(`Credential-bearing key is forbidden in ApiConnection public metadata: ${path}.${key}`)
        }
        assertApiConnectionPublicMetadata(entry, `${path}.${key}`, seen)
    }
}

export interface ApiConnectionPublicMetadata {
    id: string
    clid: string
    parkId: string
    name: string | null
    createdAt: Date
    apiKeyConfigured: boolean
}

export function projectApiConnectionMetadata(source: {
    id: string
    clid: string
    parkId: string
    name: string | null
    createdAt: Date
    credentialConfigured: boolean
}): ApiConnectionPublicMetadata {
    const dto = {
        id: source.id,
        clid: source.clid,
        parkId: source.parkId,
        name: source.name,
        createdAt: source.createdAt,
        apiKeyConfigured: source.credentialConfigured,
    }
    assertApiConnectionPublicMetadata(dto)
    return dto
}

export const apiConnectionPublicMetadataBoundaryForTests = {
    assert: assertApiConnectionPublicMetadata,
}
