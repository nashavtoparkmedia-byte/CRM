/**
 * Fleet Operations-owned persistence for the cash compensation monetary core.
 *
 * Every mutation below is one short transaction that acquires row locks in the
 * frozen total order and performs no network call of any kind. Verified order
 * facts and canonical-person evidence are supplied by the caller, already
 * resolved, so nothing here reaches a provider or another context's tables.
 *
 * Postgres aborts a whole transaction on a constraint violation, so the
 * repository's catch-P2002-then-reread idempotency pattern cannot be used
 * inside these transactions. Each path instead takes an explicit
 * `SELECT ... FOR UPDATE` on the deterministic row before writing.
 */

import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import {
    FINALIZE_COMPENSATION_PAYOUT_COMMAND_V1,
    FINALIZE_COMPENSATION_PAYOUT_RESULT_V1,
    REJECT_COMPENSATION_APPLICATION_RESULT_V1,
    RELEASE_COMPENSATION_PAYOUT_COMMAND_V1,
    RELEASE_COMPENSATION_PAYOUT_RESULT_V1,
    RESOLVE_COMPENSATION_RECONCILIATION_RESULT_V1,
    START_COMPENSATION_PAYOUT_RESULT_V1,
    SUBMIT_COMPENSATION_APPLICATION_RESULT_V1,
    type FinalizeCompensationPayoutCommandV1,
    type FinalizeCompensationPayoutResultV1,
    type RejectCompensationApplicationCommandV1,
    type RejectCompensationApplicationResultV1,
    type ReleaseCompensationPayoutCommandV1,
    type ReleaseCompensationPayoutResultV1,
    type ResolveCompensationReconciliationCommandV1,
    type ResolveCompensationReconciliationResultV1,
    type StartCompensationPayoutCommandV1,
    type StartCompensationPayoutResultV1,
    type SubmitCompensationApplicationCommandV1,
    type SubmitCompensationApplicationResultV1,
} from '@/contracts/fleet-operations/v1'
import { compensationBusinessDayKeyV1 } from './compensation-calendar'
import {
    compensationApplicationIdV1,
    compensationAuditEventIdV1,
    compensationDerivedIdV1,
    compensationPayoutFenceV1,
    compensationSubmitFingerprintV1,
} from './compensation-identity'
import {
    compensationAmountKopecksV1,
    parseClaimedAmountKopecksV1,
    parseVerifiedAmountKopecksV1,
} from './compensation-money'
import {
    COMPENSATION_PAYOUT_STALE_AFTER_MS,
    assertCompensationLockOrderV1,
    compensationAttemptDecisionV1,
    compensationCancelDecisionV1,
    compensationFinalizeDecisionV1,
    compensationRowLockOrderV1,
    type CompensationApplicationStatusV1,
} from './compensation-policy'
import {
    compensationLineageContactIdsV1,
    resolveCompensationPersonV1,
    type CompensationPersonBindingRecordV1,
} from './compensation-person-resolution'
import type { CompensationPrincipalV1, ProvenCanonicalPersonV1 } from './compensation-ports'
import {
    compensationSubmissionWindowV1,
    isSubmissionWindowOpenV1,
} from './compensation-submission-window'

export type CompensationErrorCodeV1 =
    | 'period_not_open'
    | 'period_missing'
    | 'person_reconciliation_required'
    | 'person_identity_conflict'
    | 'idempotency_conflict'
    | 'order_already_settled'
    | 'max_attempts_reached'
    | 'second_attempt_requires_rejected_first'
    | 'submission_window_closed'
    | 'active_pending_exists'
    | 'budget_exhausted'
    | 'application_not_found'
    | 'not_pending'
    | 'unknown_authorization'
    | 'authorization_fenced'
    | 'authorization_released'
    | 'reconciliation_required'
    | 'authorization_too_old_reconcile'
    | 'another_payout_in_progress'
    | 'daily_limit_reached'
    | 'payout_authorization_active'
    | 'already_finalized'
    | 'reconciliation_not_open'
    | 'payout_clock_skew'

/**
 * How far a caller's operation timestamp may sit from the database clock.
 *
 * The daily payout slot is the one monetary fact that would otherwise be
 * decided by a caller-supplied instant rather than by verified evidence, so the
 * slot is taken from the database clock and the caller's timestamp only has to
 * agree with it.
 */
const COMPENSATION_CLOCK_SKEW_TOLERANCE_MS = 5 * 60 * 1000

async function assertAgreesWithDatabaseClock(tx: Tx, claimed: Date): Promise<Date> {
    const rows = await tx.$queryRawUnsafe<Array<{ now: Date }>>('SELECT NOW() AS now')
    const serverNow = rows[0].now
    if (Math.abs(serverNow.getTime() - claimed.getTime()) > COMPENSATION_CLOCK_SKEW_TOLERANCE_MS) {
        fail('payout_clock_skew', 'operation timestamp disagrees with the database clock')
    }
    return serverNow
}

export class CompensationErrorV1 extends Error {
    readonly code: CompensationErrorCodeV1
    constructor(code: CompensationErrorCodeV1, message: string) {
        super(message)
        this.name = 'CompensationErrorV1'
        this.code = code
    }
}

/**
 * Declared as a function rather than a const arrow so TypeScript narrows the
 * discriminated unions that follow a refusal.
 */
function fail(code: CompensationErrorCodeV1, message: string): never {
    throw new CompensationErrorV1(code, message)
}

type Tx = Prisma.TransactionClient

/** Row lock helpers. Each records the entity so the frozen order is asserted. */
class LockLedger {
    private readonly acquired: string[] = []
    note(entity: string): void {
        this.acquired.push(entity)
        assertCompensationLockOrderV1(this.acquired)
    }
    get sequence(): readonly string[] {
        return this.acquired
    }
}

/**
 * Locks several monetary-person rows together, in ascending id order.
 *
 * The table is a literal rather than a parameter: a generic helper that
 * interpolated a table name would make this dynamic SQL that the write
 * analyzer cannot resolve to an entity, and the only caller locks this one
 * table anyway.
 */
async function lockCompensationPersonRows(tx: Tx, ids: readonly string[]): Promise<void> {
    const ordered = compensationRowLockOrderV1(ids)
    if (ordered.length === 0) return
    await tx.$queryRawUnsafe(
        'SELECT "id" FROM "CompensationPerson" WHERE "id" = ANY($1::text[]) ORDER BY "id" FOR UPDATE',
        ordered,
    )
}

