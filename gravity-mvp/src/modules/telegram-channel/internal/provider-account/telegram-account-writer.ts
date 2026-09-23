/**
 * M2A2-TG1 Telegram provider-account writer.
 *
 * The only code that writes the Telegram provider-account foundation. Every
 * rule that matters is enforced by the database; this writer is a correct
 * client of it and fails closed whenever the principal is not proven.
 *
 * The caller performs the live `getMe()` before entering here: no provider
 * call, network request or other external work ever happens inside the
 * transaction. Credentials, session strings and bot tokens are neither
 * parameters nor columns, so they cannot reach this layer at all.
 */
import { randomUUID } from 'node:crypto'

import type { Prisma } from '@prisma/client'

import { prisma } from '@/lib/prisma'

import {
    attestationWindowUntilV1,
    decideTelegramTransportAttestationV1,
    deriveReadinessV1,
    isUsablePrincipalV1,
    openTransportKeyV1,
    TELEGRAM_TRANSPORT_KIND_BY_ACCOUNT_KIND_V1,
    type AttestedPrincipalV1,
    type OpenBindingSnapshotV1,
    type TelegramAccountKindV1,
    type TelegramAccountReadinessV1,
    type TelegramAttestationActionV1,
    type TelegramAttestationOutcomeV1,
    type TelegramTransportKindV1,
} from './telegram-account-identity'

type TransactionClient = Prisma.TransactionClient

const CREATION_REASON = 'observed_provider_authentication'
const ADMISSION_REASON = 'operator_admitted_provider_account'

export interface RecordAttestationInputV1 {
    transportKind: TelegramTransportKindV1
    /** A locator only: an MTProto connection row id, or a bot runtime reference. */
    transportRef: string
    /** Exactly what a live getMe() returned. */
    providerUserId: string
    accountKind: TelegramAccountKindV1
    attestingInstanceId: string
}

export interface AttestationResultV1 {
    action: TelegramAttestationActionV1
    outcome: TelegramAttestationOutcomeV1
    accountLifecycle: string
    trustStateAfter: string
    generation: number
    /** True when this attestation resolved to a different account than the open binding named. */
    principalChanged: boolean
}

/** Everything a consumer may know about a provider account. Never a credential. */
export interface ProviderAccountProjectionV1 {
    channel: 'telegram'
    /** Opaque to the consumer. Never parsed, compared across channels, or derived from. */
    providerAccountId: string | null
    accountKind: TelegramAccountKindV1 | null
    lifecycle: string | null
    readiness: TelegramAccountReadinessV1
    /**
     * Not yet established. TG1 proves identity and readiness only; what an
     * account may actually do needs its own evidence, so an empty set is
     * reported rather than an invented one.
     */
    capabilities: readonly string[]
}

/** A state the writer refuses to act on, because acting could rewrite identity. */
export class TelegramAccountRefusalV1 extends Error {
    readonly outcome: TelegramAttestationOutcomeV1

    constructor(outcome: TelegramAttestationOutcomeV1) {
        super(`telegram provider account attestation refused: ${outcome}`)
        this.name = 'TelegramAccountRefusalV1'
        this.outcome = outcome
    }
}

/**
 * The database clock, read inside the caller's transaction.
 *
 * Prisma exposes no typed accessor for the server clock, and the attestation
 * window must be placed against database time rather than this process's clock.
 * The statement is a constant, parameterless read of a non-mutating function:
 * it declares no table, performs no write and registers no write site.
 */
async function databaseNowMsV1(tx: TransactionClient): Promise<number> {
    const rows = await tx.$queryRaw<Array<{ now: Date }>>`SELECT now() AS now`
    const now = rows[0]?.now
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
        throw new Error('telegram provider account writer could not read the database clock')
    }
    return now.getTime()
}

function generationNumber(value: bigint | number | null | undefined): number {
    if (typeof value === 'bigint') return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : Number.MAX_SAFE_INTEGER
    if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value)
    return 0
}

type OpenBindingRow = {
    bindingId: string
    accountId: string
    trustState: string
    transportGeneration: bigint
    attestedProviderUserId: string | null
    attestedUntil: Date | null
}

async function openBindingFor(tx: TransactionClient, transportKind: TelegramTransportKindV1, transportRef: string) {
    const row = await tx.telegramTransportBinding.findUnique({
        where: { openTransportKey: openTransportKeyV1(transportKind, transportRef) },
        select: {
            bindingId: true,
            accountId: true,
            trustState: true,
            transportGeneration: true,
            attestedProviderUserId: true,
            attestedUntil: true,
            account: { select: { providerUserId: true, accountKind: true, lifecycle: true } },
        },
    })
    return row as (OpenBindingRow & { account: { providerUserId: string; accountKind: string; lifecycle: string } }) | null
}

