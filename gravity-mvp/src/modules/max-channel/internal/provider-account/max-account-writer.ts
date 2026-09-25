/**
 * M2A2-MAX1A MAX provider-account writer.
 *
 * The only code that writes the MAX provider-account foundation. Every rule that
 * matters is enforced by the database; this writer is a correct client of it and
 * fails closed whenever the principal is not proven.
 *
 * The caller has already observed the live principal before entering here: no
 * provider call, network request, scraper request or other external work ever
 * happens inside the transaction. Credentials, session material and bot tokens
 * are neither parameters nor columns, so they cannot reach this layer at all.
 *
 * MAX1A is inert: nothing in the runtime calls this writer yet.
 */
import { randomUUID } from 'node:crypto'

import type { Prisma } from '@prisma/client'

import { prisma } from '@/lib/prisma'

import {
    decideMaxTransportAttestationV1,
    deriveIdentityStateV1,
    isUsablePrincipalV1,
    openTransportKeyV1,
    type AttestedPrincipalV1,
    type MaxAttestationActionV1,
    type MaxAttestationOutcomeV1,
    type MaxAuthEventKindV1,
    type MaxBindingCloseReasonV1,
    type MaxIdentityStateV1,
    type MaxTransportKindV1,
    type OpenBindingSnapshotV1,
} from './max-account-identity'

type TransactionClient = Prisma.TransactionClient

const CREATION_REASON = 'observed_provider_authentication'

export interface RecordAttestationInputV1 {
    transportKind: MaxTransportKindV1
    /** A YOKO locator only. It is read from configuration, never from the principal. */
    transportRef: string
    /** Exactly what the live auth frame reported. */
    providerUserId: string
    /** The runtime instance that observed it. Diagnostic only. */
    attestingInstanceId: string
    /** Which live frame carried the principal. */
    authEventKind: MaxAuthEventKindV1
}

export interface AttestationResultV1 {
    action: MaxAttestationActionV1
    outcome: MaxAttestationOutcomeV1
    accountLifecycle: string
    generation: number
    /** True when this observation resolved to a different account than the open binding named. */
    principalChanged: boolean
}

/** Everything a consumer may know about a MAX provider account. Never a credential. */
export interface MaxProviderAccountProjectionV1 {
    channel: 'max'
    /** Opaque to the consumer. Never parsed, compared across channels, or derived from. */
    providerAccountId: string | null
    lifecycle: string | null
    identityState: MaxIdentityStateV1
    /**
     * When the principal was last observed. Evidence only: MAX publishes no
     * expiry, so this never produces a stale or fresh identity state.
     */
    lastAttestedAt: string | null
    /**
     * Not yet established. This foundation proves identity only; what an account
     * may actually do needs its own evidence, so an empty set is reported rather
     * than an invented one.
     */
    capabilities: readonly string[]
}

/** A state the writer refuses to act on, because acting could rewrite identity. */
export class MaxAccountRefusalV1 extends Error {
    readonly outcome: MaxAttestationOutcomeV1

    constructor(outcome: MaxAttestationOutcomeV1) {
        super(`max provider account attestation refused: ${outcome}`)
        this.name = 'MaxAccountRefusalV1'
        this.outcome = outcome
    }
}

function generationNumber(value: bigint | number | null | undefined): number {
    if (typeof value === 'bigint') return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : Number.MAX_SAFE_INTEGER
    if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value)
    return 0
}

type OpenBindingRow = {
    bindingId: string
    accountId: string
    transportGeneration: bigint
    attestedProviderUserId: string | null
    lastAttestedAt: Date | null
}

async function openBindingFor(tx: TransactionClient, transportKind: MaxTransportKindV1, transportRef: string) {
    const row = await tx.maxTransportBinding.findUnique({
        where: { openTransportKey: openTransportKeyV1(transportKind, transportRef) },
        select: {
            bindingId: true,
            accountId: true,
            transportGeneration: true,
            attestedProviderUserId: true,
            lastAttestedAt: true,
            account: { select: { providerUserId: true, lifecycle: true } },
        },
    })
    return row as (OpenBindingRow & { account: { providerUserId: string; lifecycle: string } }) | null
}

