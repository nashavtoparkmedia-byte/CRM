/**
 * M2A2-TG2A intake: the hand-off from the Telegram runtime and from the
 * authenticated login ceremony to the TG1 provider-account writer.
 *
 * Two orchestration modes over ONE writer, and no second identity write path:
 *
 *  - `recordObservedAttestationV1` is fire-and-forget. It returns immediately,
 *    never throws and swallows every failure, so a foundation write can never
 *    degrade Telegram availability — including while the foundation tables do
 *    not exist yet.
 *  - `admitTelegramProviderAccountV1` is synchronous. It is used only by an
 *    authenticated integration-admin ceremony, awaits the durable attestation,
 *    reads the projection back and only then admits. It reports what it proved
 *    and never reports a pending account it did not observe.
 *
 * Telemetry deliberately omits the transport locator: for an MTProto slot that
 * locator is the connection row id, whose production value is currently equal
 * to the provider account id, and the provider id may not leave this boundary.
 */
import { operationalLogV1 } from '@/infrastructure/operations/operational-log'

import type {
    TelegramAccountKindV1,
    TelegramTransportKindV1,
} from './telegram-account-identity'
import {
    admitTelegramAccountV1,
    readProviderAccountProjectionV1,
    recordTelegramTransportAttestationV1,
    type AttestationResultV1,
    type ProviderAccountProjectionV1,
} from './telegram-account-writer'

export const TELEGRAM_ACCOUNT_TELEMETRY_EVENT_V1 = 'telegram_provider_account_attestation'
export const TELEGRAM_ACCOUNT_TELEMETRY_REJECTED_EVENT_V1 = 'telegram_provider_account_attestation_rejected'
export const TELEGRAM_ADMISSION_TELEMETRY_EVENT_V1 = 'telegram_provider_account_admission'

/** One observation of a live provider authentication, as the runtime saw it. */
export interface ObservedAttestationV1 {
    transportKind: TelegramTransportKindV1
    /** A locator only. It is read from the transport record, never from the principal. */
    transportRef: string
    accountKind: TelegramAccountKindV1
    /** Exactly what the live getMe returned. */
    providerUserId: string
    attestingInstanceId: string
}

/**
 * The orchestration modes over the single writer. `runtime` is fire-and-forget
 * from a Telegram runtime, `ceremony` is the authenticated admission sequence,
 * and `ingress` is an authenticated cross-process report that is awaited so the
 * caller can answer its own request.
 */
export type TelegramIntakeModeV1 = 'runtime' | 'ceremony' | 'ingress'

export type TelegramAdmissionStatusV1 = 'admitted' | 'pending_approval' | 'unavailable'

export const TELEGRAM_ADMISSION_REASONS_V1 = [
    'admitted',
    'already_active',
    'principal_observation_disagreed',
    'principal_unproven',
    'transport_unavailable',
    'attestation_unavailable',
    'attestation_refused',
    'projection_unavailable',
    'account_absent',
    'lifecycle_not_admissible',
    'admission_unavailable',
] as const
export type TelegramAdmissionReasonV1 = (typeof TELEGRAM_ADMISSION_REASONS_V1)[number]

export interface TelegramAdmissionResultV1 {
    status: TelegramAdmissionStatusV1
    reason: TelegramAdmissionReasonV1
}

export interface AdmitProviderAccountInputV1 extends ObservedAttestationV1 {
    /**
     * The principal a previous live observation in the same ceremony reported,
     * held in memory by the caller. It is never read back from a stored row, so
     * a transport record can never become an identity source. Null when the
     * ceremony made only one observation.
     */
    previouslyObservedProviderUserId?: string | null
}

/** What an operator surface may learn about one transport's account. */
export interface TelegramProviderAccountStateV1 {
    available: boolean
    providerAccountId: string | null
    accountKind: ProviderAccountProjectionV1['accountKind']
    lifecycle: string | null
    readiness: ProviderAccountProjectionV1['readiness'] | null
}

export interface AccountIntakeDependenciesV1 {
    record(input: ObservedAttestationV1): Promise<AttestationResultV1>
    project(transportKind: TelegramTransportKindV1, transportRef: string): Promise<ProviderAccountProjectionV1>
    admit(input: { accountId: string; principalId: string }): Promise<{ outcome: string; lifecycle: string }>
    emit(level: 'info' | 'warn', event: string, context: Readonly<Record<string, unknown>>): void
    now(): number
}