interface AuditInput {
    action: string
    subjectType: string
    subjectId: string
    compensationPersonId: string | null
    principal: CompensationPrincipalV1
    previousState: string | null
    nextState: string | null
    amountKopecks: number | null
    reason: string | null
    payoutAuthorizationId: string | null
    correlationId: string
    occurredAt: Date
}

/** Audit is appended inside the same transaction as the state change. */
async function appendAudit(tx: Tx, input: AuditInput): Promise<void> {
    const id = compensationAuditEventIdV1({
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        action: input.action,
        correlationId: input.correlationId,
    })
    await tx.$executeRawUnsafe(
        `INSERT INTO "CompensationAuditEvent" (
            "id","occurredAt","action","subjectType","subjectId","compensationPersonId",
            "principalId","principalKind","operatorLabel","previousState","nextState",
            "amountKopecks","reason","payoutAuthorizationId","correlationId","createdAt"
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,NOW())
         ON CONFLICT ("id") DO NOTHING`,
        id,
        input.occurredAt,
        input.action,
        input.subjectType,
        input.subjectId,
        input.compensationPersonId,
        input.principal.principalId,
        input.principal.principalKind,
        input.principal.operatorLabel,
        input.previousState,
        input.nextState,
        input.amountKopecks,
        input.reason,
        input.payoutAuthorizationId,
        input.correlationId,
    )
}

const SYSTEM_PRINCIPAL: CompensationPrincipalV1 = {
    principalId: 'system:compensation',
    principalKind: 'system',
    operatorLabel: null,
}

/* ------------------------------------------------------------------------ */
/* Canonical person                                                          */
/* ------------------------------------------------------------------------ */

/**
 * Maps canonical-person evidence onto a stable monetary identity, outside any
 * monetary transaction and without ever locking a Contact row.
 *
 * A concurrent resolution can win the race on `UNIQUE(contactId)`. That is not
 * surfaced as a raw uniqueness failure: the bindings are reread and the
 * decision retaken, which either converges on the same person or reveals two
 * monetary identities for one lineage and fails closed.
 */
export async function resolveCompensationPersonIdV1(
    evidence: ProvenCanonicalPersonV1,
    attempt = 0,
): Promise<string> {
    const lineage = compensationLineageContactIdsV1(evidence)

    const decision = await prisma.$transaction(async (tx) => {
        const bindings = await tx.$queryRawUnsafe<CompensationPersonBindingRecordV1[]>(
            `SELECT "compensationPersonId", "contactId" FROM "CompensationPersonBinding"
             WHERE "contactId" = ANY($1::text[])`,
            lineage,
        )
        const resolution = resolveCompensationPersonV1(evidence, bindings)

        if (resolution.status === 'fail_closed') {
            // Lock the equivalent people in deterministic id order before marking.
            await lockCompensationPersonRows(tx, resolution.compensationPersonIds)
            await tx.$executeRawUnsafe(
                `UPDATE "CompensationPerson" SET "state" = 'reconciliation_required', "updatedAt" = NOW()
                 WHERE "id" = ANY($1::text[])`,
                compensationRowLockOrderV1(resolution.compensationPersonIds),
            )
            for (const personId of compensationRowLockOrderV1(resolution.compensationPersonIds)) {
                await appendAudit(tx, {
                    action: 'reconciliation_resolved',
                    subjectType: 'CompensationPerson',
                    subjectId: personId,
                    compensationPersonId: personId,
                    principal: SYSTEM_PRINCIPAL,
                    previousState: 'active',
                    nextState: 'reconciliation_required',
                    amountKopecks: null,
                    reason: `equivalent lineage resolved to ${resolution.compensationPersonIds.join(', ')}`,
                    payoutAuthorizationId: null,
                    correlationId: evidence.lineageDigest,
                    occurredAt: new Date(),
                })
            }
            return resolution
        }

        const personId = resolution.status === 'existing'
            ? resolution.compensationPersonId
            : compensationDerivedIdV1('comp_person', evidence.lineageDigest, lineage.join(','))
        const missing = resolution.status === 'existing' ? resolution.missingContactIds : resolution.contactIds

        if (resolution.status === 'create') {
            await tx.$executeRawUnsafe(
                `INSERT INTO "CompensationPerson" ("id","state","createdAt","updatedAt")
                 VALUES ($1,'active',NOW(),NOW()) ON CONFLICT ("id") DO NOTHING`,
                personId,
            )
        }
        for (const contactId of missing) {
            await tx.$executeRawUnsafe(
                `INSERT INTO "CompensationPersonBinding"
                    ("id","compensationPersonId","contactId","lineageDigest","boundVia","boundAt")
                 VALUES ($1,$2,$3,$4,$5,NOW())`,
                compensationDerivedIdV1('comp_bind', contactId),
                personId,
                contactId,
                evidence.lineageDigest,
                evidence.resolutionStatus,
            )
        }
        return { status: 'resolved' as const, compensationPersonId: personId }
    }).catch(async (error: unknown) => {
        // A concurrent resolution claimed one of the lineage contacts first.
        if (attempt >= 3 || !isUniqueViolation(error)) throw error
        return { status: 'retry' as const }
    })

    if (decision.status === 'retry') return resolveCompensationPersonIdV1(evidence, attempt + 1)
    if (decision.status === 'fail_closed') {
        return fail(
            'person_identity_conflict',
            `equivalent lineage resolves to ${decision.compensationPersonIds.length} monetary identities`,
        )
    }
    return decision.compensationPersonId
}

/**
 * Prisma reports a unique violation as P2002 through the model API, but a raw
 * query surfaces it as P2010 with the PostgreSQL SQLSTATE carried in the meta or
 * the message. Every write in this module is raw, so both shapes must match or
 * the retry below never runs.
 */
function isUniqueViolation(error: unknown): boolean {
    if (typeof error !== 'object' || error === null) return false
    const candidate = error as { code?: unknown; meta?: { code?: unknown }; message?: unknown }
    if (candidate.code === 'P2002' || candidate.code === '23505') return true
    if (candidate.meta?.code === '23505') return true
    return candidate.code === 'P2010' && typeof candidate.message === 'string'
        && candidate.message.includes('23505')
}

/* ------------------------------------------------------------------------ */
/* Submit                                                                    */
/* ------------------------------------------------------------------------ */

