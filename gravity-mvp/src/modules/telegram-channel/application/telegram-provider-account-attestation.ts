/**
 * M2A2-TG2B: the owner-side ingress for a provider attestation reported by an
 * authenticated bot runtime.
 *
 * The caller has already proven it holds the shared bot secret. This
 * composition proves the statement itself - signed with a key derived from that
 * secret, well formed, distinct in transport and principal, fresh against the
 * server clock and unseen - and only then hands it to the provider-account
 * intake, which owns the single durable writer.
 *
 * Nothing here logs the shared secret, the derived key or the signature.
 */
import {
    ATTEST_TELEGRAM_PROVIDER_ACCOUNT_RESULT_V1,
    TELEGRAM_PROVIDER_ATTESTATION_ACTION_V1,
    parseTelegramProviderAttestationPayloadV1,
    type AttestTelegramProviderAccountResultV1,
    type TelegramProviderAttestationOutcomeV1,
    type TelegramProviderAttestationPayloadV1,
} from '@/contracts/telegram-channel/v1'
import { operationalLogV1 } from '@/infrastructure/operations/operational-log'

import {
    canonicalTelegramProviderAttestationV1,
    signTelegramProviderAttestationV1,
    signatureMatches,
    TelegramAttestationReplayCacheV1,
    TELEGRAM_PROVIDER_ATTESTATION_EVENT_V1,
    MAX_OBSERVATION_AGE_MS,
    MAX_OBSERVATION_FUTURE_SKEW_MS,
    PROVIDER_USER_ID_PATTERN,
    UUID_PATTERN,
    type TelegramProviderAttestationDependenciesV1,
} from '../internal/bot-attestation/telegram-bot-attestation-protocol'
import { attestTelegramTransportV1 } from '../internal/provider-account/telegram-account-intake'

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
        return { contract: ATTEST_TELEGRAM_PROVIDER_ACCOUNT_RESULT_V1, outcome }
    }

    if (input.action !== TELEGRAM_PROVIDER_ATTESTATION_ACTION_V1) return report('malformed')
    const payload: TelegramProviderAttestationPayloadV1 | null = parseTelegramProviderAttestationPayloadV1(input.payload)
    if (!payload) return report('malformed')

    const secret = deps.secret()
    if (!secret) return report('unavailable')
    const expected = signTelegramProviderAttestationV1(canonicalTelegramProviderAttestationV1(payload), secret)
    if (!signatureMatches(expected, payload.signature)) return report('unauthenticated')

    if (!PROVIDER_USER_ID_PATTERN.test(payload.providerUserId) || payload.providerUserId === '0') return report('malformed')
    if (payload.transportRef.length > 128) return report('malformed')
    // The transport locator and the provider principal are different entities.
    if (payload.transportRef === payload.providerUserId) return report('malformed')
    if (!UUID_PATTERN.test(payload.attestingInstanceId)) return report('malformed')

    const now = deps.now()
    const age = now - payload.observedAt
    if (age > MAX_OBSERVATION_AGE_MS) return report('stale')
    if (age < -MAX_OBSERVATION_FUTURE_SKEW_MS) return report('stale')

    if (!UUID_PATTERN.test(payload.attestationId)) return report('malformed')
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
