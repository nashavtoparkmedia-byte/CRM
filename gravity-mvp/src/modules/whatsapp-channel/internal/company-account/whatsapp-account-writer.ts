/**
 * M2A1-S3 company-account writer.
 *
 * The only code that writes the provider-account foundation. Every rule that
 * matters is enforced by the database guards; this writer is a correct client
 * of them, and it fails closed whenever the truth is not known.
 *
 * Identity is authored from committed database state inside the transaction.
 * The runtime's process-local `unchanged` signal is supplementary evidence and
 * can only cause a refusal, never a different identity outcome.
 *
 * Raw values never leave this module: they are used as query arguments and, for
 * the PN only, rendered into a display string for the authenticated
 * confirmation UI. The LID never crosses the module boundary in any form.
 */
import { randomUUID } from 'node:crypto'

import type { Prisma } from '@prisma/client'

import { prisma } from '@/lib/prisma'

import {
    attestationWindowUntilV1,
    bindingCanonicalPairV1,
    decideWhatsAppAccountAttestationV1,
    isUsableProviderPairV1,
    renderPnForDisplayV1,
    type CanonicalProviderPairV1,
    type OpenBindingSnapshotV1,
    type WhatsAppAccountAttestationActionV1,
    type WhatsAppAccountAttestationOutcomeV1,
} from './whatsapp-account-attestation'
import type {
    WhatsAppAccountConfirmationOutcomeV1,
    WhatsAppAccountLifecycleClassV1,
    WhatsAppAccountTrustClassV1,
} from './whatsapp-account-telemetry'

type TransactionClient = Prisma.TransactionClient

export const WHATSAPP_TRANSPORT_KIND_V1 = 'whatsapp_web_slot'
const PN_KIND = 'whatsapp_pn_user'
const LID_KIND = 'whatsapp_lid_user'
const ACCOUNT_KIND = 'whatsapp_user'
const ATTESTATION_ORIGIN = 'transport_asserted'
const ACTIVATION_REASON = 'operator_confirmed_transport_binding'
const CREATION_REASON = 'observed_transport_attestation'

export interface RecordAttestationInputV1 {
    connectionId: string
    instanceId: string
    pnUser: string
    lidUser: string
    /** Supplementary runtime evidence only. */
    unchanged: boolean | null
}

export interface AttestationResultV1 {
    action: WhatsAppAccountAttestationActionV1
    outcome: WhatsAppAccountAttestationOutcomeV1
    trustStateBefore: WhatsAppAccountTrustClassV1
    trustStateAfter: WhatsAppAccountTrustClassV1
    accountLifecycle: WhatsAppAccountLifecycleClassV1
    generation: number
    operatorConfirmed: boolean
    signalAgreedWithDatabase: boolean | null
}

export interface ConfirmBindingInputV1 {
    /** Opaque slot id from the authenticated page. */
    connectionId: string
    /** Opaque binding id from the authenticated page. Never a provider value. */
    bindingId: string
    /** The authenticated principal; never derived from an unsigned selector. */
    principalId: string
}

export interface ConfirmBindingResultV1 {
    outcome: WhatsAppAccountConfirmationOutcomeV1
    trustStateAfter: WhatsAppAccountTrustClassV1
    accountLifecycle: WhatsAppAccountLifecycleClassV1
    generation: number
}

/** Everything the authenticated confirmation UI is allowed to know. */
export interface SlotConfirmationProjectionV1 {
    connectionId: string
    bindingId: string | null
    generation: number
    trustState: WhatsAppAccountTrustClassV1
    accountLifecycle: WhatsAppAccountLifecycleClassV1
    operatorConfirmed: boolean
    attestationFresh: boolean
    confirmable: boolean
    /** Display-only rendering of the PN. The LID is never projected. */
    pnDisplay: string | null
}

/** A state the writer refuses to act on, because acting could rewrite identity. */
export class WhatsAppAccountRefusalV1 extends Error {
    readonly outcome: WhatsAppAccountAttestationOutcomeV1

    constructor(outcome: WhatsAppAccountAttestationOutcomeV1) {
        super(`whatsapp account attestation refused: ${outcome}`)
        this.name = 'WhatsAppAccountRefusalV1'
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
        throw new Error('whatsapp account writer could not read the database clock')
    }
    return now.getTime()
}