interface PeriodRow {
    id: string
    periodKey: string
    state: string
    limitKopecks: number
    reservedKopecks: number
    settledKopecks: number
}

interface ApplicationRow {
    id: string
    idempotencyKey: string
    payloadFingerprint: string
    compensationPersonId: string
    orderClaimId: string
    budgetPeriodId: string
    attemptNo: number
    amountKopecks: number
    status: CompensationApplicationStatusV1
    version: number
    rejectionKey: string | null
}

interface ClaimRow {
    id: string
    attemptCount: number
    settledApplicationId: string | null
    submissionDeadline: Date
}

export async function submitCompensationApplicationV1(
    command: SubmitCompensationApplicationCommandV1,
): Promise<SubmitCompensationApplicationResultV1> {
    // Everything order-derived is computed before any lock is taken.
    const window = compensationSubmissionWindowV1(command.order.endedAt)
    const verifiedKopecks = parseVerifiedAmountKopecksV1(command.order.rawPrice)
    const claimedKopecks = parseClaimedAmountKopecksV1(command.claimedRubles)
    const amountKopecks = compensationAmountKopecksV1(claimedKopecks, verifiedKopecks)
    const compensationPersonId = await resolveCompensationPersonIdV1(command.person)
    const applicationId = compensationApplicationIdV1(command.idempotencyKey)
    const orderKey = {
        provider: command.order.provider,
        externalParkId: command.order.externalParkId,
        externalOrderId: command.order.externalOrderId,
    }
    const fingerprint = compensationSubmitFingerprintV1({
        compensationPersonId,
        orderKey,
        claimedKopecks,
        rawPrice: command.order.rawPrice,
        endedAt: command.order.endedAt,
    })
    const claimId = compensationDerivedIdV1(
        'comp_claim', orderKey.provider, orderKey.externalParkId, orderKey.externalOrderId,
    )
    // The price is part of the snapshot's identity: a second attempt quoting a
    // different verified amount must not silently reuse the first attempt's
    // evidence row, or the stored evidence would stop proving the amount.
    const verifiedOrderId = compensationDerivedIdV1(
        'comp_order', orderKey.provider, orderKey.externalParkId, orderKey.externalOrderId,
        command.order.verifiedAt.toISOString(), String(verifiedKopecks),
    )

    return prisma.$transaction(async (tx) => {
        const locks = new LockLedger()

        // 1 — budget period of the ORDER's month, never of the submission clock.
        locks.note('CompensationBudgetPeriod')
        const periods = await tx.$queryRawUnsafe<PeriodRow[]>(
            `SELECT "id","periodKey","state","limitKopecks","reservedKopecks","settledKopecks"
             FROM "CompensationBudgetPeriod" WHERE "periodKey" = $1 FOR UPDATE`,
            window.periodKey,
        )
        const period = periods[0]
        if (!period) fail('period_missing', `no budget period for ${window.periodKey}`)
        if (period.state !== 'open') fail('period_not_open', `budget period ${window.periodKey} is closed`)

        // 2 — person.
        locks.note('CompensationPerson')
        const persons = await tx.$queryRawUnsafe<Array<{ id: string; state: string }>>(
            `SELECT "id","state" FROM "CompensationPerson" WHERE "id" = $1 FOR UPDATE`,
            compensationPersonId,
        )
        if (persons[0]?.state === 'reconciliation_required') {
            fail('person_reconciliation_required', 'monetary identity needs reconciliation')
        }

        // 3 — the deterministic application row; idempotent replay short-circuits.
        locks.note('CompensationApplication')
        const existingRows = await tx.$queryRawUnsafe<ApplicationRow[]>(
            `SELECT "id","idempotencyKey","payloadFingerprint","compensationPersonId","orderClaimId",
                    "budgetPeriodId","attemptNo","amountKopecks","status","version","rejectionKey"
             FROM "CompensationApplication" WHERE "id" = $1 FOR UPDATE`,
            applicationId,
        )
        const existing = existingRows[0]
        if (existing) {
            if (existing.payloadFingerprint !== fingerprint) {
                fail('idempotency_conflict', 'idempotency key reused for a different submission')
            }
            // Report the period the stored application actually reserved
            // against, not one recomputed from the replayed command.
            const storedPeriod = await tx.$queryRawUnsafe<Array<{ periodKey: string }>>(
                `SELECT "periodKey" FROM "CompensationBudgetPeriod" WHERE "id" = $1`,
                existing.budgetPeriodId,
            )
            return {
                contract: SUBMIT_COMPENSATION_APPLICATION_RESULT_V1,
                status: 'replayed' as const,
                applicationId: existing.id,
                compensationPersonId: existing.compensationPersonId,
                amountKopecks: existing.amountKopecks,
                attemptNo: existing.attemptNo as 1 | 2,
                budgetPeriodKey: storedPeriod[0].periodKey,
            }
        }

        // One active PENDING per canonical person, across every profile.
        const activePending = await tx.$queryRawUnsafe<Array<{ id: string }>>(
            `SELECT "id" FROM "CompensationApplication"
             WHERE "compensationPersonId" = $1 AND "status" = 'PENDING' LIMIT 1`,
            compensationPersonId,
        )
        if (activePending.length > 0) fail('active_pending_exists', 'person already has an active application')

        // 5 — the order claim carries attempt numbering and the immutable deadline.
        locks.note('CompensationOrderClaim')
        await tx.$executeRawUnsafe(
            `INSERT INTO "CompensationOrderClaim"
                ("id","provider","externalParkId","externalOrderId","attemptCount","settledApplicationId",
                 "submissionDeadline","deadlineBasis","budgetPeriodKey","orderEndedAt","createdAt","updatedAt")
             VALUES ($1,$2,$3,$4,0,NULL,$5,$6,$7,$8,NOW(),NOW())
             ON CONFLICT ("provider","externalParkId","externalOrderId") DO NOTHING`,
            claimId, orderKey.provider, orderKey.externalParkId, orderKey.externalOrderId,
            window.submissionDeadline, window.deadlineBasis, window.periodKey, command.order.endedAt,
        )
        const claims = await tx.$queryRawUnsafe<ClaimRow[]>(
            `SELECT "id","attemptCount","settledApplicationId","submissionDeadline"
             FROM "CompensationOrderClaim"
             WHERE "provider" = $1 AND "externalParkId" = $2 AND "externalOrderId" = $3 FOR UPDATE`,
            orderKey.provider, orderKey.externalParkId, orderKey.externalOrderId,
        )
        const claim = claims[0]

        // The order-level deadline decides eligibility. A broad budget-period
        // availability window never makes an individually expired order valid.
        if (!isSubmissionWindowOpenV1(command.submittedAt, claim.submissionDeadline)) {
            fail('submission_window_closed', 'submission window for this order has closed')
        }

        const firstAttempt = await tx.$queryRawUnsafe<Array<{ status: CompensationApplicationStatusV1 }>>(
            `SELECT "status" FROM "CompensationApplication" WHERE "orderClaimId" = $1 AND "attemptNo" = 1`,
            claim.id,
        )
        const attempt = compensationAttemptDecisionV1({
            attemptCount: claim.attemptCount,
            settledApplicationId: claim.settledApplicationId,
            firstAttemptStatus: firstAttempt[0]?.status ?? null,
        })
        if (attempt.kind === 'refuse') fail(attempt.code, `attempt refused: ${attempt.code}`)

        if (period.reservedKopecks + period.settledKopecks + amountKopecks > period.limitKopecks) {
            fail('budget_exhausted', `budget period ${window.periodKey} cannot cover this compensation`)
        }

        await tx.$executeRawUnsafe(
            `INSERT INTO "CompensationVerifiedOrder"
                ("id","provider","externalParkId","externalOrderId","shortOrderIdDisplay","rawPrice",
                 "amountKopecks","endedAt","verifiedAt","payloadDigest","createdAt")
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
             ON CONFLICT ("id") DO NOTHING`,
            verifiedOrderId, orderKey.provider, orderKey.externalParkId, orderKey.externalOrderId,
            command.order.shortOrderIdDisplay, command.order.rawPrice, verifiedKopecks,
            command.order.endedAt, command.order.verifiedAt, fingerprint,
        )
        await tx.$executeRawUnsafe(
            `INSERT INTO "CompensationApplication"
                ("id","idempotencyKey","payloadFingerprint","compensationPersonId","orderClaimId",
                 "verifiedOrderId","budgetPeriodId","attemptNo","claimedKopecks","amountKopecks",
                 "status","version","submittedAt","createdAt","updatedAt")
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'PENDING',0,$11,NOW(),NOW())`,
            applicationId, command.idempotencyKey, fingerprint, compensationPersonId, claim.id,
            verifiedOrderId, period.id, attempt.attemptNo, claimedKopecks, amountKopecks,
            command.submittedAt,
        )
        await tx.$executeRawUnsafe(
            `UPDATE "CompensationOrderClaim" SET "attemptCount" = $2, "updatedAt" = NOW() WHERE "id" = $1`,
            claim.id, attempt.attemptNo,
        )
        await tx.$executeRawUnsafe(
            `UPDATE "CompensationBudgetPeriod"
             SET "reservedKopecks" = "reservedKopecks" + $2, "updatedAt" = NOW() WHERE "id" = $1`,
            period.id, amountKopecks,
        )
        await appendAudit(tx, {
            action: 'submit',
            subjectType: 'CompensationApplication',
            subjectId: applicationId,
            compensationPersonId,
            principal: SYSTEM_PRINCIPAL,
            previousState: null,
            nextState: 'PENDING',
            amountKopecks,
            reason: null,
            payoutAuthorizationId: null,
            correlationId: command.idempotencyKey,
            occurredAt: command.submittedAt,
        })

        return {
            contract: SUBMIT_COMPENSATION_APPLICATION_RESULT_V1,
            status: 'created' as const,
            applicationId,
            compensationPersonId,
            amountKopecks,
            attemptNo: attempt.attemptNo,
            budgetPeriodKey: window.periodKey,
        }
    })
}

