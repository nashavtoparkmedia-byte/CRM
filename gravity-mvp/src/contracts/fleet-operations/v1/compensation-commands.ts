/**
 * Fleet Operations cash-compensation monetary commands.
 *
 * Each command carries a closed field set and is validated before any lock is
 * taken. Submit is idempotent on a caller-generated key; every manager
 * operation is idempotent on the natural identity of the thing it acts on.
 */

export const SUBMIT_COMPENSATION_APPLICATION_COMMAND_V1 = 'fleet_operations.SubmitCompensationApplicationCommand.v1' as const
export const SUBMIT_COMPENSATION_APPLICATION_RESULT_V1 = 'fleet_operations.SubmitCompensationApplicationResult.v1' as const
export const START_COMPENSATION_PAYOUT_COMMAND_V1 = 'fleet_operations.StartCompensationPayoutCommand.v1' as const
export const START_COMPENSATION_PAYOUT_RESULT_V1 = 'fleet_operations.StartCompensationPayoutResult.v1' as const
export const FINALIZE_COMPENSATION_PAYOUT_COMMAND_V1 = 'fleet_operations.FinalizeCompensationPayoutCommand.v1' as const
export const FINALIZE_COMPENSATION_PAYOUT_RESULT_V1 = 'fleet_operations.FinalizeCompensationPayoutResult.v1' as const
export const RELEASE_COMPENSATION_PAYOUT_COMMAND_V1 = 'fleet_operations.ReleaseCompensationPayoutCommand.v1' as const
export const RELEASE_COMPENSATION_PAYOUT_RESULT_V1 = 'fleet_operations.ReleaseCompensationPayoutResult.v1' as const
export const REJECT_COMPENSATION_APPLICATION_COMMAND_V1 = 'fleet_operations.RejectCompensationApplicationCommand.v1' as const
export const REJECT_COMPENSATION_APPLICATION_RESULT_V1 = 'fleet_operations.RejectCompensationApplicationResult.v1' as const
export const RESOLVE_COMPENSATION_RECONCILIATION_COMMAND_V1 = 'fleet_operations.ResolveCompensationReconciliationCommand.v1' as const
export const RESOLVE_COMPENSATION_RECONCILIATION_RESULT_V1 = 'fleet_operations.ResolveCompensationReconciliationResult.v1' as const

export const COMPENSATION_PAYOUT_RELEASE_KINDS_V1 = ['cancel_preparation', 'declare_outcome_unknown'] as const
export type CompensationPayoutReleaseKindV1 = typeof COMPENSATION_PAYOUT_RELEASE_KINDS_V1[number]

export const COMPENSATION_RECONCILIATION_RESOLUTIONS_V1 = ['paid', 'not_paid'] as const
export type CompensationReconciliationResolutionV1 = typeof COMPENSATION_RECONCILIATION_RESOLUTIONS_V1[number]

export interface CompensationPrincipalInputV1 {
    principalId: string
    principalKind: 'crm_user' | 'integration_admin' | 'system'
    operatorLabel: string | null
}

/** A cash order already verified by a trusted provider adapter. */
export interface VerifiedCashOrderInputV1 {
    provider: string
    externalParkId: string
    externalOrderId: string
    shortOrderIdDisplay: string | null
    rawPrice: string
    endedAt: Date
    verifiedAt: Date
}

/** Canonical-person evidence as Contacts will supply it. */
export interface ProvenCanonicalPersonInputV1 {
    canonicalContactId: string
    resolutionStatus: 'live' | 'merged_into'
    lineage: readonly string[]
    lineageDigest: string
    evidenceAt: Date
}

export interface SubmitCompensationApplicationCommandV1 {
    contract: typeof SUBMIT_COMPENSATION_APPLICATION_COMMAND_V1
    /** Caller-generated UUID, stable across retries of the same logical submit. */
    idempotencyKey: string
    person: ProvenCanonicalPersonInputV1
    order: VerifiedCashOrderInputV1
    /** Whole rubles, as entered by the driver. */
    claimedRubles: number
    submittedAt: Date
}

export interface SubmitCompensationApplicationResultV1 {
    contract: typeof SUBMIT_COMPENSATION_APPLICATION_RESULT_V1
    status: 'created' | 'replayed'
    applicationId: string
    compensationPersonId: string
    amountKopecks: number
    attemptNo: 1 | 2
    budgetPeriodKey: string
}