function defaultDependencies(): AccountIntakeDependenciesV1 {
    return {
        record: recordTelegramTransportAttestationV1,
        project: readProviderAccountProjectionV1,
        admit: admitTelegramAccountV1,
        emit: (level, event, context) => operationalLogV1(level, event, context),
        now: () => Date.now(),
    }
}

/** The bounded telemetry shape. It carries no principal and no locator. */
function attestationTelemetry(input: {
    transportKind: TelegramTransportKindV1
    mode: TelegramIntakeModeV1
    result: AttestationResultV1
    durationMs: number
}): Record<string, unknown> {
    return {
        channel: 'telegram',
        transportKind: input.transportKind,
        mode: input.mode,
        action: input.result.action,
        outcome: input.result.outcome,
        accountLifecycle: input.result.accountLifecycle,
        trustStateAfter: input.result.trustStateAfter,
        generation: input.result.generation,
        principalChanged: input.result.principalChanged,
        durationMs: input.durationMs,
    }
}

export function createTelegramAccountIntakeV1(deps: AccountIntakeDependenciesV1) {
    async function attest(
        input: ObservedAttestationV1,
        mode: TelegramIntakeModeV1,
    ): Promise<AttestationResultV1> {
        const startedAt = deps.now()
        const result = await deps.record({
            transportKind: input.transportKind,
            transportRef: input.transportRef,
            accountKind: input.accountKind,
            providerUserId: input.providerUserId,
            attestingInstanceId: input.attestingInstanceId,
        })
        deps.emit('info', TELEGRAM_ACCOUNT_TELEMETRY_EVENT_V1, attestationTelemetry({
            transportKind: input.transportKind,
            mode,
            result,
            durationMs: Math.max(0, deps.now() - startedAt),
        }))
        return result
    }

    return {
        /** Fire-and-forget. Never throws, never reports a failure to the runtime. */
        async observe(input: ObservedAttestationV1): Promise<void> {
            try {
                await attest(input, 'runtime')
            } catch {
                try {
                    deps.emit('warn', TELEGRAM_ACCOUNT_TELEMETRY_REJECTED_EVENT_V1, {
                        channel: 'telegram',
                        transportKind: input.transportKind,
                        mode: 'runtime',
                    })
                } catch {
                    // Telemetry must not become a second failure path.
                }
            }
        },

        /**
         * Awaited attestation without admission, for an authenticated ingress
         * that must answer its own request. It surfaces the writer's outcome
         * and never admits: lifecycle stays an operator decision.
         */
        async attestTransport(input: ObservedAttestationV1): Promise<AttestationResultV1> {
            return await attest(input, 'ingress')
        },

        /** Synchronous admission. Surfaces exactly what it proved. */
        async admit(input: AdmitProviderAccountInputV1, principalId: string): Promise<TelegramAdmissionResultV1> {
            const previous = input.previouslyObservedProviderUserId ?? null
            if (previous !== null && previous !== input.providerUserId) {
                deps.emit('warn', TELEGRAM_ADMISSION_TELEMETRY_EVENT_V1, {
                    channel: 'telegram',
                    transportKind: input.transportKind,
                    status: 'unavailable',
                    reason: 'principal_observation_disagreed',
                })
                return { status: 'unavailable', reason: 'principal_observation_disagreed' }
            }

            const finish = (result: TelegramAdmissionResultV1): TelegramAdmissionResultV1 => {
                try {
                    deps.emit('info', TELEGRAM_ADMISSION_TELEMETRY_EVENT_V1, {
                        channel: 'telegram',
                        transportKind: input.transportKind,
                        status: result.status,
                        reason: result.reason,
                    })
                } catch {
                    // Reporting the decision may not change it.
                }
                return result
            }

            let attestation: AttestationResultV1
            try {
                attestation = await attest(input, 'ceremony')
            } catch (error) {
                const refused = (error as { name?: unknown } | null)?.name === 'TelegramAccountRefusalV1'
                return finish({
                    status: 'unavailable',
                    reason: refused ? 'attestation_refused' : 'attestation_unavailable',
                })
            }
            if (attestation.trustStateAfter !== 'verified') {
                return finish({ status: 'unavailable', reason: 'attestation_refused' })
            }

            let projection: ProviderAccountProjectionV1
            try {
                projection = await deps.project(input.transportKind, input.transportRef)
            } catch {
                return finish({ status: 'unavailable', reason: 'projection_unavailable' })
            }
            const accountId = projection.providerAccountId
            if (accountId === null || projection.accountKind !== input.accountKind) {
                return finish({ status: 'unavailable', reason: 'account_absent' })
            }

            // A durable account is now proven to exist. Only from here may a
            // failure be reported as pending rather than unavailable.
            const durablyPending = projection.lifecycle === 'pending_approval'

            try {
                const admitted = await deps.admit({ accountId, principalId })
                if (admitted.outcome === 'admitted') return finish({ status: 'admitted', reason: 'admitted' })
                if (admitted.outcome === 'already_active') return finish({ status: 'admitted', reason: 'already_active' })
                if (admitted.outcome === 'account_not_found') return finish({ status: 'unavailable', reason: 'account_absent' })
                return finish(durablyPending
                    ? { status: 'pending_approval', reason: 'admission_unavailable' }
                    : { status: 'unavailable', reason: 'lifecycle_not_admissible' })
            } catch {
                return finish(durablyPending
                    ? { status: 'pending_approval', reason: 'admission_unavailable' }
                    : { status: 'unavailable', reason: 'admission_unavailable' })
            }
        },

        /** Operator display only. Admission never trusts this read. */
        async describe(transportKind: TelegramTransportKindV1, transportRef: string): Promise<TelegramProviderAccountStateV1> {
            try {
                const projection = await deps.project(transportKind, transportRef)
                return {
                    available: true,
                    providerAccountId: projection.providerAccountId,
                    accountKind: projection.accountKind,
                    lifecycle: projection.lifecycle,
                    readiness: projection.readiness,
                }
            } catch {
                return { available: false, providerAccountId: null, accountKind: null, lifecycle: null, readiness: null }
            }
        },
    }
}