function trustClass(value: string | null | undefined): WhatsAppAccountTrustClassV1 {
    switch (value) {
        case 'pending': return 'pending'
        case 'verified': return 'verified'
        case 'mismatched': return 'mismatched'
        case 'revoked': return 'revoked'
        case 'closed': return 'closed'
        default: return 'absent'
    }
}

function lifecycleClass(value: string | null | undefined): WhatsAppAccountLifecycleClassV1 {
    switch (value) {
        case 'pending_approval': return 'pending_approval'
        case 'active': return 'active'
        case 'rejected': return 'rejected'
        case 'disabled': return 'disabled'
        case 'retired': return 'retired'
        default: return 'absent'
    }
}

function generationNumber(value: bigint | number | null | undefined): number {
    if (typeof value === 'bigint') return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : Number.MAX_SAFE_INTEGER
    if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value)
    return 0
}

const OPEN_BINDING_FIELDS = {
    bindingId: true,
    accountId: true,
    trustState: true,
    transportGeneration: true,
    bindingSeq: true,
    attestedPnValue: true,
    attestedLidValue: true,
    claimedPnValue: true,
    claimedLidValue: true,
    attestedUntil: true,
    operatorConfirmedAt: true,
} as const

type OpenBindingRow = {
    bindingId: string
    accountId: string
    trustState: string
    transportGeneration: bigint
    bindingSeq: number
    attestedPnValue: string | null
    attestedLidValue: string | null
    claimedPnValue: string | null
    claimedLidValue: string | null
    attestedUntil: Date | null
    operatorConfirmedAt: Date | null
}

function snapshotOf(row: OpenBindingRow): OpenBindingSnapshotV1 {
    return {
        bindingId: row.bindingId,
        accountId: row.accountId,
        trustState: row.trustState === 'verified' ? 'verified' : 'pending',
        attestedPnValue: row.attestedPnValue,
        attestedLidValue: row.attestedLidValue,
        claimedPnValue: row.claimedPnValue,
        claimedLidValue: row.claimedLidValue,
        attestedUntilMs: row.attestedUntil === null ? null : row.attestedUntil.getTime(),
        operatorConfirmed: row.operatorConfirmedAt !== null,
    }
}

async function openBindingFor(tx: TransactionClient, connectionId: string): Promise<OpenBindingRow | null> {
    return await tx.whatsAppTransportBinding.findFirst({
        where: { transportKind: WHATSAPP_TRANSPORT_KIND_V1, transportRef: connectionId, closedAt: null },
        select: OPEN_BINDING_FIELDS,
    }) as OpenBindingRow | null
}

/**
 * Resolve the account that owns the observed pair, or create one.
 *
 * A key belongs to one account forever, so a pair whose halves resolve to
 * different accounts, or to only one account key, is an identity anomaly: the
 * writer refuses rather than guessing. The account, its PN key and its LID key
 * are inserted in one transaction because the completeness check is deferred to
 * commit.
 */
async function resolveOrCreateAccount(tx: TransactionClient, pair: CanonicalProviderPairV1): Promise<{ accountId: string; lifecycle: string }> {
    const keys = await tx.whatsAppAccountKey.findMany({
        where: {
            OR: [
                { keyKind: PN_KIND, keyValue: pair.pnUser },
                { keyKind: LID_KIND, keyValue: pair.lidUser },
            ],
        },
        select: { keyKind: true, accountId: true },
    })

    if (keys.length === 2) {
        const [first, second] = keys
        const kinds = [first.keyKind, second.keyKind].sort()
        if (first.accountId !== second.accountId || kinds[0] !== LID_KIND || kinds[1] !== PN_KIND) {
            throw new WhatsAppAccountRefusalV1('binding_pair_missing')
        }
        const account = await tx.whatsAppAccount.findUnique({
            where: { accountId: first.accountId },
            select: { accountId: true, lifecycle: true },
        })
        if (!account) throw new WhatsAppAccountRefusalV1('binding_pair_missing')
        return { accountId: account.accountId, lifecycle: account.lifecycle }
    }

    // Exactly one half already owned is a split key set: never resolvable.
    if (keys.length !== 0) throw new WhatsAppAccountRefusalV1('binding_pair_missing')

    const accountId = randomUUID()
    await tx.whatsAppAccount.create({
        data: {
            accountId,
            accountKind: ACCOUNT_KIND,
            lifecycle: 'pending_approval',
            lifecycleVersion: 1,
            lifecycleChangedBy: 'whatsapp-channel:company-account-writer',
            lifecycleReason: CREATION_REASON,
        },
    })
    await tx.whatsAppAccountKey.create({ data: { keyKind: PN_KIND, keyValue: pair.pnUser, accountId } })
    await tx.whatsAppAccountKey.create({ data: { keyKind: LID_KIND, keyValue: pair.lidUser, accountId } })
    return { accountId, lifecycle: 'pending_approval' }
}