export interface StartCompensationPayoutCommandV1 {
    contract: typeof START_COMPENSATION_PAYOUT_COMMAND_V1
    applicationId: string
    principal: CompensationPrincipalInputV1
    startedAt: Date
}

export interface StartCompensationPayoutResultV1 {
    contract: typeof START_COMPENSATION_PAYOUT_RESULT_V1
    status: 'opened' | 'replayed'
    payoutAuthorizationId: string
    authorizationFence: string
    amountKopecks: number
    /** Business day this payout consumes. Shown to the operator before paying. */
    intendedBusinessDay: string
    expiresAt: Date
}

export interface FinalizeCompensationPayoutCommandV1 {
    contract: typeof FINALIZE_COMPENSATION_PAYOUT_COMMAND_V1
    payoutAuthorizationId: string
    authorizationFence: string
    principal: CompensationPrincipalInputV1
    finalizedAt: Date
}

export interface FinalizeCompensationPayoutResultV1 {
    contract: typeof FINALIZE_COMPENSATION_PAYOUT_RESULT_V1
    status: 'settled' | 'replayed'
    settlementId: string
    applicationId: string
    amountKopecks: number
    businessDay: string
}

export interface ReleaseCompensationPayoutCommandV1 {
    contract: typeof RELEASE_COMPENSATION_PAYOUT_COMMAND_V1
    payoutAuthorizationId: string
    authorizationFence: string
    kind: CompensationPayoutReleaseKindV1
    reason: string
    principal: CompensationPrincipalInputV1
    releasedAt: Date
}

export interface ReleaseCompensationPayoutResultV1 {
    contract: typeof RELEASE_COMPENSATION_PAYOUT_RESULT_V1
    status: 'cancelled' | 'reconciliation_opened' | 'replayed'
    payoutAuthorizationId: string
    reconciliationTaskId: string | null
}

export interface RejectCompensationApplicationCommandV1 {
    contract: typeof REJECT_COMPENSATION_APPLICATION_COMMAND_V1
    applicationId: string
    /** Caller-generated UUID; a repeat of the same rejection is harmless. */
    rejectionKey: string
    reason: string
    principal: CompensationPrincipalInputV1
    rejectedAt: Date
}

export interface RejectCompensationApplicationResultV1 {
    contract: typeof REJECT_COMPENSATION_APPLICATION_RESULT_V1
    status: 'rejected' | 'replayed'
    applicationId: string
    releasedKopecks: number
}

export interface ResolveCompensationReconciliationCommandV1 {
    contract: typeof RESOLVE_COMPENSATION_RECONCILIATION_COMMAND_V1
    reconciliationTaskId: string
    resolution: CompensationReconciliationResolutionV1
    resolutionEvidence: string
    principal: CompensationPrincipalInputV1
    resolvedAt: Date
}

export interface ResolveCompensationReconciliationResultV1 {
    contract: typeof RESOLVE_COMPENSATION_RECONCILIATION_RESULT_V1
    status: 'settled' | 'released' | 'replayed'
    reconciliationTaskId: string
    settlementId: string | null
}

export class CompensationCommandValidationErrorV1 extends Error {
    readonly code: 'INVALID_CONTRACT' | 'UNSUPPORTED_CONTRACT_VERSION'
    constructor(code: CompensationCommandValidationErrorV1['code'], message: string) {
        super(message)
        this.name = 'CompensationCommandValidationErrorV1'
        this.code = code
    }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)

function invalid(message: string): never {
    throw new CompensationCommandValidationErrorV1('INVALID_CONTRACT', message)
}

function assertContract(input: Record<string, unknown>, expected: string, family: string): void {
    if (input.contract === expected) return
    if (typeof input.contract === 'string' && input.contract.startsWith(family)) {
        throw new CompensationCommandValidationErrorV1(
            'UNSUPPORTED_CONTRACT_VERSION',
            `unsupported contract version: ${input.contract}`,
        )
    }
    invalid(`contract must equal ${expected}`)
}

function assertShape(input: unknown, fields: readonly string[], expected: string, family: string): Record<string, unknown> {
    if (!isRecord(input)) invalid('command must be an object')
    const allowed = new Set(fields)
    const unexpected = Object.keys(input).filter((key) => !allowed.has(key))
    if (unexpected.length > 0) invalid(`unsupported command field(s): ${unexpected.sort().join(', ')}`)
    assertContract(input, expected, family)
    return input
}