/* ------------------------------------------------------------------------ */
/* Payout lifecycle                                                          */
/* ------------------------------------------------------------------------ */

interface AuthorizationRow {
    id: string
    applicationId: string
    compensationPersonId: string
    intendedBusinessDay: string
    amountKopecks: number
    state: 'active' | 'unknown_outcome' | 'finalized' | 'cancelled'
    authorizationFence: string
    openedAt: Date
    expiresAt: Date
    settlementId: string | null
}

/** Locks 1-3, shared by every manager operation on one application. */
async function lockApplicationChain(
    tx: Tx,
    locks: LockLedger,
    applicationId: string,
): Promise<{ period: PeriodRow; application: ApplicationRow }> {
    const applicationProbe = await tx.$queryRawUnsafe<Array<{ budgetPeriodId: string }>>(
        `SELECT "budgetPeriodId" FROM "CompensationApplication" WHERE "id" = $1`,
        applicationId,
    )
    if (applicationProbe.length === 0) fail('application_not_found', `unknown application ${applicationId}`)

    // The application's own period, which may be a closed previous month: a
    // timely PENDING survives month close and must still be payable.
    locks.note('CompensationBudgetPeriod')
    const periods = await tx.$queryRawUnsafe<PeriodRow[]>(
        `SELECT "id","periodKey","state","limitKopecks","reservedKopecks","settledKopecks"
         FROM "CompensationBudgetPeriod" WHERE "id" = $1 FOR UPDATE`,
        applicationProbe[0].budgetPeriodId,
    )

    locks.note('CompensationPerson')
    const personProbe = await tx.$queryRawUnsafe<Array<{ compensationPersonId: string }>>(
        `SELECT "compensationPersonId" FROM "CompensationApplication" WHERE "id" = $1`,
        applicationId,
    )
    await tx.$queryRawUnsafe(
        `SELECT "id" FROM "CompensationPerson" WHERE "id" = $1 FOR UPDATE`,
        personProbe[0].compensationPersonId,
    )

    locks.note('CompensationApplication')
    const applications = await tx.$queryRawUnsafe<ApplicationRow[]>(
        `SELECT "id","idempotencyKey","payloadFingerprint","compensationPersonId","orderClaimId",
                "budgetPeriodId","attemptNo","amountKopecks","status","version","rejectionKey"
         FROM "CompensationApplication" WHERE "id" = $1 FOR UPDATE`,
        applicationId,
    )
    return { period: periods[0], application: applications[0] }
}

/**
 * The same rows as `lockApplicationChain`, read without locking, for a caller
 * that already holds those locks in the frozen order.
 */