function snapshotOf(row: OpenBindingRow & { account: { providerUserId: string } }): OpenBindingSnapshotV1 {
    return {
        bindingId: row.bindingId,
        accountId: row.accountId,
        accountProviderUserId: row.account.providerUserId,
        attestedProviderUserId: row.attestedProviderUserId,
        transportGeneration: generationNumber(row.transportGeneration),
    }
}

/**
 * Resolve the account that owns this principal, or create it.
 *
 * The provider id is the key, so a re-paired browser profile or a recreated
 * runtime that still authenticates as the same principal resolves to the same
 * account. A first observation always creates a `pending_approval` account:
 * observation never admits.
 */
async function resolveOrCreateAccount(tx: TransactionClient, principal: AttestedPrincipalV1) {
    const existing = await tx.maxAccount.findUnique({
        where: { providerUserId: principal.providerUserId },
        select: { accountId: true, lifecycle: true },
    })
    if (existing) return existing
    const accountId = randomUUID()
    await tx.maxAccount.create({
        data: {
            accountId,
            providerUserId: principal.providerUserId,
            lifecycle: 'pending_approval',
            lifecycleVersion: 1,
            lifecycleChangedBy: 'max-channel:provider-account-writer',
            lifecycleChangeReason: CREATION_REASON,
        },
    })
    return { accountId, lifecycle: 'pending_approval' }
}

async function openGeneration(
    tx: TransactionClient,
    input: {
        accountId: string
        principal: AttestedPrincipalV1
        transportKind: MaxTransportKindV1
        transportRef: string
        attestingInstanceId: string
        authEventKind: MaxAuthEventKindV1
    },
): Promise<number> {
    const highest = await tx.maxTransportBinding.aggregate({
        where: { transportKind: input.transportKind, transportRef: input.transportRef },
        _max: { transportGeneration: true },
    })
    const nextGeneration = BigInt(generationNumber(highest._max.transportGeneration)) + BigInt(1)

    await tx.maxTransportBinding.create({
        data: {
            bindingId: randomUUID(),
            accountId: input.accountId,
            transportKind: input.transportKind,
            transportRef: input.transportRef,
            transportGeneration: nextGeneration,
            attestedProviderUserId: input.principal.providerUserId,
            attestingInstanceId: input.attestingInstanceId,
            lastAuthEventKind: input.authEventKind,
            openTransportKey: openTransportKeyV1(input.transportKind, input.transportRef),
        },
    })
    return generationNumber(nextGeneration)
}

async function closeGeneration(tx: TransactionClient, bindingId: string, closeReason: MaxBindingCloseReasonV1): Promise<void> {
    const closed = await tx.maxTransportBinding.updateMany({
        where: { bindingId, closedAt: null },
        data: { closeReason },
    })
    if (closed.count !== 1) throw new MaxAccountRefusalV1('principal_not_usable')
}

/** True when the database refused this writer because another one reached the transport first. */
export function isLostTransportRaceV1(error: unknown): boolean {
    const code = (error as { code?: unknown } | null)?.code
    if (code === 'P2002') return true
    const message = error instanceof Error ? error.message : String(error ?? '')
    return /openTransportKey/u.test(message) || /transportGeneration/u.test(message)
}

/**
 * Records one live observation against the foundation.
 *
 * Runs as a single transaction. A binding is verified by construction: a row
 * only exists because a live auth frame proved the principal it carries, so
 * there is no separate trust state to record and no unverified state to leave
 * behind.
 */
