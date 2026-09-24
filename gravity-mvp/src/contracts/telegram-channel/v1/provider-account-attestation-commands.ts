export const ATTEST_TELEGRAM_PROVIDER_ACCOUNT_RESULT_V1 = 'telegram_channel.AttestTelegramProviderAccountResult.v1' as const

/** The exact domain and action the signed statement covers. */
export const TELEGRAM_PROVIDER_ATTESTATION_DOMAIN_V1 = 'yoko-telegram-provider-attestation:v1' as const
export const TELEGRAM_PROVIDER_ATTESTATION_ACTION_V1 = 'attest_provider_account' as const

/**
 * One live provider observation, as a bot runtime reports it over the
 * authenticated bot boundary. It carries no credential: the shared secret
 * authenticates the caller and derives the signing key, and never travels.
 */
export interface TelegramProviderAttestationPayloadV1 {
    domain: typeof TELEGRAM_PROVIDER_ATTESTATION_DOMAIN_V1
    action: typeof TELEGRAM_PROVIDER_ATTESTATION_ACTION_V1
    /** Exactly what the bot's live getMe returned. */
    providerUserId: string
    /** A configured transport locator. Never the principal. */
    transportRef: string
    /** The reporting runtime instance, minted once per bot process. */
    attestingInstanceId: string
    /** Epoch milliseconds of the live observation. */
    observedAt: number
    /** Unique per observation; the replay key. */
    attestationId: string
    /** base64url HMAC-SHA256 over the canonical statement. */
    signature: string
}

export const TELEGRAM_PROVIDER_ATTESTATION_OUTCOMES_V1 = [
    'attested',
    'unauthenticated',
    'malformed',
    'stale',
    'replayed',
    'unavailable',
] as const
export type TelegramProviderAttestationOutcomeV1 = (typeof TELEGRAM_PROVIDER_ATTESTATION_OUTCOMES_V1)[number]

export interface AttestTelegramProviderAccountResultV1 {
    contract: typeof ATTEST_TELEGRAM_PROVIDER_ACCOUNT_RESULT_V1
    outcome: TelegramProviderAttestationOutcomeV1
}

const PAYLOAD_FIELDS = [
    'domain', 'action', 'providerUserId', 'transportRef',
    'attestingInstanceId', 'observedAt', 'attestationId', 'signature',
] as const

/**
 * Shape validation only. It proves the request is the command it claims to be;
 * authenticity, freshness and replay are decided by the owning capability.
 */
export function parseTelegramProviderAttestationPayloadV1(input: unknown): TelegramProviderAttestationPayloadV1 | null {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null
    const value = input as Record<string, unknown>
    if (Object.keys(value).some((key) => !(PAYLOAD_FIELDS as readonly string[]).includes(key))) return null
    if (value.domain !== TELEGRAM_PROVIDER_ATTESTATION_DOMAIN_V1) return null
    if (value.action !== TELEGRAM_PROVIDER_ATTESTATION_ACTION_V1) return null
    for (const key of ['providerUserId', 'transportRef', 'attestingInstanceId', 'attestationId', 'signature'] as const) {
        const field = value[key]
        if (typeof field !== 'string' || field.length === 0 || field.length > 256 || field !== field.trim()) return null
        if (/[\p{Cc}]/u.test(field)) return null
    }
    if (typeof value.observedAt !== 'number' || !Number.isSafeInteger(value.observedAt) || value.observedAt <= 0) return null
    return value as unknown as TelegramProviderAttestationPayloadV1
}
