/**
 * M2A1-S3 intake: the hand-off from the WhatsApp runtime lifecycle to the
 * company-account writer.
 *
 * The runtime supplies the observed values; this module owns everything that
 * follows. It returns immediately and never throws, so a foundation write can
 * never affect the WhatsApp runtime, and it emits only allowlisted classes.
 */
import { operationalLogV1 } from '@/infrastructure/operations/operational-log'

import {
    buildWhatsAppAccountTelemetryV1,
    WHATSAPP_ACCOUNT_TELEMETRY_EVENT_V1,
    WHATSAPP_ACCOUNT_TELEMETRY_REJECTED_EVENT_V1,
} from './whatsapp-account-telemetry'
import { recordWhatsAppAccountAttestationV1, type AttestationResultV1 } from './whatsapp-account-writer'

export interface ObservedAttestationV1 {
    connectionId: string
    instanceId: string
    pnUser: string
    lidUser: string
    /** Supplementary runtime evidence only; never decides identity. */
    unchanged: boolean | null
}

export interface AccountIntakeDependenciesV1 {
    record(input: ObservedAttestationV1): Promise<AttestationResultV1>
    emit(event: string, context: Readonly<Record<string, unknown>>): void
    now(): number
}

function defaultDependencies(): AccountIntakeDependenciesV1 {
    return {
        record: recordWhatsAppAccountAttestationV1,
        emit: (event, context) => operationalLogV1('info', event, context),
        now: () => Date.now(),
    }
}

export function createWhatsAppAccountIntakeV1(deps: AccountIntakeDependenciesV1) {
    return {
        async record(input: ObservedAttestationV1): Promise<void> {
            const startedAt = deps.now()
            let result: AttestationResultV1 | null = null
            try {
                result = await deps.record(input)
            } catch {
                result = null
            }
            try {
                if (result === null) {
                    deps.emit(WHATSAPP_ACCOUNT_TELEMETRY_REJECTED_EVENT_V1, {})
                    return
                }
                deps.emit(WHATSAPP_ACCOUNT_TELEMETRY_EVENT_V1, buildWhatsAppAccountTelemetryV1({
                    connectionId: input.connectionId,
                    action: result.action,
                    outcome: result.outcome,
                    trustStateBefore: result.trustStateBefore,
                    trustStateAfter: result.trustStateAfter,
                    accountLifecycle: result.accountLifecycle,
                    generation: result.generation,
                    operatorConfirmed: result.operatorConfirmed,
                    unchangedSignal: input.unchanged,
                    signalAgreedWithDatabase: result.signalAgreedWithDatabase,
                    durationMs: Math.max(0, deps.now() - startedAt),
                }))
            } catch {
                deps.emit(WHATSAPP_ACCOUNT_TELEMETRY_REJECTED_EVENT_V1, {})
            }
        },
    }
}

const globalForAccountIntake = globalThis as unknown as {
    __yokoWhatsAppAccountIntakeV1?: ReturnType<typeof createWhatsAppAccountIntakeV1>
}

/**
 * Records one observed attestation. Returns immediately and never throws: the
 * WhatsApp runtime must never be affected by a foundation write.
 */
export function recordObservedAttestationV1(input: ObservedAttestationV1): void {
    try {
        const intake = globalForAccountIntake.__yokoWhatsAppAccountIntakeV1
            ?? (globalForAccountIntake.__yokoWhatsAppAccountIntakeV1 = createWhatsAppAccountIntakeV1(defaultDependencies()))
        void intake.record(input).catch(() => undefined)
    } catch {
        // The foundation writer must never affect the WhatsApp runtime.
    }
}