export async function recordMaxTransportAttestationV1(input: RecordAttestationInputV1): Promise<AttestationResultV1> {
    try {
        return await attemptAttestation(input)
    } catch (error) {
        // A concurrent writer took this transport's next generation. Re-read
        // once: the decision is then made against what the winner committed.
        if (!isLostTransportRaceV1(error)) throw error
        return await attemptAttestation(input)
    }
}

async function attemptAttestation(input: RecordAttestationInputV1): Promise<AttestationResultV1> {
    const principal: AttestedPrincipalV1 | null = isUsablePrincipalV1({ providerUserId: input.providerUserId })
        ? { providerUserId: input.providerUserId }
        : null

    return await prisma.$transaction(async (tx) => {
        const open = await openBindingFor(tx, input.transportKind, input.transportRef)
        const snapshot = open === null ? null : snapshotOf(open)
        const decision = decideMaxTransportAttestationV1({
            observed: principal,
            transportKind: input.transportKind,
            transportRef: input.transportRef,
            openBinding: snapshot,
        })

        const unchanged = (): AttestationResultV1 => ({
            action: decision.action,
            outcome: decision.outcome,
            accountLifecycle: open?.account.lifecycle ?? 'unknown',
            generation: generationNumber(open?.transportGeneration),
            principalChanged: false,
        })

        if (decision.action === 'refuse') throw new MaxAccountRefusalV1(decision.outcome)
        if (decision.action === 'none') return unchanged()
        if (!principal) return unchanged()

        if (decision.action === 'reattest_existing_generation') {
            if (!open) return unchanged()
            const updated = await tx.maxTransportBinding.updateMany({
                where: { bindingId: open.bindingId, closedAt: null },
                data: {
                    attestingInstanceId: input.attestingInstanceId,
                    lastAuthEventKind: input.authEventKind,
                },
            })
            if (updated.count !== 1) throw new MaxAccountRefusalV1('principal_not_usable')
            return {
                action: decision.action,
                outcome: 'reattested',
                accountLifecycle: open.account.lifecycle,
                generation: generationNumber(open.transportGeneration),
                principalChanged: false,
            }
        }

        if (decision.closeReason !== null && open !== null) {
            await closeGeneration(tx, open.bindingId, decision.closeReason)
        }

        const account = await resolveOrCreateAccount(tx, principal)
        const generation = await openGeneration(tx, {
            accountId: account.accountId,
            principal,
            transportKind: input.transportKind,
            transportRef: input.transportRef,
            attestingInstanceId: input.attestingInstanceId,
            authEventKind: input.authEventKind,
        })

        return {
            action: decision.action,
            outcome: decision.outcome,
            accountLifecycle: account.lifecycle,
            generation,
            principalChanged: decision.closeReason === 'principal_changed',
        }
    })
}

/**
 * The provider-account projection for one transport. Carries only stable
 * business-facing facts: never a credential, a session value, a process identity
 * or a routing internal.
 *
 * It is deterministic from durable owner-side state alone. It performs no
 * network call and knows nothing about whether the MAX runtime is currently
 * healthy: that is a separate runtime signal a consumer combines itself.
 */
export async function readMaxProviderAccountProjectionV1(
    transportKind: MaxTransportKindV1,
    transportRef: string,
): Promise<MaxProviderAccountProjectionV1> {
    return await prisma.$transaction(async (tx) => {
        const open = await openBindingFor(tx, transportKind, transportRef)
        if (!open) {
            return {
                channel: 'max',
                providerAccountId: null,
                lifecycle: null,
                identityState: deriveIdentityStateV1({ lifecycle: null, hasOpenBinding: false }),
                lastAttestedAt: null,
                capabilities: [],
            }
        }
        return {
            channel: 'max',
            providerAccountId: open.accountId,
            lifecycle: open.account.lifecycle,
            identityState: deriveIdentityStateV1({ lifecycle: open.account.lifecycle, hasOpenBinding: true }),
            lastAttestedAt: open.lastAttestedAt?.toISOString() ?? null,
            capabilities: [],
        }
    })
}