function snapshotOf(row: OpenBindingRow & { account: { providerUserId: string; accountKind: string } }): OpenBindingSnapshotV1 {
    return {
        bindingId: row.bindingId,
        accountId: row.accountId,
        accountProviderUserId: row.account.providerUserId,
        accountKind: row.account.accountKind as TelegramAccountKindV1,
        trustState: row.trustState === 'verified' ? 'verified' : 'pending',
        attestedProviderUserId: row.attestedProviderUserId,
        attestedUntilMs: row.attestedUntil === null ? null : row.attestedUntil.getTime(),
        transportGeneration: generationNumber(row.transportGeneration),
    }
}

/**
 * Resolve the account that owns this principal, or create it.
 *
 * The provider id is the key, so a replaced session, a rotated token or a
 * recreated runtime that still authenticates as the same principal resolves to
 * the same account. An existing account whose kind disagrees with the observed
 * principal is an anomaly the writer refuses rather than reconciles.
 */
async function resolveOrCreateAccount(tx: TransactionClient, principal: AttestedPrincipalV1) {
    const existing = await tx.telegramAccount.findUnique({
        where: { providerUserId: principal.providerUserId },
        select: { accountId: true, accountKind: true, lifecycle: true },
    })
    if (existing) {
        if (existing.accountKind !== principal.accountKind) throw new TelegramAccountRefusalV1('transport_kind_mismatch')
        return existing
    }
    const accountId = randomUUID()
    await tx.telegramAccount.create({
        data: {
            accountId,
            accountKind: principal.accountKind,
            providerUserId: principal.providerUserId,
            lifecycle: 'pending_approval',
            lifecycleVersion: 1,
            lifecycleChangedBy: 'telegram-channel:provider-account-writer',
            lifecycleReason: CREATION_REASON,
        },
    })
    return { accountId, accountKind: principal.accountKind, lifecycle: 'pending_approval' }
}

async function openGeneration(
    tx: TransactionClient,
    input: { accountId: string; principal: AttestedPrincipalV1; transportKind: TelegramTransportKindV1; transportRef: string; attestingInstanceId: string; dbNowMs: number },
): Promise<number> {
    const highest = await tx.telegramTransportBinding.aggregate({
        where: { transportKind: input.transportKind, transportRef: input.transportRef },
        _max: { transportGeneration: true },
    })
    const nextGeneration = BigInt(generationNumber(highest._max.transportGeneration)) + BigInt(1)

    await tx.telegramTransportBinding.create({
        data: {
            bindingId: randomUUID(),
            accountId: input.accountId,
            transportKind: input.transportKind,
            transportRef: input.transportRef,
            transportGeneration: nextGeneration,
            trustState: 'verified',
            attestedProviderUserId: input.principal.providerUserId,
            attestingInstanceId: input.attestingInstanceId,
            attestedUntil: attestationWindowUntilV1(input.dbNowMs),
            openTransportKey: openTransportKeyV1(input.transportKind, input.transportRef),
        },
    })
    return generationNumber(nextGeneration)
}

async function closeGeneration(tx: TransactionClient, bindingId: string, closeReason: 'principal_changed'): Promise<void> {
    const closed = await tx.telegramTransportBinding.updateMany({
        where: { bindingId, closedAt: null },
        data: { trustState: 'mismatched', closeReason },
    })
    if (closed.count !== 1) throw new TelegramAccountRefusalV1('principal_not_usable')
}

/** True when the database refused this writer because another one reached the transport first. */
export function isLostTransportRaceV1(error: unknown): boolean {
    const code = (error as { code?: unknown } | null)?.code
    if (code === 'P2002') return true
    const message = error instanceof Error ? error.message : String(error ?? '')
    return /openTransportKey/u.test(message) || /transportGeneration/u.test(message)
}

/**
 * Records one live attestation against the foundation.
 *
 * Runs as a single transaction. A binding opens already `verified`, because on
 * Telegram the provider authentication *is* the proof: unlike WhatsApp there is
 * no second party whose confirmation is required.
 */