async function readApplicationChain(
    tx: Tx,
    applicationId: string,
): Promise<{ period: PeriodRow; application: ApplicationRow }> {
    const applications = await tx.$queryRawUnsafe<ApplicationRow[]>(
        `SELECT "id","idempotencyKey","payloadFingerprint","compensationPersonId","orderClaimId",
                "budgetPeriodId","attemptNo","amountKopecks","status","version","rejectionKey"
         FROM "CompensationApplication" WHERE "id" = $1`,
        applicationId,
    )
    if (applications.length === 0) fail('application_not_found', `unknown application ${applicationId}`)
    const periods = await tx.$queryRawUnsafe<PeriodRow[]>(
        `SELECT "id","periodKey","state","limitKopecks","reservedKopecks","settledKopecks"
         FROM "CompensationBudgetPeriod" WHERE "id" = $1`,
        applications[0].budgetPeriodId,
    )
    return { period: periods[0], application: applications[0] }
}

async function lockOpenAuthorization(
    tx: Tx,
    locks: LockLedger,
    applicationId: string,
): Promise<AuthorizationRow | undefined> {
    locks.note('CompensationPayoutAuthorization')
    const rows = await tx.$queryRawUnsafe<AuthorizationRow[]>(
        `SELECT "id","applicationId","compensationPersonId","intendedBusinessDay","amountKopecks",
                "state","authorizationFence","openedAt","expiresAt","settlementId"
         FROM "CompensationPayoutAuthorization"
         WHERE "applicationId" = $1 AND "state" IN ('active','unknown_outcome')
         ORDER BY "id" FOR UPDATE`,
        applicationId,
    )
    return rows[0]
}

export async function startCompensationPayoutV1(
    command: StartCompensationPayoutCommandV1,
): Promise<StartCompensationPayoutResultV1> {
    return prisma.$transaction(async (tx) => {
        const locks = new LockLedger()
        const { application } = await lockApplicationChain(tx, locks, command.applicationId)
        if (application.status !== 'PENDING') fail('not_pending', `application is ${application.status}`)

        const open = await lockOpenAuthorization(tx, locks, command.applicationId)
        if (open) {
            if (open.state === 'unknown_outcome') {
                fail('reconciliation_required', 'external payout outcome is unresolved')
            }
            return {
                contract: START_COMPENSATION_PAYOUT_RESULT_V1,
                status: 'replayed' as const,
                payoutAuthorizationId: open.id,
                authorizationFence: open.authorizationFence,
                amountKopecks: open.amountKopecks,
                intendedBusinessDay: open.intendedBusinessDay,
                expiresAt: open.expiresAt,
            }
        }

        // The business day is captured here, atomically, and finalize never
        // recomputes it. That is what stops finalize from discovering a new
        // daily-limit conflict after money has left the dispatcher.
        // Taken from the database clock, not from the caller: this is the one
        // monetary fact a caller could otherwise choose, and choosing it would
        // free a slot the person has already consumed.
        const serverNow = await assertAgreesWithDatabaseClock(tx, command.startedAt)
        const intendedBusinessDay = compensationBusinessDayKeyV1(serverNow)

        const dayTaken = await tx.$queryRawUnsafe<Array<{ id: string }>>(
            `SELECT "id" FROM "CompensationPayoutAuthorization"
             WHERE "compensationPersonId" = $1 AND "intendedBusinessDay" = $2
               AND "state" IN ('active','unknown_outcome','finalized') LIMIT 1`,
            application.compensationPersonId, intendedBusinessDay,
        )
        if (dayTaken.length > 0) fail('daily_limit_reached', `person already has a payout for ${intendedBusinessDay}`)

        const personBusy = await tx.$queryRawUnsafe<Array<{ id: string }>>(
            `SELECT "id" FROM "CompensationPayoutAuthorization"
             WHERE "compensationPersonId" = $1 AND "state" IN ('active','unknown_outcome') LIMIT 1`,
            application.compensationPersonId,
        )
        if (personBusy.length > 0) fail('another_payout_in_progress', 'person already holds a payout right')

        const authorizationId = compensationDerivedIdV1(
            'comp_auth', application.id, String(application.version),
        )
        const authorizationFence = compensationPayoutFenceV1(authorizationId, application.version)
        const expiresAt = new Date(command.startedAt.getTime() + COMPENSATION_PAYOUT_STALE_AFTER_MS)

        await tx.$executeRawUnsafe(
            `INSERT INTO "CompensationPayoutAuthorization"
                ("id","applicationId","compensationPersonId","intendedBusinessDay","amountKopecks",
                 "state","authorizationFence","openedAt","expiresAt","openedByPrincipal","openedByLabel",
                 "createdAt","updatedAt")
             VALUES ($1,$2,$3,$4,$5,'active',$6,$7,$8,$9,$10,NOW(),NOW())`,
            authorizationId, application.id, application.compensationPersonId, intendedBusinessDay,
            application.amountKopecks, authorizationFence, command.startedAt, expiresAt,
            command.principal.principalId, command.principal.operatorLabel,
        )
        await appendAudit(tx, {
            action: 'payout_authorization_opened',
            subjectType: 'CompensationPayoutAuthorization',
            subjectId: authorizationId,
            compensationPersonId: application.compensationPersonId,
            principal: command.principal,
            previousState: null,
            nextState: 'active',
            amountKopecks: application.amountKopecks,
            reason: null,
            payoutAuthorizationId: authorizationId,
            correlationId: authorizationId,
            occurredAt: command.startedAt,
        })

        return {
            contract: START_COMPENSATION_PAYOUT_RESULT_V1,
            status: 'opened' as const,
            payoutAuthorizationId: authorizationId,
            authorizationFence,
            amountKopecks: application.amountKopecks,
            intendedBusinessDay,
            expiresAt,
        }
    })
}

export async function finalizeCompensationPayoutV1(
    command: FinalizeCompensationPayoutCommandV1,
): Promise<FinalizeCompensationPayoutResultV1> {
    return prisma.$transaction((tx) => finalizeInTransaction(tx, command, false))
}

/**
 * Finalize body, shared by the manager's own confirmation and by a
 * reconciliation resolution. `viaReconciliation` only relaxes the unaided-recall
 * age gate; every monetary invariant below is identical on both paths.
 */
