const FORBIDDEN_WHATSAPP_PUBLIC_KEYS = new Set(['sessionData'])

function assertWhatsAppPublicMetadata(value: unknown, path = '$', seen = new WeakSet<object>()): void {
    if (value === null || typeof value !== 'object') return
    if (seen.has(value)) return
    seen.add(value)
    for (const [key, entry] of Object.entries(value)) {
        if (FORBIDDEN_WHATSAPP_PUBLIC_KEYS.has(key)) {
            throw new Error(`Credential-bearing key is forbidden in WhatsApp public metadata: ${path}.${key}`)
        }
        assertWhatsAppPublicMetadata(entry, `${path}.${key}`, seen)
    }
}

export interface WhatsAppConnectionPublicMetadata {
    id: string
    name: string | null
    status: string
    phoneNumber: string | null
    createdAt: Date
    updatedAt: Date
    sessionConfigured: boolean
}

export function projectWhatsAppConnectionMetadata(source: {
    id: string
    name: string | null
    status: string
    phoneNumber: string | null
    createdAt: Date
    updatedAt: Date
    sessionConfigured: boolean
}): WhatsAppConnectionPublicMetadata {
    const dto = { ...source }
    assertWhatsAppPublicMetadata(dto)
    return dto
}

export const whatsappPublicMetadataBoundaryForTests = { assert: assertWhatsAppPublicMetadata }
