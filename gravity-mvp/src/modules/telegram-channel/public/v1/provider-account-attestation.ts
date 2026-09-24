/**
 * M2A2-TG2B: the owner-side ingress for a provider attestation reported by an
 * authenticated bot runtime.
 *
 * The caller has already proven it holds the shared bot secret. This capability
 * proves the statement itself: that it was signed with a key derived from that
 * secret, that its principal and transport are well formed and distinct, that
 * the observation is fresh against the server clock, and that it has not been
 * seen before. Only then does it reach the provider-account intake, which owns
 * the single durable writer.
 *
 * Nothing here logs the shared secret, the derived key or the signature.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

import {
    ATTEST_TELEGRAM_PROVIDER_ACCOUNT_RESULT_V1,
    TELEGRAM_PROVIDER_ATTESTATION_ACTION_V1,
    TELEGRAM_PROVIDER_ATTESTATION_DOMAIN_V1,
    parseTelegramProviderAttestationPayloadV1,
    type AttestTelegramProviderAccountResultV1,
    type TelegramProviderAttestationOutcomeV1,
    type TelegramProviderAttestationPayloadV1,
} from '@/contracts/telegram-channel/v1'
import { operationalLogV1 } from '@/infrastructure/operations/operational-log'

import { attestTelegramTransportV1 } from '../../internal/provider-account/telegram-account-intake'

export const TELEGRAM_PROVIDER_ATTESTATION_EVENT_V1 = 'telegram_provider_account_ingress'

/** An observation may be this old, and no older. */
export const MAX_OBSERVATION_AGE_MS = 120_000
/** A reporting clock may run this far ahead of the server, and no further. */
export const MAX_OBSERVATION_FUTURE_SKEW_MS = 30_000
/** The replay cache holds an id for as long as it could still be accepted. */
export const REPLAY_RETENTION_MS = MAX_OBSERVATION_AGE_MS + MAX_OBSERVATION_FUTURE_SKEW_MS
export const REPLAY_CACHE_MAXIMUM = 2048

const PROVIDER_USER_ID = /^[0-9]{1,64}$/u
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u

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

function signatureMatches(expected: string, supplied: string): boolean {
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

const globalForReplay = globalThis as unknown as {
    __yokoTelegramAttestationReplayV1?: TelegramAttestationReplayCacheV1
}

function defaultDependencies(): TelegramProviderAttestationDependenciesV1 {
    return {
        secret: () => {
            const configured = process.env.BOT_CRM_SECRET
            return typeof configured === 'string' && configured.trim().length > 0 ? configured : null
        },
        now: () => Date.now(),
        record: attestTelegramTransportV1,
        emit: (event, context) => operationalLogV1('info', event, context),
        replay: globalForReplay.__yokoTelegramAttestationReplayV1
            ?? (globalForReplay.__yokoTelegramAttestationReplayV1 = new TelegramAttestationReplayCacheV1()),
    }
}

function result(outcome: TelegramProviderAttestationOutcomeV1): AttestTelegramProviderAccountResultV1 {
    return { contract: ATTEST_TELEGRAM_PROVIDER_ACCOUNT_RESULT_V1, outcome }
}

/**
 * Validates and records one reported attestation. The order is deliberate:
 * nothing reaches the writer before the statement is proven authentic, well
 * formed, fresh and unseen.
 */
export async function attestTelegramProviderAccountFromBotV1(
    input: { action: unknown; payload: unknown },
    overrides: Partial<TelegramProviderAttestationDependenciesV1> = {},
): Promise<AttestTelegramProviderAccountResultV1> {
    const deps: TelegramProviderAttestationDependenciesV1 = { ...defaultDependencies(), ...overrides }
    const report = (outcome: TelegramProviderAttestationOutcomeV1): AttestTelegramProviderAccountResultV1 => {
        try {
            deps.emit(TELEGRAM_PROVIDER_ATTESTATION_EVENT_V1, { channel: 'telegram', transportKind: 'bot_runtime', outcome })
        } catch {
            // Reporting the decision may not change it.
        }
        return result(outcome)
    }

    if (input.action !== TELEGRAM_PROVIDER_ATTESTATION_ACTION_V1) return report('malformed')
    const payload: TelegramProviderAttestationPayloadV1 | null = parseTelegramProviderAttestationPayloadV1(input.payload)
    if (!payload) return report('malformed')

    const secret = deps.secret()
    if (!secret) return report('unavailable')
    const expected = signTelegramProviderAttestationV1(canonicalTelegramProviderAttestationV1(payload), secret)
    if (!signatureMatches(expected, payload.signature)) return report('unauthenticated')

    if (!PROVIDER_USER_ID.test(payload.providerUserId) || payload.providerUserId === '0') return report('malformed')
    if (payload.transportRef.length > 128) return report('malformed')
    // The transport locator and the provider principal are different entities.
    if (payload.transportRef === payload.providerUserId) return report('malformed')
    if (!UUID.test(payload.attestingInstanceId)) return report('malformed')

    const now = deps.now()
    const age = now - payload.observedAt
    if (age > MAX_OBSERVATION_AGE_MS) return report('stale')
    if (age < -MAX_OBSERVATION_FUTURE_SKEW_MS) return report('stale')

    if (!UUID.test(payload.attestationId)) return report('malformed')
    if (!deps.replay.admit(payload.attestationId, now)) return report('replayed')

    const recorded = await deps.record({
        transportKind: 'bot_runtime',
        transportRef: payload.transportRef,
        accountKind: 'bot_api',
        providerUserId: payload.providerUserId,
        attestingInstanceId: payload.attestingInstanceId,
    })
    return report(recorded.recorded ? 'attested' : 'unavailable')
}

/** The HTTP status an ingress should answer for each outcome. */
export function telegramProviderAttestationStatusV1(outcome: TelegramProviderAttestationOutcomeV1): number {
    if (outcome === 'attested') return 200
    if (outcome === 'unauthenticated') return 401
    if (outcome === 'malformed') return 400
    if (outcome === 'stale') return 400
    if (outcome === 'replayed') return 409
    return 503
}