async function finalizeInTransaction(
    tx: Tx,
    command: FinalizeCompensationPayoutCommandV1,
    viaReconciliation: boolean,
    presetLocks?: LockLedger,
): Promise<FinalizeCompensationPayoutResultV1> {
    {
        const authProbe = await tx.$queryRawUnsafe<Array<{ applicationId: string }>>(
            `SELECT "applicationId" FROM "CompensationPayoutAuthorization" WHERE "id" = $1`,
            command.payoutAuthorizationId,
        )
        if (authProbe.length === 0) fail('unknown_authorization', 'unknown payout authorization')

        const locks = presetLocks ?? new LockLedger()
        const { period, application } = presetLocks
            ? await readApplicationChain(tx, authProbe[0].applicationId)
            : await lockApplicationChain(tx, locks, authProbe[0].applicationId)

        locks.note('CompensationPayoutAuthorization')
        const authorizations = await tx.$queryRawUnsafe<AuthorizationRow[]>(
            `SELECT "id","applicationId","compensationPersonId","intendedBusinessDay","amountKopecks",
                    "state","authorizationFence","openedAt","expiresAt","settlementId"
             FROM "CompensationPayoutAuthorization" WHERE "id" = $1 FOR UPDATE`,
            command.payoutAuthorizationId,
        )
        const authorization = authorizations[0]
        // The age gate reads this instant, so it may not be caller-chosen either.
        await assertAgreesWithDatabaseClock(tx, command.finalizedAt)
        const decision = compensationFinalizeDecisionV1(
            authorization, command.authorizationFence, command.finalizedAt, viaReconciliation,
        )
        if (decision.kind === 'refuse') fail(decision.code, `finalize refused: ${decision.code}`)
        if (decision.kind === 'replay') {
            const settlements = await tx.$queryRawUnsafe<Array<{ id: string; amountKopecks: number; businessDay: string }>>(
                `SELECT "id","amountKopecks","businessDay" FROM "CompensationSettlement"
                 WHERE "payoutAuthorizationId" = $1`,
                authorization.id,
            )
            return {
                contract: FINALIZE_COMPENSATION_PAYOUT_RESULT_V1,
                status: 'replayed' as const,
                settlementId: settlements[0].id,
                applicationId: authorization.applicationId,
                amountKopecks: settlements[0].amountKopecks,
                businessDay: settlements[0].businessDay,
            }
        }
        if (application.status !== 'PENDING') fail('not_pending', `application is ${application.status}`)

        locks.note('CompensationOrderClaim')
        const claims = await tx.$queryRawUnsafe<ClaimRow[]>(
            `SELECT "id","attemptCount","settledApplicationId","submissionDeadline"
             FROM "CompensationOrderClaim" WHERE "id" = $1 FOR UPDATE`,
            application.orderClaimId,
        )
        if (claims[0].settledApplicationId !== null) fail('order_already_settled', 'order already settled')

        // The amount was frozen when the authorization opened.
        const amountKopecks = authorization.amountKopecks
        const settlementId = compensationDerivedIdV1('comp_settle', authorization.id)

        await tx.$executeRawUnsafe(
            `UPDATE "CompensationBudgetPeriod"
             SET "reservedKopecks" = "reservedKopecks" - $2,
                 "settledKopecks" = "settledKopecks" + $2,
                 "updatedAt" = NOW()
             WHERE "id" = $1`,
            period.id, amountKopecks,
        )
        await tx.$executeRawUnsafe(
            `INSERT INTO "CompensationSettlement"
                ("id","applicationId","payoutAuthorizationId","orderClaimId","budgetPeriodId",
                 "compensationPersonId","amountKopecks","businessDay","settledAt",
                 "settledByPrincipal","settledByLabel","createdAt")
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())`,
            settlementId, application.id, authorization.id, application.orderClaimId, period.id,
            application.compensationPersonId, amountKopecks, authorization.intendedBusinessDay,
            command.finalizedAt, command.principal.principalId, command.principal.operatorLabel,
        )
        await tx.$executeRawUnsafe(
            `UPDATE "CompensationApplication"
             SET "status" = 'PAID', "paidAt" = $2, "version" = "version" + 1, "updatedAt" = NOW()
             WHERE "id" = $1`,
            application.id, command.finalizedAt,
        )
        await tx.$executeRawUnsafe(
            `UPDATE "CompensationOrderClaim" SET "settledApplicationId" = $2, "updatedAt" = NOW() WHERE "id" = $1`,
            application.orderClaimId, application.id,
        )
        await tx.$executeRawUnsafe(
            `UPDATE "CompensationPayoutAuthorization"
             SET "state" = 'finalized', "closedAt" = $2, "settlementId" = $3,
                 "closedByPrincipal" = $4, "closedByLabel" = $5, "updatedAt" = NOW()
             WHERE "id" = $1`,
            authorization.id, command.finalizedAt, settlementId,
            command.principal.principalId, command.principal.operatorLabel,
        )
        await appendAudit(tx, {
            action: 'payout_finalized',
            subjectType: 'CompensationApplication',
            subjectId: application.id,
            compensationPersonId: application.compensationPersonId,
            principal: command.principal,
            previousState: 'PENDING',
            nextState: 'PAID',
            amountKopecks,
            reason: null,
            payoutAuthorizationId: authorization.id,
            correlationId: authorization.id,
            occurredAt: command.finalizedAt,
        })

        return {
            contract: FINALIZE_COMPENSATION_PAYOUT_RESULT_V1,
            status: 'settled' as const,
            settlementId,
            applicationId: application.id,
            amountKopecks,
            businessDay: authorization.intendedBusinessDay,
        }
    }
}

export async function releaseCompensationPayoutV1(
    command: ReleaseCompensationPayoutCommandV1,
): Promise<ReleaseCompensationPayoutResultV1> {
    return prisma.$transaction((tx) => releaseInTransaction(tx, command))
}