export async function recordTelegramTransportAttestationV1(input: RecordAttestationInputV1): Promise<AttestationResultV1> {
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
    const principal: AttestedPrincipalV1 | null = isUsablePrincipalV1({ providerUserId: input.providerUserId, accountKind: input.accountKind })
        ? { providerUserId: input.providerUserId, accountKind: input.accountKind }
        : null

    return await prisma.$transaction(async (tx) => {
        const dbNowMs = await databaseNowMsV1(tx)
        const open = await openBindingFor(tx, input.transportKind, input.transportRef)
        const snapshot = open === null ? null : snapshotOf(open)
        const decision = decideTelegramTransportAttestationV1({
            observed: principal,
            transportKind: input.transportKind,
            openBinding: snapshot,
            dbNowMs,
        })

        const unchanged = (): AttestationResultV1 => ({
            action: decision.action,
            outcome: decision.outcome,
            accountLifecycle: open?.account.lifecycle ?? 'unknown',
            trustStateAfter: open?.trustState ?? 'absent',
            generation: generationNumber(open?.transportGeneration),
            principalChanged: false,
        })

        if (decision.action === 'none') return unchanged()
        if (decision.action === 'refuse') throw new TelegramAccountRefusalV1(decision.outcome)
        if (!principal) return unchanged()

        if (decision.action === 'reattest_open_generation') {
            if (!open) return unchanged()
            const updated = await tx.telegramTransportBinding.updateMany({
                where: { bindingId: open.bindingId, closedAt: null, trustState: open.trustState },
                data: {
                    trustState: 'verified',
                    attestedProviderUserId: principal.providerUserId,
                    attestedUntil: attestationWindowUntilV1(dbNowMs),
                },
            })
            if (updated.count !== 1) throw new TelegramAccountRefusalV1('principal_not_usable')
            return {
                action: decision.action,
                outcome: 'reattested',
                accountLifecycle: open.account.lifecycle,
                trustStateAfter: 'verified',
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
            dbNowMs,
        })

        return {
            action: decision.action,
            outcome: decision.outcome,
            accountLifecycle: account.lifecycle,
            trustStateAfter: 'verified',
            generation,
            principalChanged: decision.closeReason === 'principal_changed',
        }
    })
}

/**
 * Admits an account. Lifecycle is administrative and separate from readiness:
 * admitting an account says nothing about whether a transport is currently
 * proven to be acting as it.
 */
export async function admitTelegramAccountV1(input: { accountId: string; principalId: string }): Promise<{ outcome: string; lifecycle: string }> {
    const principalId = input.principalId.trim()
    if (principalId.length === 0 || principalId.length > 128 || /[\p{Cc}]/u.test(principalId)) {
        return { outcome: 'unauthenticated', lifecycle: 'unknown' }
    }
    return await prisma.$transaction(async (tx) => {
        const account = await tx.telegramAccount.findUnique({
            where: { accountId: input.accountId },
            select: { lifecycle: true, lifecycleVersion: true },
        })
        if (!account) return { outcome: 'account_not_found', lifecycle: 'unknown' }
        if (account.lifecycle === 'active') return { outcome: 'already_active', lifecycle: 'active' }
        if (account.lifecycle !== 'pending_approval') return { outcome: 'not_admissible', lifecycle: account.lifecycle }
        const admitted = await tx.telegramAccount.updateMany({
            where: { accountId: input.accountId, lifecycle: 'pending_approval', lifecycleVersion: account.lifecycleVersion },
            data: {
                lifecycle: 'active',
                lifecycleVersion: account.lifecycleVersion + 1,
                lifecycleChangedBy: principalId,
                lifecycleReason: ADMISSION_REASON,
            },
        })
        if (admitted.count !== 1) return { outcome: 'not_admissible', lifecycle: account.lifecycle }
        return { outcome: 'admitted', lifecycle: 'active' }
    })
}

/**
 * The provider-account projection for one transport. Carries only stable
 * business-facing facts: never a credential, a session string, a token, a
 * process identity or a routing internal.
 */
export async function readProviderAccountProjectionV1(transportKind: TelegramTransportKindV1, transportRef: string): Promise<ProviderAccountProjectionV1> {
    return await prisma.$transaction(async (tx) => {
        const dbNowMs = await databaseNowMsV1(tx)
        const open = await openBindingFor(tx, transportKind, transportRef)
        if (!open) {
            return { channel: 'telegram', providerAccountId: null, accountKind: null, lifecycle: null, readiness: 'no_open_transport', capabilities: [] }
        }
        const readiness = deriveReadinessV1({
            lifecycle: open.account.lifecycle,
            openBinding: { trustState: open.trustState, attestedUntilMs: open.attestedUntil?.getTime() ?? null },
            dbNowMs,
        })
        return {
            channel: 'telegram',
            providerAccountId: open.accountId,
            accountKind: open.account.accountKind as TelegramAccountKindV1,
            lifecycle: open.account.lifecycle,
            readiness,
            capabilities: [],
        }
    })
}

/** Exported for the boundary control: the transport kind each principal may use. */
export const TELEGRAM_TRANSPORT_KIND_FOR_ACCOUNT_KIND_V1 = TELEGRAM_TRANSPORT_KIND_BY_ACCOUNT_KIND_V1
