/**
 * M2A2-TG2B protocol: the exact statement a bot runtime signs, the derived key
 * it signs with, the freshness window the server enforces, and the bounded
 * replay guard. It is internal: the public surface exposes only the business
 * operation that uses it.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

import {
    TELEGRAM_PROVIDER_ATTESTATION_ACTION_V1,
    TELEGRAM_PROVIDER_ATTESTATION_DOMAIN_V1,
} from '@/contracts/telegram-channel/v1'

export const TELEGRAM_PROVIDER_ATTESTATION_EVENT_V1 = 'telegram_provider_account_ingress'

/** An observation may be this old, and no older. */
export const MAX_OBSERVATION_AGE_MS = 120_000
/** A reporting clock may run this far ahead of the server, and no further. */
export const MAX_OBSERVATION_FUTURE_SKEW_MS = 30_000
/** The replay cache holds an id for as long as it could still be accepted. */
export const REPLAY_RETENTION_MS = MAX_OBSERVATION_AGE_MS + MAX_OBSERVATION_FUTURE_SKEW_MS
export const REPLAY_CACHE_MAXIMUM = 2048

export const PROVIDER_USER_ID_PATTERN = /^[0-9]{1,64}$/u
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u

/** The exact bytes both sides sign. Field order and separator are fixed. */
export function canonicalTelegramProviderAttestationV1(payload: {
    providerUserId: string
    transportRef: string
    attestingInstanceId: string
    observedAt: number
    attestationId: string
}): string {
    return [
        TELEGRAM_PROVIDER_ATTESTATION_DOMAIN_V1,
        TELEGRAM_PROVIDER_ATTESTATION_ACTION_V1,
        payload.providerUserId,
        payload.transportRef,
        payload.attestingInstanceId,
        String(payload.observedAt),
        payload.attestationId,
    ].join('\n')
}

/**
 * The signing key is derived from the shared secret, so the bearer value is
 * never used directly as a MAC key.
 */
export function deriveTelegramProviderAttestationKeyV1(secret: string): Buffer {
    return createHash('sha256').update(`${TELEGRAM_PROVIDER_ATTESTATION_DOMAIN_V1}|${secret}`).digest()
}

export function signTelegramProviderAttestationV1(canonical: string, secret: string): string {
    return createHmac('sha256', deriveTelegramProviderAttestationKeyV1(secret)).update(canonical).digest('base64url')
}

export function signatureMatches(expected: string, supplied: string): boolean {
    const left = Buffer.from(expected)
    const right = Buffer.from(supplied)
    return left.length === right.length && timingSafeEqual(left, right)
}

/** A bounded, process-local replay guard. Gravity runs one process for this authority. */
export class TelegramAttestationReplayCacheV1 {
    private readonly seen = new Map<string, number>()

    constructor(
        private readonly maximum: number = REPLAY_CACHE_MAXIMUM,
        private readonly retentionMs: number = REPLAY_RETENTION_MS,
    ) {}

    get size(): number {
        return this.seen.size
    }

    /** True when this id has not been accepted inside the retention window. */
    admit(attestationId: string, nowMs: number): boolean {
        for (const [id, seenAt] of this.seen) {
            if (nowMs - seenAt >= this.retentionMs) this.seen.delete(id)
            else break
        }
        const previous = this.seen.get(attestationId)
        if (previous !== undefined && nowMs - previous < this.retentionMs) return false
        this.seen.delete(attestationId)
        this.seen.set(attestationId, nowMs)
        while (this.seen.size > this.maximum) {
            const oldest = this.seen.keys().next().value
            if (oldest === undefined) break
            this.seen.delete(oldest)
        }
        return true
    }
}

export interface TelegramProviderAttestationDependenciesV1 {
    secret(): string | null
    now(): number
    record(input: {
        transportKind: 'bot_runtime'
        transportRef: string
        accountKind: 'bot_api'
        providerUserId: string
        attestingInstanceId: string
    }): Promise<{ recorded: boolean; outcome: string }>
    emit(event: string, context: Readonly<Record<string, unknown>>): void
    replay: TelegramAttestationReplayCacheV1
}