/** Release body, shared by the manager's own release and by reconciliation. */
async function releaseInTransaction(
    tx: Tx,
    command: ReleaseCompensationPayoutCommandV1,
    presetLocks?: LockLedger,
): Promise<ReleaseCompensationPayoutResultV1> {
    {
        const authProbe = await tx.$queryRawUnsafe<Array<{ applicationId: string }>>(
            `SELECT "applicationId" FROM "CompensationPayoutAuthorization" WHERE "id" = $1`,
            command.payoutAuthorizationId,
        )
        if (authProbe.length === 0) fail('unknown_authorization', 'unknown payout authorization')

        const locks = presetLocks ?? new LockLedger()
        const { application } = presetLocks
            ? await readApplicationChain(tx, authProbe[0].applicationId)
            : await lockApplicationChain(tx, locks, authProbe[0].applicationId)

        locks.note('CompensationPayoutAuthorization')
        const authorizations = await tx.$queryRawUnsafe<AuthorizationRow[]>(
            `SELECT "id","applicationId","compensationPersonId","intendedBusinessDay","amountKopecks",
                    "state","authorizationFence","openedAt","expiresAt","settlementId"
             FROM "CompensationPayoutAuthorization" WHERE "id" = $1 FOR UPDATE`,
            command.payoutAuthorizationId,
        )
        const authorization = authorizations[0]

        if (command.kind === 'cancel_preparation') {
            const decision = compensationCancelDecisionV1(authorization, command.authorizationFence)
            if (decision.kind === 'refuse') fail(decision.code, `release refused: ${decision.code}`)
            if (decision.kind === 'replay') {
                return {
                    contract: RELEASE_COMPENSATION_PAYOUT_RESULT_V1,
                    status: 'replayed' as const,
                    payoutAuthorizationId: authorization.id,
                    reconciliationTaskId: null,
                }
            }
            await tx.$executeRawUnsafe(
                `UPDATE "CompensationPayoutAuthorization"
                 SET "state" = 'cancelled', "closedAt" = $2, "closureReason" = $3,
                     "closedByPrincipal" = $4, "closedByLabel" = $5, "updatedAt" = NOW()
                 WHERE "id" = $1`,
                authorization.id, command.releasedAt, command.reason,
                command.principal.principalId, command.principal.operatorLabel,
            )
            // The authorization id is derived from the application version, so
            // releasing preparation must advance it. Otherwise a second
            // preparation for this still-PENDING application would derive the
            // same primary key and collide with the closed row, leaving a valid
            // funded application permanently unpayable.
            await tx.$executeRawUnsafe(
                `UPDATE "CompensationApplication" SET "version" = "version" + 1, "updatedAt" = NOW() WHERE "id" = $1`,
                application.id,
            )
            await appendAudit(tx, {
                action: 'payout_authorization_cancelled',
                subjectType: 'CompensationPayoutAuthorization',
                subjectId: authorization.id,
                compensationPersonId: application.compensationPersonId,
                principal: command.principal,
                previousState: authorization.state,
                nextState: 'cancelled',
                amountKopecks: authorization.amountKopecks,
                reason: command.reason,
                payoutAuthorizationId: authorization.id,
                correlationId: authorization.id,
                occurredAt: command.releasedAt,
            })
            return {
                contract: RELEASE_COMPENSATION_PAYOUT_RESULT_V1,
                status: 'cancelled' as const,
                payoutAuthorizationId: authorization.id,
                reconciliationTaskId: null,
            }
        }

        // declare_outcome_unknown
        if (authorization.authorizationFence !== command.authorizationFence) {
            fail('authorization_fenced', 'payout authorization fence is stale')
        }
        if (authorization.state === 'unknown_outcome') {
            const open = await tx.$queryRawUnsafe<Array<{ id: string }>>(
                `SELECT "id" FROM "CompensationReconciliationTask"
                 WHERE "payoutAuthorizationId" = $1 AND "state" = 'open'`,
                authorization.id,
            )
            return {
                contract: RELEASE_COMPENSATION_PAYOUT_RESULT_V1,
                status: 'replayed' as const,
                payoutAuthorizationId: authorization.id,
                reconciliationTaskId: open[0]?.id ?? null,
            }
        }
        if (authorization.state === 'finalized') fail('already_finalized', 'payout already finalized')
        if (authorization.state === 'cancelled') fail('authorization_released', 'payout preparation already released')

        const taskId = compensationDerivedIdV1('comp_recon', authorization.id)
        await tx.$executeRawUnsafe(
            `UPDATE "CompensationPayoutAuthorization"
             SET "state" = 'unknown_outcome', "closureReason" = $2, "updatedAt" = NOW()
             WHERE "id" = $1`,
            authorization.id, command.reason,
        )
        locks.note('CompensationReconciliationTask')
        await tx.$executeRawUnsafe(
            `INSERT INTO "CompensationReconciliationTask"
                ("id","payoutAuthorizationId","reason","state","openedAt","openedByPrincipal","createdAt","updatedAt")
             VALUES ($1,$2,$3,'open',$4,$5,NOW(),NOW())
             ON CONFLICT ("id") DO NOTHING`,
            taskId, authorization.id, command.reason, command.releasedAt, command.principal.principalId,
        )
        await appendAudit(tx, {
            action: 'payout_authorization_unknown',
            subjectType: 'CompensationPayoutAuthorization',
            subjectId: authorization.id,
            compensationPersonId: application.compensationPersonId,
            principal: command.principal,
            previousState: authorization.state,
            nextState: 'unknown_outcome',
            amountKopecks: authorization.amountKopecks,
            reason: command.reason,
            payoutAuthorizationId: authorization.id,
            correlationId: authorization.id,
            occurredAt: command.releasedAt,
        })

        return {
            contract: RELEASE_COMPENSATION_PAYOUT_RESULT_V1,
            status: 'reconciliation_opened' as const,
            payoutAuthorizationId: authorization.id,
            reconciliationTaskId: taskId,
        }
    }
}

export async function rejectCompensationApplicationV1(
    command: RejectCompensationApplicationCommandV1,
): Promise<RejectCompensationApplicationResultV1> {
    return prisma.$transaction(async (tx) => {
        const locks = new LockLedger()
        const { period, application } = await lockApplicationChain(tx, locks, command.applicationId)

        if (application.status === 'REJECTED' && application.rejectionKey === command.rejectionKey) {
            return {
                contract: REJECT_COMPENSATION_APPLICATION_RESULT_V1,
                status: 'replayed' as const,
                applicationId: application.id,
                releasedKopecks: application.amountKopecks,
            }
        }
        if (application.status !== 'PENDING') fail('not_pending', `application is ${application.status}`)

        const blocking = await lockOpenAuthorization(tx, locks, application.id)
        if (blocking) fail('payout_authorization_active', 'an unresolved payout authorization exists')

        await tx.$executeRawUnsafe(
            `UPDATE "CompensationBudgetPeriod"
             SET "reservedKopecks" = "reservedKopecks" - $2, "updatedAt" = NOW() WHERE "id" = $1`,
            period.id, application.amountKopecks,
        )
        await tx.$executeRawUnsafe(
            `UPDATE "CompensationApplication"
             SET "status" = 'REJECTED', "rejectedAt" = $2, "rejectionKey" = $3, "rejectionReason" = $4,
                 "version" = "version" + 1, "updatedAt" = NOW()
             WHERE "id" = $1`,
            application.id, command.rejectedAt, command.rejectionKey, command.reason,
        )
        await appendAudit(tx, {
            action: 'reject',
            subjectType: 'CompensationApplication',
            subjectId: application.id,
            compensationPersonId: application.compensationPersonId,
            principal: command.principal,
            previousState: 'PENDING',
            nextState: 'REJECTED',
            amountKopecks: application.amountKopecks,
            reason: command.reason,
            payoutAuthorizationId: null,
            correlationId: command.rejectionKey,
            occurredAt: command.rejectedAt,
        })

        return {
            contract: REJECT_COMPENSATION_APPLICATION_RESULT_V1,
            status: 'rejected' as const,
            applicationId: application.id,
            releasedKopecks: application.amountKopecks,
        }
    })
}