async function openGeneration(
    tx: TransactionClient,
    input: { connectionId: string; instanceId: string; pair: CanonicalProviderPairV1; accountId: string; dbNowMs: number },
): Promise<number> {
    const highest = await tx.whatsAppTransportBinding.aggregate({
        where: { transportKind: WHATSAPP_TRANSPORT_KIND_V1, transportRef: input.connectionId },
        _max: { transportGeneration: true, bindingSeq: true },
    })
    const nextGeneration = BigInt(generationNumber(highest._max.transportGeneration)) + BigInt(1)
    const nextSeq = (highest._max.bindingSeq ?? 0) + 1

    await tx.whatsAppTransportBinding.create({
        data: {
            bindingId: randomUUID(),
            transportKind: WHATSAPP_TRANSPORT_KIND_V1,
            transportRef: input.connectionId,
            transportGeneration: nextGeneration,
            accountId: input.accountId,
            bindingSeq: nextSeq,
            trustState: 'pending',
            attestationOrigin: ATTESTATION_ORIGIN,
            attestedPnValue: input.pair.pnUser,
            attestedLidValue: input.pair.lidUser,
            claimedPnValue: input.pair.pnUser,
            claimedLidValue: input.pair.lidUser,
            attestingInstanceId: input.instanceId,
            attestedUntil: attestationWindowUntilV1(input.dbNowMs),
        },
    })
    return generationNumber(nextGeneration)
}

async function closeGeneration(tx: TransactionClient, bindingId: string, closeReason: 'superseded' | 'account_changed'): Promise<void> {
    const trustState = closeReason === 'account_changed' ? 'mismatched' : 'closed'
    const closed = await tx.whatsAppTransportBinding.updateMany({
        where: { bindingId, closedAt: null },
        data: { trustState, closeReason },
    })
    if (closed.count !== 1) throw new WhatsAppAccountRefusalV1('binding_pair_missing')
}

/**
 * Records one observation against the foundation.
 *
 * Runs as a single READ COMMITTED transaction. The observation itself is taken
 * by the caller before this function is entered: no page read, network call or
 * other external work ever happens inside the transaction.
 */
export async function recordWhatsAppAccountAttestationV1(input: RecordAttestationInputV1): Promise<AttestationResultV1> {
    try {
        return await attemptAttestation(input)
    } catch (error) {
        // A concurrent writer took the slot's next generation. Re-read once: the
        // decision is then made against the state the winner committed, so an
        // equal pair converges on a re-attestation. A second failure is final.
        if (!isLostSlotRaceV1(error)) throw error
        return await attemptAttestation(input)
    }
}

/** True when the database refused this writer because another one reached the slot first. */
export function isLostSlotRaceV1(error: unknown): boolean {
    const code = (error as { code?: unknown } | null)?.code
    if (code === 'P2002') return true
    const message = error instanceof Error ? error.message : String(error ?? '')
    return /cannot open while another binding on the transport is open/u.test(message)
        || /history must advance/u.test(message)
        || /bindingSeq must be contiguous/u.test(message)
        || /the latest slot history is newer than this transaction/u.test(message)
}

