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
export const REPLAY_CACHE_MAXIMUM = 2048

/**
 * The last instant at which one signed observation can still pass freshness.
 * Replay retention is derived from this, never from a separate duration whose
 * correctness would depend on two constants staying numerically related.
 */
export function latestValidAtV1(observedAt: number): number {
    return observedAt + MAX_OBSERVATION_AGE_MS
}

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

/**
 * A bounded, process-local replay guard. Gravity runs one process for this
 * authority.
 *
 * Each entry carries the exact absolute instant after which its own payload can
 * no longer pass freshness, so an id is forgotten strictly later than the last
 * moment its payload could be replayed. Expiry order is not insertion order -
 * an observation reported with an older timestamp expires sooner - so the sweep
 * examines every entry rather than stopping at the first live one.
 */
export class TelegramAttestationReplayCacheV1 {
    /** attestationId -> the last instant its payload can still pass freshness. */
    private readonly seen = new Map<string, number>()

    constructor(private readonly maximum: number = REPLAY_CACHE_MAXIMUM) {}

    get size(): number {
        return this.seen.size
    }

    /**
     * True when this id has not been accepted while its payload was still
     * capable of passing freshness. An entry is forgotten only once now is
     * strictly past its own validity, so at now === latestValidAt a duplicate
     * is still rejected.
     */
    admit(attestationId: string, nowMs: number, latestValidAt: number): boolean {
        for (const [id, expiresAt] of [...this.seen]) {
            if (nowMs > expiresAt) this.seen.delete(id)
        }
        if (this.seen.has(attestationId)) return false
        this.seen.set(attestationId, latestValidAt)
        while (this.seen.size > this.maximum) {
            let earliestId: string | null = null
            let earliestExpiry = Number.POSITIVE_INFINITY
            for (const [id, expiresAt] of this.seen) {
                if (expiresAt < earliestExpiry) {
                    earliestExpiry = expiresAt
                    earliestId = id
                }
            }
            if (earliestId === null) break
            this.seen.delete(earliestId)
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