function requiredString(value: unknown, label: string): string {
    if (typeof value !== 'string' || value.trim() === '') invalid(`${label} is required`)
    return value as string
}

function requiredDate(value: unknown, label: string): Date {
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) invalid(`${label} must be a valid Date`)
    return value as Date
}

function nullableString(value: unknown, label: string): string | null {
    if (value === null) return null
    if (typeof value !== 'string') invalid(`${label} must be a string or null`)
    return value as string
}

function requiredPrincipal(value: unknown): CompensationPrincipalInputV1 {
    if (!isRecord(value)) invalid('principal must be an object')
    const kind = value.principalKind
    if (kind !== 'crm_user' && kind !== 'integration_admin' && kind !== 'system') {
        invalid('principal.principalKind is invalid')
    }
    return {
        principalId: requiredString(value.principalId, 'principal.principalId'),
        principalKind: kind,
        operatorLabel: nullableString(value.operatorLabel, 'principal.operatorLabel'),
    }
}

function requiredVerifiedOrder(value: unknown): VerifiedCashOrderInputV1 {
    if (!isRecord(value)) invalid('order must be an object')
    return {
        provider: requiredString(value.provider, 'order.provider'),
        externalParkId: requiredString(value.externalParkId, 'order.externalParkId'),
        externalOrderId: requiredString(value.externalOrderId, 'order.externalOrderId'),
        shortOrderIdDisplay: nullableString(value.shortOrderIdDisplay, 'order.shortOrderIdDisplay'),
        rawPrice: requiredString(value.rawPrice, 'order.rawPrice'),
        endedAt: requiredDate(value.endedAt, 'order.endedAt'),
        verifiedAt: requiredDate(value.verifiedAt, 'order.verifiedAt'),
    }
}

function requiredPerson(value: unknown): ProvenCanonicalPersonInputV1 {
    if (!isRecord(value)) invalid('person must be an object')
    const status = value.resolutionStatus
    if (status !== 'live' && status !== 'merged_into') invalid('person.resolutionStatus is invalid')
    if (!Array.isArray(value.lineage)) invalid('person.lineage must be an array')
    const lineage = (value.lineage as unknown[]).map((entry, index) =>
        requiredString(entry, `person.lineage[${index}]`))
    return {
        canonicalContactId: requiredString(value.canonicalContactId, 'person.canonicalContactId'),
        resolutionStatus: status,
        lineage,
        lineageDigest: requiredString(value.lineageDigest, 'person.lineageDigest'),
        evidenceAt: requiredDate(value.evidenceAt, 'person.evidenceAt'),
    }
}

const SUBMIT_FIELDS = ['contract', 'idempotencyKey', 'person', 'order', 'claimedRubles', 'submittedAt'] as const

export function parseSubmitCompensationApplicationCommandV1(input: unknown): SubmitCompensationApplicationCommandV1 {
    const record = assertShape(
        input,
        SUBMIT_FIELDS,
        SUBMIT_COMPENSATION_APPLICATION_COMMAND_V1,
        'fleet_operations.SubmitCompensationApplicationCommand.',
    )
    if (typeof record.claimedRubles !== 'number' || !Number.isInteger(record.claimedRubles)) {
        invalid('claimedRubles must be a whole number of rubles')
    }
    return {
        contract: SUBMIT_COMPENSATION_APPLICATION_COMMAND_V1,
        idempotencyKey: requiredString(record.idempotencyKey, 'idempotencyKey'),
        person: requiredPerson(record.person),
        order: requiredVerifiedOrder(record.order),
        claimedRubles: record.claimedRubles,
        submittedAt: requiredDate(record.submittedAt, 'submittedAt'),
    }
}

const START_FIELDS = ['contract', 'applicationId', 'principal', 'startedAt'] as const

export function parseStartCompensationPayoutCommandV1(input: unknown): StartCompensationPayoutCommandV1 {
    const record = assertShape(
        input,
        START_FIELDS,
        START_COMPENSATION_PAYOUT_COMMAND_V1,
        'fleet_operations.StartCompensationPayoutCommand.',
    )
    return {
        contract: START_COMPENSATION_PAYOUT_COMMAND_V1,
        applicationId: requiredString(record.applicationId, 'applicationId'),
        principal: requiredPrincipal(record.principal),
        startedAt: requiredDate(record.startedAt, 'startedAt'),
    }
}

