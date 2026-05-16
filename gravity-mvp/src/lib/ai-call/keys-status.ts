/**
 * Read-only access to AI-call API key configuration.
 *
 * Secrets live in process.env — never in DB, never in client bundle. This
 * module returns only enough metadata for the settings UI to show a status
 * ("настроено" / "не настроено") and the last 4 characters of each key, so
 * the user can verify which key is loaded without exposing the secret.
 *
 * Why no setter / DB persistence:
 *   1. .env is the single source of truth across processes (CRM dev,
 *      audio bridge, future workers). Storing keys in DB would create a
 *      consistency problem.
 *   2. Encrypting + persisting secrets requires a KMS or master key, which
 *      is out of scope for MVP.
 *   3. Restarting the dev server to pick up a new key is acceptable for
 *      an internal CRM with a few admin users.
 */

export type KeyStatus =
    | { configured: true; mask: string; envName: string }
    | { configured: false; mask: null; envName: string }

export interface AiCallKeysStatus {
    openai: KeyStatus
    yandexSpeechkit: KeyStatus
    yandexFolderId: {
        configured: boolean
        // Folder ID is not a secret — full value is safe to expose.
        value: string | null
        envName: string
    }
    mockMode: {
        enabled: boolean
        envName: string
    }
}

/**
 * Mask a secret so the last 4 chars remain visible. Returns null for empty.
 * Examples:
 *   "sk-proj-aBcDeFgHiJk" -> "•••• HiJk"
 *   "ABC"                  -> "•••• ABC"   (whole value if shorter than 4)
 */
export function maskSecret(value: string | undefined | null): string | null {
    if (!value) return null
    const trimmed = value.trim()
    if (!trimmed) return null
    const tail = trimmed.length >= 4 ? trimmed.slice(-4) : trimmed
    return `•••• ${tail}`
}

export function getAiCallKeysStatus(): AiCallKeysStatus {
    const openaiRaw = process.env.OPENAI_API_KEY
    const yandexRaw = process.env.YANDEX_API_KEY
    const folderRaw = process.env.YANDEX_FOLDER_ID
    const mockRaw = process.env.AI_CALL_MOCK_MODE

    return {
        openai: openaiRaw
            ? { configured: true, mask: maskSecret(openaiRaw)!, envName: 'OPENAI_API_KEY' }
            : { configured: false, mask: null, envName: 'OPENAI_API_KEY' },
        yandexSpeechkit: yandexRaw
            ? { configured: true, mask: maskSecret(yandexRaw)!, envName: 'YANDEX_API_KEY' }
            : { configured: false, mask: null, envName: 'YANDEX_API_KEY' },
        yandexFolderId: {
            configured: !!folderRaw?.trim(),
            value: folderRaw?.trim() || null,
            envName: 'YANDEX_FOLDER_ID',
        },
        mockMode: {
            enabled: mockRaw === 'true',
            envName: 'AI_CALL_MOCK_MODE',
        },
    }
}
