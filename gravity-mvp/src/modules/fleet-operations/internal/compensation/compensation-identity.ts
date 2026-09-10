/**
 * Deterministic identifiers for the monetary core.
 *
 * Submit idempotency uses a caller-generated key, because a server-generated
 * token is unknown to the caller after a response timeout and therefore cannot
 * be replayed. The key is hashed into the row's primary key, following the
 * repository's existing idempotent-task pattern, so the database itself is the
 * concurrency fence.
 */

import { createHash } from 'node:crypto'
import type { CompensationOrderKeyV1 } from './compensation-ports'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/**
 * NUL separator, matching the repository's existing deterministic event ids.
 * Every component hashed below is a digest, cuid, UUID or closed-vocabulary
 * token, so a printable separator would also be unambiguous; NUL keeps that
 * true even if a component's vocabulary widens later.
 */
const FIELD_SEPARATOR = String.fromCharCode(0)

export type CompensationIdentityErrorCodeV1 = 'IDEMPOTENCY_KEY_INVALID'

export class CompensationIdentityErrorV1 extends Error {
    readonly code: CompensationIdentityErrorCodeV1
    constructor(code: CompensationIdentityErrorCodeV1, message: string) {
        super(message)
        this.name = 'CompensationIdentityErrorV1'
        this.code = code
    }
}

function sha256(value: string): string {
    return createHash('sha256').update(value).digest('hex')
}

/** Canonical JSON, matching the repository's existing fingerprint helper. */
function canonicalJson(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value)
    if (value instanceof Date) return JSON.stringify(value.toISOString())
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
}

/**
 * The caller supplies a UUID once, at the moment the driver confirms, and
 * reuses it for every retry of that same logical submit.
 */
export function assertCompensationIdempotencyKeyV1(raw: unknown): string {
    if (typeof raw !== 'string' || !UUID_PATTERN.test(raw)) {
        throw new CompensationIdentityErrorV1(
            'IDEMPOTENCY_KEY_INVALID',
            'submit idempotency key must be a caller-generated UUID',
        )
    }
    return raw.toLowerCase()
}

export function compensationApplicationIdV1(idempotencyKey: string): string {
    return `comp_app_${sha256(assertCompensationIdempotencyKeyV1(idempotencyKey))}`
}

export interface CompensationSubmitFingerprintInputV1 {
    compensationPersonId: string
    orderKey: CompensationOrderKeyV1
    claimedKopecks: number
}

/**
 * Detects a caller reusing one idempotency key for a different intent. A
 * matching key with a different fingerprint is a conflict, not a replay.
 */
export function compensationSubmitFingerprintV1(input: CompensationSubmitFingerprintInputV1): string {
    return sha256(canonicalJson({
        compensationPersonId: input.compensationPersonId,
        provider: input.orderKey.provider,
        externalParkId: input.orderKey.externalParkId,
        externalOrderId: input.orderKey.externalOrderId,
        claimedKopecks: input.claimedKopecks,
    }))
}

/** Fences a confirmation that was prepared against a superseded authorization. */
export function compensationPayoutFenceV1(authorizationId: string, applicationVersion: number): string {
    return sha256([authorizationId, String(applicationVersion)].join(FIELD_SEPARATOR))
}

export interface CompensationAuditEventIdInputV1 {
    subjectType: string
    subjectId: string
    action: string
    correlationId: string
}

/**
 * Deterministic audit identity: a retried operation appends the same row once
 * instead of multiplying the audit trail.
 */
export function compensationAuditEventIdV1(input: CompensationAuditEventIdInputV1): string {
    const digest = sha256([
        input.subjectType,
        input.subjectId,
        input.action,
        input.correlationId,
    ].join(FIELD_SEPARATOR))
    return `comp_aud_${digest}`
}

/** Owner-local identifiers for rows that have no natural caller-supplied key. */
export function compensationDerivedIdV1(prefix: string, ...parts: string[]): string {
    return `${prefix}_${sha256(parts.join(FIELD_SEPARATOR))}`
}