const FINALIZE_FIELDS = ['contract', 'payoutAuthorizationId', 'authorizationFence', 'principal', 'finalizedAt'] as const

export function parseFinalizeCompensationPayoutCommandV1(input: unknown): FinalizeCompensationPayoutCommandV1 {
    const record = assertShape(
        input,
        FINALIZE_FIELDS,
        FINALIZE_COMPENSATION_PAYOUT_COMMAND_V1,
        'fleet_operations.FinalizeCompensationPayoutCommand.',
    )
    return {
        contract: FINALIZE_COMPENSATION_PAYOUT_COMMAND_V1,
        payoutAuthorizationId: requiredString(record.payoutAuthorizationId, 'payoutAuthorizationId'),
        authorizationFence: requiredString(record.authorizationFence, 'authorizationFence'),
        principal: requiredPrincipal(record.principal),
        finalizedAt: requiredDate(record.finalizedAt, 'finalizedAt'),
    }
}

const RELEASE_FIELDS = ['contract', 'payoutAuthorizationId', 'authorizationFence', 'kind', 'reason', 'principal', 'releasedAt'] as const

export function parseReleaseCompensationPayoutCommandV1(input: unknown): ReleaseCompensationPayoutCommandV1 {
    const record = assertShape(
        input,
        RELEASE_FIELDS,
        RELEASE_COMPENSATION_PAYOUT_COMMAND_V1,
        'fleet_operations.ReleaseCompensationPayoutCommand.',
    )
    if (!(COMPENSATION_PAYOUT_RELEASE_KINDS_V1 as readonly unknown[]).includes(record.kind)) {
        invalid('kind is invalid')
    }
    return {
        contract: RELEASE_COMPENSATION_PAYOUT_COMMAND_V1,
        payoutAuthorizationId: requiredString(record.payoutAuthorizationId, 'payoutAuthorizationId'),
        authorizationFence: requiredString(record.authorizationFence, 'authorizationFence'),
        kind: record.kind as CompensationPayoutReleaseKindV1,
        reason: requiredString(record.reason, 'reason'),
        principal: requiredPrincipal(record.principal),
        releasedAt: requiredDate(record.releasedAt, 'releasedAt'),
    }
}

const REJECT_FIELDS = ['contract', 'applicationId', 'rejectionKey', 'reason', 'principal', 'rejectedAt'] as const

export function parseRejectCompensationApplicationCommandV1(input: unknown): RejectCompensationApplicationCommandV1 {
    const record = assertShape(
        input,
        REJECT_FIELDS,
        REJECT_COMPENSATION_APPLICATION_COMMAND_V1,
        'fleet_operations.RejectCompensationApplicationCommand.',
    )
    return {
        contract: REJECT_COMPENSATION_APPLICATION_COMMAND_V1,
        applicationId: requiredString(record.applicationId, 'applicationId'),
        rejectionKey: requiredString(record.rejectionKey, 'rejectionKey'),
        reason: requiredString(record.reason, 'reason'),
        principal: requiredPrincipal(record.principal),
        rejectedAt: requiredDate(record.rejectedAt, 'rejectedAt'),
    }
}

const RECONCILE_FIELDS = ['contract', 'reconciliationTaskId', 'resolution', 'resolutionEvidence', 'principal', 'resolvedAt'] as const

export function parseResolveCompensationReconciliationCommandV1(input: unknown): ResolveCompensationReconciliationCommandV1 {
    const record = assertShape(
        input,
        RECONCILE_FIELDS,
        RESOLVE_COMPENSATION_RECONCILIATION_COMMAND_V1,
        'fleet_operations.ResolveCompensationReconciliationCommand.',
    )
    if (!(COMPENSATION_RECONCILIATION_RESOLUTIONS_V1 as readonly unknown[]).includes(record.resolution)) {
        invalid('resolution is invalid')
    }
    return {
        contract: RESOLVE_COMPENSATION_RECONCILIATION_COMMAND_V1,
        reconciliationTaskId: requiredString(record.reconciliationTaskId, 'reconciliationTaskId'),
        resolution: record.resolution as CompensationReconciliationResolutionV1,
        resolutionEvidence: requiredString(record.resolutionEvidence, 'resolutionEvidence'),
        principal: requiredPrincipal(record.principal),
        resolvedAt: requiredDate(record.resolvedAt, 'resolvedAt'),
    }
}