async function attemptAttestation(input: RecordAttestationInputV1): Promise<AttestationResultV1> {
    const pair: CanonicalProviderPairV1 | null = isUsableProviderPairV1({ pnUser: input.pnUser, lidUser: input.lidUser })
        ? { pnUser: input.pnUser, lidUser: input.lidUser }
        : null

    return await prisma.$transaction(async (tx) => {
        const dbNowMs = await databaseNowMsV1(tx)
        const open = await openBindingFor(tx, input.connectionId)
        const snapshot = open === null ? null : snapshotOf(open)
        const decision = decideWhatsAppAccountAttestationV1({
            observed: pair,
            openBinding: snapshot,
            unchanged: input.unchanged,
            dbNowMs,
        })

        const before = trustClass(open?.trustState)
        const signalAgreedWithDatabase = snapshot === null || pair === null || input.unchanged === null
            ? null
            : !decision.outcome.startsWith('contradiction_')

        const unchangedResult = (outcome: WhatsAppAccountAttestationOutcomeV1): AttestationResultV1 => ({
            action: decision.action,
            outcome,
            trustStateBefore: before,
            trustStateAfter: before,
            accountLifecycle: 'absent',
            generation: generationNumber(open?.transportGeneration),
            operatorConfirmed: snapshot?.operatorConfirmed ?? false,
            signalAgreedWithDatabase,
        })

        if (decision.action === 'none' || decision.action === 'refuse') {
            return unchangedResult(decision.outcome)
        }

        if (decision.action === 'reattest_open_generation') {
            if (!open || !pair) return unchangedResult('binding_pair_missing')
            const updated = await tx.whatsAppTransportBinding.updateMany({
                where: { bindingId: open.bindingId, closedAt: null, trustState: open.trustState },
                data: { attestedUntil: attestationWindowUntilV1(dbNowMs), attestingInstanceId: input.instanceId },
            })
            if (updated.count !== 1) return unchangedResult('binding_pair_missing')
            return {
                ...unchangedResult('reattested'),
                action: decision.action,
                outcome: 'reattested',
            }
        }

        if (!pair) return unchangedResult('pair_not_usable')

        if (decision.closeReason !== null && open !== null) {
            await closeGeneration(tx, open.bindingId, decision.closeReason)
        }

        const account = await resolveOrCreateAccount(tx, pair)
        const generation = await openGeneration(tx, {
            connectionId: input.connectionId,
            instanceId: input.instanceId,
            pair,
            accountId: account.accountId,
            dbNowMs,
        })

        return {
            action: decision.action,
            outcome: decision.outcome,
            trustStateBefore: before,
            trustStateAfter: 'pending',
            accountLifecycle: lifecycleClass(account.lifecycle),
            generation,
            operatorConfirmed: false,
            signalAgreedWithDatabase,
        }
    })
}

/**
 * Promotes an operator-confirmed binding.
 *
 * The client supplies only opaque identifiers. The complete pair and the
 * attestation are re-read from the database inside this transaction, and the
 * attestation must still be live by database time. Account activation and
 * binding verification happen together or not at all.
 */