const globalForAccountIntake = globalThis as unknown as {
    __yokoTelegramAccountIntakeV1?: ReturnType<typeof createTelegramAccountIntakeV1>
}

function intake(): ReturnType<typeof createTelegramAccountIntakeV1> {
    return globalForAccountIntake.__yokoTelegramAccountIntakeV1
        ?? (globalForAccountIntake.__yokoTelegramAccountIntakeV1 = createTelegramAccountIntakeV1(defaultDependencies()))
}

/**
 * Records one observed attestation. Returns immediately and never throws: the
 * Telegram runtime must never be affected by a foundation write.
 */
export function recordObservedAttestationV1(input: ObservedAttestationV1): void {
    try {
        void intake().observe(input).catch(() => undefined)
    } catch {
        // The foundation writer must never affect the Telegram runtime.
    }
}

/**
 * Attests and admits in one awaited sequence, for an authenticated
 * integration-admin ceremony only.
 */
export async function admitTelegramProviderAccountV1(
    input: AdmitProviderAccountInputV1,
    principalId: string,
): Promise<TelegramAdmissionResultV1> {
    return await intake().admit(input, principalId)
}

/**
 * Records one attestation reported by an authenticated cross-process runtime.
 * It is awaited by its caller, so it reports a bounded outcome instead of a
 * raw failure, and it never admits an account.
 */
export async function attestTelegramTransportV1(
    input: ObservedAttestationV1,
): Promise<{ recorded: boolean; outcome: string }> {
    try {
        const result = await intake().attestTransport(input)
        return { recorded: result.trustStateAfter === 'verified', outcome: result.outcome }
    } catch (error) {
        const refused = (error as { name?: unknown } | null)?.name === 'TelegramAccountRefusalV1'
        return { recorded: false, outcome: refused ? 'attestation_refused' : 'attestation_unavailable' }
    }
}

/** Reads one transport's account state for an operator surface. Never throws. */
export async function describeTelegramProviderAccountV1(
    transportKind: TelegramTransportKindV1,
    transportRef: string,
): Promise<TelegramProviderAccountStateV1> {
    return await intake().describe(transportKind, transportRef)
}