/**
 * Resolve an unknown external payout outcome.
 *
 * One transaction, taking every lock in the frozen order, so a failure cannot
 * leave the authorization reopened, the task stranded and the reservation held
 * the way a multi-transaction version would. The resolution runs the ordinary
 * finalize or release body, so no monetary invariant is special-cased here; the
 * only relaxation is the unaided-recall age gate, which does not apply to an
 * evidence-backed resolution.
 */
export async function resolveCompensationReconciliationV1(
    command: ResolveCompensationReconciliationCommandV1,
): Promise<ResolveCompensationReconciliationResultV1> {
    return prisma.$transaction(async (tx) => {
        const taskProbe = await tx.$queryRawUnsafe<Array<{ payoutAuthorizationId: string }>>(
            `SELECT "payoutAuthorizationId" FROM "CompensationReconciliationTask" WHERE "id" = $1`,
            command.reconciliationTaskId,
        )
        if (taskProbe.length === 0) fail('reconciliation_not_open', 'unknown reconciliation task')
        const authorizationId = taskProbe[0].payoutAuthorizationId

        const authProbe = await tx.$queryRawUnsafe<Array<{ applicationId: string; authorizationFence: string }>>(
            `SELECT "applicationId","authorizationFence" FROM "CompensationPayoutAuthorization" WHERE "id" = $1`,
            authorizationId,
        )
        if (authProbe.length === 0) fail('unknown_authorization', 'unknown payout authorization')

        const locks = new LockLedger()
        await lockApplicationChain(tx, locks, authProbe[0].applicationId)

        // Read the task state without locking: the frozen order puts it last,
        // and the guarded UPDATE at the end is what actually serialises two
        // concurrent resolutions.
        const tasks = await tx.$queryRawUnsafe<Array<{ id: string; state: string }>>(
            `SELECT "id","state" FROM "CompensationReconciliationTask" WHERE "id" = $1`,
            command.reconciliationTaskId,
        )
        if (tasks[0].state === 'resolved') {
            const settlements = await tx.$queryRawUnsafe<Array<{ id: string }>>(
                `SELECT "id" FROM "CompensationSettlement" WHERE "payoutAuthorizationId" = $1`,
                authorizationId,
            )
            return {
                contract: RESOLVE_COMPENSATION_RECONCILIATION_RESULT_V1,
                status: 'replayed' as const,
                reconciliationTaskId: command.reconciliationTaskId,
                settlementId: settlements[0]?.id ?? null,
            }
        }

        let settlementId: string | null = null
        if (command.resolution === 'paid') {
            const settled = await finalizeInTransaction(tx, {
                contract: FINALIZE_COMPENSATION_PAYOUT_COMMAND_V1,
                payoutAuthorizationId: authorizationId,
                authorizationFence: authProbe[0].authorizationFence,
                principal: command.principal,
                finalizedAt: command.resolvedAt,
            }, true, locks)
            settlementId = settled.settlementId
        } else {
            await releaseInTransaction(tx, {
                contract: RELEASE_COMPENSATION_PAYOUT_COMMAND_V1,
                payoutAuthorizationId: authorizationId,
                authorizationFence: authProbe[0].authorizationFence,
                kind: 'cancel_preparation',
                reason: command.resolutionEvidence,
                principal: command.principal,
                releasedAt: command.resolvedAt,
            }, locks)
        }

        // Rank 7, taken last: the guarded UPDATE takes the row lock itself, so
        // a concurrent resolution finds no open task and refuses.
        locks.note('CompensationReconciliationTask')
        const resolved = await tx.$executeRawUnsafe(
            `UPDATE "CompensationReconciliationTask"
             SET "state" = 'resolved', "resolvedAt" = $2, "resolution" = $3,
                 "resolutionEvidence" = $4, "resolvedByPrincipal" = $5, "updatedAt" = NOW()
             WHERE "id" = $1 AND "state" = 'open'`,
            command.reconciliationTaskId, command.resolvedAt, command.resolution,
            command.resolutionEvidence, command.principal.principalId,
        )
        if (resolved !== 1) fail('reconciliation_not_open', 'reconciliation task is no longer open')

        await appendAudit(tx, {
            action: 'reconciliation_resolved',
            subjectType: 'CompensationReconciliationTask',
            subjectId: command.reconciliationTaskId,
            compensationPersonId: null,
            principal: command.principal,
            previousState: 'open',
            nextState: 'resolved',
            amountKopecks: null,
            reason: command.resolutionEvidence,
            payoutAuthorizationId: authorizationId,
            correlationId: command.reconciliationTaskId,
            occurredAt: command.resolvedAt,
        })

        return {
            contract: RESOLVE_COMPENSATION_RECONCILIATION_RESULT_V1,
            status: command.resolution === 'paid' ? 'settled' as const : 'released' as const,
            reconciliationTaskId: command.reconciliationTaskId,
            settlementId,
        }
    })
}

/** Public statistics: all-time paid amount and count, derived from settlements. */
export async function compensationPublicTotalsV1(): Promise<{ totalKopecks: number; paidCount: number }> {
    const rows = await prisma.$queryRawUnsafe<Array<{ totalKopecks: bigint | number; paidCount: bigint | number }>>(
        `SELECT COALESCE(SUM("amountKopecks"),0)::bigint AS "totalKopecks",
                COUNT(*)::bigint AS "paidCount"
         FROM "CompensationSettlement"`,
    )
    return {
        totalKopecks: Number(rows[0].totalKopecks),
        paidCount: Number(rows[0].paidCount),
    }
}