export async function confirmWhatsAppAccountBindingV1(input: ConfirmBindingInputV1): Promise<ConfirmBindingResultV1> {
    const principalId = input.principalId.trim()
    if (principalId.length === 0 || principalId.length > 128 || /[\p{Cc}]/u.test(principalId)) {
        return { outcome: 'unauthenticated', trustStateAfter: 'absent', accountLifecycle: 'absent', generation: 0 }
    }

    return await prisma.$transaction(async (tx) => {
        const dbNowMs = await databaseNowMsV1(tx)
        const binding = await tx.whatsAppTransportBinding.findUnique({
            where: { bindingId: input.bindingId },
            select: { ...OPEN_BINDING_FIELDS, transportKind: true, transportRef: true, closedAt: true },
        }) as (OpenBindingRow & { transportKind: string; transportRef: string; closedAt: Date | null }) | null

        const refuse = (outcome: WhatsAppAccountConfirmationOutcomeV1): ConfirmBindingResultV1 => ({
            outcome,
            trustStateAfter: trustClass(binding?.trustState),
            accountLifecycle: 'absent',
            generation: generationNumber(binding?.transportGeneration),
        })

        if (!binding) return refuse('binding_not_found')
        // Tamper check: the confirmed binding must be the one shown for this slot.
        if (binding.transportKind !== WHATSAPP_TRANSPORT_KIND_V1 || binding.transportRef !== input.connectionId) {
            return refuse('transport_mismatch')
        }
        if (binding.closedAt !== null) return refuse('binding_not_open')
        if (binding.operatorConfirmedAt !== null) {
            const account = await tx.whatsAppAccount.findUnique({ where: { accountId: binding.accountId }, select: { lifecycle: true } })
            return {
                outcome: 'already_confirmed',
                trustStateAfter: trustClass(binding.trustState),
                accountLifecycle: lifecycleClass(account?.lifecycle),
                generation: generationNumber(binding.transportGeneration),
            }
        }
        if (binding.trustState !== 'pending') return refuse('binding_not_pending')
        if (bindingCanonicalPairV1(snapshotOf(binding)) === null) return refuse('attestation_incomplete')
        if (binding.attestedPnValue === null || binding.attestedLidValue === null) return refuse('attestation_incomplete')
        if (binding.claimedPnValue === null || binding.claimedLidValue === null) return refuse('attestation_incomplete')
        if (binding.attestedUntil === null || binding.attestedUntil.getTime() <= dbNowMs) return refuse('attestation_stale')

        const account = await tx.whatsAppAccount.findUnique({
            where: { accountId: binding.accountId },
            select: { lifecycle: true, lifecycleVersion: true },
        })
        if (!account) return refuse('account_not_confirmable')
        if (account.lifecycle !== 'pending_approval' && account.lifecycle !== 'active') return refuse('account_not_confirmable')

        if (account.lifecycle === 'pending_approval') {
            const activated = await tx.whatsAppAccount.updateMany({
                where: { accountId: binding.accountId, lifecycle: 'pending_approval', lifecycleVersion: account.lifecycleVersion },
                data: {
                    lifecycle: 'active',
                    lifecycleVersion: account.lifecycleVersion + 1,
                    lifecycleChangedBy: principalId,
                    lifecycleReason: ACTIVATION_REASON,
                },
            })
            if (activated.count !== 1) return refuse('account_not_confirmable')
        }

        const verified = await tx.whatsAppTransportBinding.updateMany({
            where: { bindingId: binding.bindingId, closedAt: null, trustState: 'pending', operatorConfirmedAt: null },
            data: {
                trustState: 'verified',
                attestedUntil: attestationWindowUntilV1(dbNowMs),
                operatorConfirmedAt: new Date(dbNowMs),
                operatorConfirmedBy: principalId,
            },
        })
        if (verified.count !== 1) return refuse('refused')

        return {
            outcome: 'confirmed',
            trustStateAfter: 'verified',
            accountLifecycle: 'active',
            generation: generationNumber(binding.transportGeneration),
        }
    })
}

/** Reads the authenticated confirmation projection for one slot. Never returns a LID. */
export async function readSlotConfirmationProjectionV1(connectionId: string): Promise<SlotConfirmationProjectionV1> {
    return await prisma.$transaction(async (tx) => {
        const dbNowMs = await databaseNowMsV1(tx)
        const open = await openBindingFor(tx, connectionId)
        if (!open) {
            return {
                connectionId,
                bindingId: null,
                generation: 0,
                trustState: 'absent',
                accountLifecycle: 'absent',
                operatorConfirmed: false,
                attestationFresh: false,
                confirmable: false,
                pnDisplay: null,
            }
        }
        const account = await tx.whatsAppAccount.findUnique({ where: { accountId: open.accountId }, select: { lifecycle: true } })
        const pair = bindingCanonicalPairV1(snapshotOf(open))
        const fresh = open.attestedUntil !== null && open.attestedUntil.getTime() > dbNowMs
        const confirmed = open.operatorConfirmedAt !== null
        return {
            connectionId,
            bindingId: open.bindingId,
            generation: generationNumber(open.transportGeneration),
            trustState: trustClass(open.trustState),
            accountLifecycle: lifecycleClass(account?.lifecycle),
            operatorConfirmed: confirmed,
            attestationFresh: fresh,
            confirmable: !confirmed && fresh && open.trustState === 'pending' && pair !== null,
            pnDisplay: pair === null ? null : renderPnForDisplayV1(pair.pnUser),
        }
    })
}
