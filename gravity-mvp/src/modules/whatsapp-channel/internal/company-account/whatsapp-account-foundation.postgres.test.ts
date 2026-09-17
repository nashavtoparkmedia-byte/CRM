/**
 * Isolated-PostgreSQL proof for the WhatsApp company-account foundation (M2A1-S1).
 *
 * Gated behind YOKO_WHATSAPP_ACCOUNT_FOUNDATION_POSTGRES_PROOF=1 and an isolated
 * DATABASE_URL whose schema has every migration applied. It never touches a
 * production database.
 *
 * The four tables have no runtime writer or reader, so every statement here is
 * raw SQL aimed at the database invariants themselves. The tables refuse row
 * removal and truncation, so nothing is cleaned up: each test uses fresh ids.
 * Interleavings use two real connections and prove that the second statement
 * is waiting on a lock before the first transaction commits.
 */
import { randomInt, randomUUID } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const proof = process.env.YOKO_WHATSAPP_ACCOUNT_FOUNDATION_POSTGRES_PROOF === '1' ? describe : describe.skip

interface Db {
    $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>
    $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>
}

type KeyKind = 'whatsapp_pn_user' | 'whatsapp_lid_user'
type Capability = 'inbound' | 'outbound' | 'history_import'
type Settled = { ok: true } | { ok: false; message: string }

interface AccountFixture {
    accountId: string
    pn: string
    lid: string
}

interface BindingFixture {
    bindingId: string
    transportRef: string
}

interface LeaseRow {
    epoch: number
    version: number
    state: string
    holderBindingId: string
    holderInstanceId: string
    heartbeatAt: Date
    leaseUntil: Date
    fenceUntil: Date
    lastReleasedAt: Date | null
    dbNow: Date
}

const FIRST = 'wa-account-proof-first'
const SECOND = 'wa-account-proof-second'
const TRANSACTION = { maxWait: 10_000, timeout: 30_000 }
const NEW_TABLES = ['WhatsAppAccount', 'WhatsAppAccountKey', 'WhatsAppTransportBinding', 'WhatsAppCapabilityLease']
// The database objects that refuse an incomplete or foreign key set, named so a
// refusal proves which half of the WhatsApp provider key set was rejected.
const PN_KEY_PROOF = 'WhatsAppTransportBinding_attestedPnKind_attestedPnValue_ac_fkey'
const LID_KEY_PROOF = 'WhatsAppTransportBinding_attestedLidKind_attestedLidValue__fkey'
const VERIFIED_KEY_SET = 'WhatsAppTransportBinding_verified_key_set_check'
const FIXED_KEY_KINDS = 'WhatsAppTransportBinding_key_kind_check'
const CLAIMED_KEY_SET = 'WhatsAppTransportBinding_claimed_key_check'
const KEY_PAIR = 'WhatsAppTransportBinding_attested_key_pair_check'
const HISTORY_MUST_ADVANCE = 'bindingSeq and transportGeneration both strictly increase'
// PostgreSQL reports the unique slot sequence index by its key columns.
const SEQUENCE_TAKEN = 'Key ("transportKind", "transportRef", "bindingSeq")='

let first: PrismaClient
let second: PrismaClient
let observer: PrismaClient
// The search_path pins as the migration left them, read before any test re-pins a guard.
let migrationPins: Array<{ functionName: string; pinned: boolean }>

function clientFor(applicationName: string, connectionLimit = 2): PrismaClient {
    const url = new URL(process.env.DATABASE_URL ?? '')
    url.searchParams.set('application_name', applicationName)
    url.searchParams.set('connection_limit', String(connectionLimit))
    return new PrismaClient({ datasourceUrl: url.toString() })
}

const newId = (prefix: string): string => `${prefix}-${randomUUID()}`
const newKeyValue = (): string => `${randomInt(100_000, 1_000_000)}${randomInt(100_000, 1_000_000)}`
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const secondsBetween = (later: Date, earlier: Date): number => (later.getTime() - earlier.getTime()) / 1000

function deferredSignal(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void
    const promise = new Promise<void>((done) => { resolve = done })
    return { promise, resolve }
}

async function settle(operation: Promise<unknown>): Promise<Settled> {
    try {
        await operation
        return { ok: true }
    } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
}

function refusal(result: Settled): string {
    expect(result.ok).toBe(false)
    return result.ok ? '' : result.message
}

// ---------------------------------------------------------------------------
// Accounts and keys

async function insertAccount(db: Db, accountId: string): Promise<void> {
    await db.$executeRawUnsafe(
        `INSERT INTO "WhatsAppAccount"
            ("accountId", "accountKind", "lifecycle", "lifecycleVersion", "lifecycleChangedBy", "lifecycleReason")
        VALUES ($1, 'whatsapp_user', 'pending_approval', 1, 'system', 'observed')`,
        accountId,
    )
}

async function insertKey(db: Db, accountId: string, keyKind: KeyKind, keyValue: string): Promise<void> {
    await db.$executeRawUnsafe(
        'INSERT INTO "WhatsAppAccountKey" ("keyKind", "keyValue", "accountId") VALUES ($1, $2, $3)',
        keyKind,
        keyValue,
        accountId,
    )
}

async function createAccount(pn = newKeyValue(), lid = newKeyValue()): Promise<AccountFixture> {
    const accountId = newId('acc')
    await first.$transaction(async (tx) => {
        await insertAccount(tx, accountId)
        await insertKey(tx, accountId, 'whatsapp_pn_user', pn)
        await insertKey(tx, accountId, 'whatsapp_lid_user', lid)
    }, TRANSACTION)
    return { accountId, pn, lid }
}

async function moveLifecycle(db: Db, accountId: string, lifecycle: string): Promise<number> {
    return db.$executeRawUnsafe(
        `UPDATE "WhatsAppAccount"
        SET "lifecycle" = $2,
            "lifecycleVersion" = "lifecycleVersion" + 1,
            "lifecycleChangedBy" = 'operator-1',
            "lifecycleReason" = 'proof'
        WHERE "accountId" = $1`,
        accountId,
        lifecycle,
    )
}

async function activeAccount(): Promise<AccountFixture> {
    const account = await createAccount()
    expect(await moveLifecycle(first, account.accountId, 'active')).toBe(1)
    return account
}

async function readAccount(accountId: string): Promise<{ lifecycle: string; lifecycleVersion: number; createdAt: Date; lifecycleChangedAt: Date; dbNow: Date } | undefined> {
    const rows = await observer.$queryRawUnsafe<Array<{ lifecycle: string; lifecycleVersion: number; createdAt: Date; lifecycleChangedAt: Date; dbNow: Date }>>(
        'SELECT "lifecycle", "lifecycleVersion", "createdAt", "lifecycleChangedAt", now() AS "dbNow" FROM "WhatsAppAccount" WHERE "accountId" = $1',
        accountId,
    )
    return rows[0]
}

async function countKeys(accountId: string): Promise<number> {
    const rows = await observer.$queryRawUnsafe<Array<{ keys: number }>>(
        'SELECT count(*)::int AS "keys" FROM "WhatsAppAccountKey" WHERE "accountId" = $1',
        accountId,
    )
    return rows[0].keys
}

async function lockAccount(db: Db, accountId: string): Promise<void> {
    await db.$queryRawUnsafe(
        'SELECT 1 AS "locked" FROM "WhatsAppAccount" WHERE "accountId" = $1 FOR NO KEY UPDATE',
        accountId,
    )
}

// ---------------------------------------------------------------------------
// Transport bindings

async function openBinding(
    db: Db,
    input: {
        accountId: string
        pn: string | null
        lid: string | null
        transportRef?: string
        bindingSeq?: number
        generation?: number
        attestedSeconds?: number
    },
): Promise<BindingFixture> {
    const bindingId = newId('bind')
    const transportRef = input.transportRef ?? newId('slot')
    await db.$executeRawUnsafe(
        `INSERT INTO "WhatsAppTransportBinding" (
            "bindingId", "transportKind", "transportRef", "transportGeneration", "accountId", "bindingSeq",
            "trustState", "attestationOrigin", "attestedPnValue", "attestedLidValue", "attestingInstanceId", "attestedUntil"
        ) VALUES (
            $1, 'whatsapp_web_slot', $2, $3::bigint, $4, $5::int,
            'verified', 'provider_verified', $6, $7, 'attester-1', now() + make_interval(secs => $8::double precision)
        )`,
        bindingId,
        transportRef,
        input.generation ?? 1,
        input.accountId,
        input.bindingSeq ?? 1,
        input.pn,
        input.lid,
        input.attestedSeconds ?? 600,
    )
    return { bindingId, transportRef }
}

async function openPendingBinding(
    db: Db,
    input: { accountId: string; transportRef?: string; bindingSeq?: number; generation?: number },
): Promise<BindingFixture> {
    const bindingId = newId('bind')
    const transportRef = input.transportRef ?? newId('slot')
    await db.$executeRawUnsafe(
        `INSERT INTO "WhatsAppTransportBinding" (
            "bindingId", "transportKind", "transportRef", "transportGeneration", "accountId", "bindingSeq",
            "trustState", "attestationOrigin", "attestingInstanceId"
        ) VALUES ($1, 'whatsapp_web_slot', $2, $3::bigint, $4, $5::int, 'pending', 'provider_verified', 'attester-1')`,
        bindingId,
        transportRef,
        input.generation ?? 1,
        input.accountId,
        input.bindingSeq ?? 1,
    )
    return { bindingId, transportRef }
}

async function openAssertedBinding(db: Db, accountId: string, claimedPn: string | null, claimedLid: string | null): Promise<BindingFixture> {
    const bindingId = newId('bind')
    const transportRef = newId('slot')
    await db.$executeRawUnsafe(
        `INSERT INTO "WhatsAppTransportBinding" (
            "bindingId", "transportKind", "transportRef", "transportGeneration", "accountId", "bindingSeq",
            "trustState", "attestationOrigin", "claimedPnValue", "claimedLidValue", "attestingInstanceId"
        ) VALUES ($1, 'whatsapp_web_slot', $2, 1, $3, 1, 'pending', 'transport_asserted', $4, $5, 'attester-1')`,
        bindingId,
        transportRef,
        accountId,
        claimedPn,
        claimedLid,
    )
    return { bindingId, transportRef }
}

/** Records attestation evidence on a binding without changing its trust state. */
async function attestBinding(db: Db, bindingId: string, pn: string | null, lid: string | null, seconds = 600): Promise<number> {
    return db.$executeRawUnsafe(
        `UPDATE "WhatsAppTransportBinding"
        SET "attestedPnValue" = $2,
            "attestedLidValue" = $3,
            "attestedUntil" = now() + make_interval(secs => $4::double precision)
        WHERE "bindingId" = $1`,
        bindingId,
        pn,
        lid,
        seconds,
    )
}

async function verifyBinding(db: Db, bindingId: string, pn: string | null, lid: string | null): Promise<number> {
    return db.$executeRawUnsafe(
        `UPDATE "WhatsAppTransportBinding"
        SET "trustState" = 'verified',
            "attestedPnValue" = $2,
            "attestedLidValue" = $3,
            "attestedUntil" = now() + interval '15 minutes'
        WHERE "bindingId" = $1`,
        bindingId,
        pn,
        lid,
    )
}

async function setClaimedPn(db: Db, bindingId: string, value: string | null): Promise<number> {
    return db.$executeRawUnsafe(
        'UPDATE "WhatsAppTransportBinding" SET "claimedPnValue" = $2 WHERE "bindingId" = $1',
        bindingId,
        value,
    )
}

async function setClaimedLid(db: Db, bindingId: string, value: string | null): Promise<number> {
    return db.$executeRawUnsafe(
        'UPDATE "WhatsAppTransportBinding" SET "claimedLidValue" = $2 WHERE "bindingId" = $1',
        bindingId,
        value,
    )
}

async function confirmBinding(db: Db, bindingId: string): Promise<number> {
    return db.$executeRawUnsafe(
        `UPDATE "WhatsAppTransportBinding"
        SET "operatorConfirmedAt" = now(), "operatorConfirmedBy" = 'operator-1'
        WHERE "bindingId" = $1`,
        bindingId,
    )
}

async function closeBinding(db: Db, bindingId: string, trustState: 'mismatched' | 'revoked' | 'closed', closeReason: string): Promise<number> {
    return db.$executeRawUnsafe(
        'UPDATE "WhatsAppTransportBinding" SET "trustState" = $2, "closeReason" = $3 WHERE "bindingId" = $1',
        bindingId,
        trustState,
        closeReason,
    )
}

async function readBinding(bindingId: string): Promise<{
    accountId: string
    transportRef: string
    generation: number
    trustState: string
    closedAt: Date | null
    closeReason: string | null
    lastAttestedAt: Date | null
    attestedUntil: Date | null
    stale: boolean | null
    attestedPnValue: string | null
    attestedLidValue: string | null
}> {
    const rows = await observer.$queryRawUnsafe<Array<{
        accountId: string
        transportRef: string
        generation: number
        trustState: string
        closedAt: Date | null
        closeReason: string | null
        lastAttestedAt: Date | null
        attestedUntil: Date | null
        stale: boolean | null
        attestedPnValue: string | null
        attestedLidValue: string | null
    }>>(
        `SELECT "accountId", "transportRef", "transportGeneration"::int AS "generation", "trustState", "closedAt",
            "closeReason", "lastAttestedAt", "attestedUntil", "attestedUntil" <= clock_timestamp() AS "stale",
            "attestedPnValue", "attestedLidValue"
        FROM "WhatsAppTransportBinding" WHERE "bindingId" = $1`,
        bindingId,
    )
    return rows[0]
}

async function readSlotHistory(transportRef: string): Promise<Array<{ bindingSeq: number; generation: number }>> {
    return observer.$queryRawUnsafe<Array<{ bindingSeq: number; generation: number }>>(
        `SELECT "bindingSeq", "transportGeneration"::int AS "generation"
        FROM "WhatsAppTransportBinding" WHERE "transportKind" = 'whatsapp_web_slot' AND "transportRef" = $1
        ORDER BY "bindingSeq"`,
        transportRef,
    )
}

// ---------------------------------------------------------------------------
// Capability leases

async function acquire(
    db: Db,
    input: { accountId: string; capability: Capability; bindingId: string; instanceId: string; seconds: number },
): Promise<number> {
    return db.$executeRawUnsafe(
        `INSERT INTO "WhatsAppCapabilityLease"
            ("accountId", "capability", "epoch", "version", "holderBindingId", "holderInstanceId", "state", "leaseUntil")
        VALUES ($1, $2, 1, 1, $3, $4, 'held', now() + make_interval(secs => $5::double precision))`,
        input.accountId,
        input.capability,
        input.bindingId,
        input.instanceId,
        input.seconds,
    )
}

async function renew(
    db: Db,
    input: { accountId: string; capability: Capability; epoch: number; instanceId: string; seconds: number },
): Promise<number> {
    return db.$executeRawUnsafe(
        `UPDATE "WhatsAppCapabilityLease"
        SET "version" = "version" + 1,
            "leaseUntil" = now() + make_interval(secs => $5::double precision)
        WHERE "accountId" = $1 AND "capability" = $2 AND "epoch" = $3::bigint
            AND "holderInstanceId" = $4 AND "state" = 'held'`,
        input.accountId,
        input.capability,
        input.epoch,
        input.instanceId,
        input.seconds,
    )
}

async function releaseByOperator(db: Db, accountId: string, capability: Capability): Promise<number> {
    return db.$executeRawUnsafe(
        `UPDATE "WhatsAppCapabilityLease"
        SET "state" = 'released', "version" = "version" + 1
        WHERE "accountId" = $1 AND "capability" = $2 AND "state" = 'held'`,
        accountId,
        capability,
    )
}

async function releaseAsInstance(
    input: { accountId: string; capability: Capability; epoch: number; instanceId: string; declaredInstanceId: string },
): Promise<number> {
    return first.$transaction(async (tx) => {
        await tx.$queryRawUnsafe(
            "SELECT set_config('yoko.whatsapp_lease_holder', $1 || ':' || pg_current_xact_id()::text, true) AS \"holder\"",
            input.declaredInstanceId,
        )
        return tx.$executeRawUnsafe(
            `UPDATE "WhatsAppCapabilityLease"
            SET "state" = 'released', "version" = "version" + 1
            WHERE "accountId" = $1 AND "capability" = $2 AND "epoch" = $3::bigint
                AND "holderInstanceId" = $4 AND "state" = 'held'`,
            input.accountId,
            input.capability,
            input.epoch,
            input.instanceId,
        )
    }, TRANSACTION)
}

async function takeover(
    db: Db,
    input: { accountId: string; capability: Capability; fromEpoch: number; bindingId: string; instanceId: string; seconds: number },
): Promise<number> {
    return db.$executeRawUnsafe(
        `UPDATE "WhatsAppCapabilityLease"
        SET "epoch" = "epoch" + 1,
            "version" = "version" + 1,
            "holderBindingId" = $4,
            "holderInstanceId" = $5,
            "state" = 'held',
            "leaseUntil" = now() + make_interval(secs => $6::double precision)
        WHERE "accountId" = $1 AND "capability" = $2 AND "epoch" = $3::bigint`,
        input.accountId,
        input.capability,
        input.fromEpoch,
        input.bindingId,
        input.instanceId,
        input.seconds,
    )
}

async function holdsAuthority(
    db: Db,
    input: { accountId: string; capability: Capability; epoch: number; instanceId: string; bindingId: string },
): Promise<boolean> {
    const rows = await db.$queryRawUnsafe<unknown[]>(
        `SELECT 1 AS "held" FROM "WhatsAppCapabilityLease"
        WHERE "accountId" = $1 AND "capability" = $2 AND "epoch" = $3::bigint
            AND "holderInstanceId" = $4 AND "holderBindingId" = $5
            AND "state" = 'held' AND "leaseUntil" > clock_timestamp()
        FOR SHARE`,
        input.accountId,
        input.capability,
        input.epoch,
        input.instanceId,
        input.bindingId,
    )
    return rows.length === 1
}

async function readLease(accountId: string, capability: Capability): Promise<LeaseRow> {
    const rows = await observer.$queryRawUnsafe<LeaseRow[]>(
        `SELECT "epoch"::int AS "epoch", "version"::int AS "version", "state", "holderBindingId", "holderInstanceId",
            "heartbeatAt", "leaseUntil", "fenceUntil", "lastReleasedAt", clock_timestamp() AS "dbNow"
        FROM "WhatsAppCapabilityLease" WHERE "accountId" = $1 AND "capability" = $2`,
        accountId,
        capability,
    )
    return rows[0]
}

/** An active account with two open, verified, fresh transports. */
async function leaseReadyAccount(attestedSeconds = 600): Promise<AccountFixture & { primary: BindingFixture; secondary: BindingFixture }> {
    const account = await activeAccount()
    const primary = await openBinding(first, { ...account, attestedSeconds })
    const secondary = await openBinding(first, { ...account, attestedSeconds })
    return { ...account, primary, secondary }
}

// ---------------------------------------------------------------------------
// Two-connection interleaving

async function waitUntilBlocked(applicationName: string): Promise<void> {
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
        const rows = await observer.$queryRawUnsafe<Array<{ waiting: number }>>(
            `SELECT count(*)::int AS "waiting" FROM pg_stat_activity
            WHERE application_name = $1 AND wait_event_type = 'Lock' AND datname = current_database()`,
            applicationName,
        )
        if (rows[0].waiting > 0) return
        await pause(20)
    }
    throw new Error(`${applicationName} never waited on a lock`)
}

/**
 * Runs `lead` in an open transaction on the first connection, starts `follow`
 * in a transaction on the second connection, proves the follower is blocked on
 * a lock, then commits the leader and reports both outcomes.
 */
async function interleave(
    lead: (tx: Db) => Promise<unknown>,
    follow: (tx: Db) => Promise<unknown>,
): Promise<{ lead: Settled; follow: Settled }> {
    let leadReady!: () => void
    let commitLead!: () => void
    const ready = new Promise<void>((resolve) => { leadReady = resolve })
    const commit = new Promise<void>((resolve) => { commitLead = resolve })
    const leadResult = settle(first.$transaction(async (tx) => {
        await lead(tx)
        leadReady()
        await commit
    }, TRANSACTION))
    const early = await Promise.race([ready.then(() => null), leadResult])
    if (early) throw new Error(`lead transaction failed before the interleaving: ${early.ok ? 'ok' : early.message}`)
    const followResult = settle(second.$transaction(async (tx) => {
        await follow(tx)
    }, TRANSACTION))
    try {
        await waitUntilBlocked(SECOND)
    } finally {
        commitLead()
    }
    return { lead: await leadResult, follow: await followResult }
}

/**
 * Runs `lead` in an open transaction on the first connection, then runs an
 * independent `attempt` while the leader is still uncommitted, then commits
 * the leader.
 */
async function whileUncommitted(
    lead: (tx: Db) => Promise<unknown>,
    attempt: () => Promise<Settled>,
): Promise<{ lead: Settled; attempt: Settled }> {
    let leadReady!: () => void
    let commitLead!: () => void
    const ready = new Promise<void>((resolve) => { leadReady = resolve })
    const commit = new Promise<void>((resolve) => { commitLead = resolve })
    const leadResult = settle(first.$transaction(async (tx) => {
        await lead(tx)
        leadReady()
        await commit
    }, TRANSACTION))
    const early = await Promise.race([ready.then(() => null), leadResult])
    if (early) throw new Error(`lead transaction failed before the attempt: ${early.ok ? 'ok' : early.message}`)
    let attempted: Settled
    try {
        attempted = await attempt()
    } finally {
        commitLead()
    }
    return { lead: await leadResult, attempt: attempted }
}

/**
 * Starts a transaction on the second connection, runs `newer` on the first
 * connection after that transaction has begun, then runs `action` inside the
 * older transaction and reports its outcome.
 */
async function fromOlderTransaction(newer: () => Promise<unknown>, action: (tx: Db) => Promise<unknown>): Promise<Settled> {
    const started = deferredSignal()
    const proceed = deferredSignal()
    const older = settle(second.$transaction(async (tx) => {
        await tx.$queryRawUnsafe('SELECT now() AS "startedAt"')
        started.resolve()
        await proceed.promise
        await action(tx)
    }, TRANSACTION))
    const early = await Promise.race([started.promise.then(() => null), older])
    if (early) throw new Error(`older transaction failed before the newer write: ${early.ok ? 'ok' : early.message}`)
    try {
        await pause(50)
        await newer()
    } finally {
        proceed.resolve()
    }
    return older
}

// ---------------------------------------------------------------------------
// Guard search_path pins

type GuardFunction =
    | 'whatsapp_account_guard'
    | 'whatsapp_account_key_guard'
    | 'whatsapp_account_key_set_guard'
    | 'whatsapp_transport_binding_guard'
    | 'whatsapp_capability_lease_guard'

const GUARD_FUNCTIONS: GuardFunction[] = [
    'whatsapp_account_guard',
    'whatsapp_account_key_guard',
    'whatsapp_account_key_set_guard',
    'whatsapp_transport_binding_guard',
    'whatsapp_capability_lease_guard',
]

async function keepSessionPathOn(db: Db, guard: GuardFunction): Promise<void> {
    switch (guard) {
        case 'whatsapp_account_guard':
            await db.$executeRawUnsafe('ALTER FUNCTION "whatsapp_account_guard"() SET search_path FROM CURRENT')
            return
        case 'whatsapp_account_key_guard':
            await db.$executeRawUnsafe('ALTER FUNCTION "whatsapp_account_key_guard"() SET search_path FROM CURRENT')
            return
        case 'whatsapp_account_key_set_guard':
            await db.$executeRawUnsafe('ALTER FUNCTION "whatsapp_account_key_set_guard"() SET search_path FROM CURRENT')
            return
        case 'whatsapp_transport_binding_guard':
            await db.$executeRawUnsafe('ALTER FUNCTION "whatsapp_transport_binding_guard"() SET search_path FROM CURRENT')
            return
        case 'whatsapp_capability_lease_guard':
            await db.$executeRawUnsafe('ALTER FUNCTION "whatsapp_capability_lease_guard"() SET search_path FROM CURRENT')
    }
}

/**
 * Pins guards to the search_path a migration session with that path would store:
 * the production form of prisma migrate deploy without a schema parameter, the
 * same with another existing schema ahead of the foundation schema, or the
 * foundation schema alone.
 */
async function pinGuards(guards: GuardFunction[], path: 'role_schema_first' | 'public_first' | 'own_schema'): Promise<void> {
    await first.$transaction(async (tx) => {
        if (path === 'role_schema_first') {
            await tx.$queryRawUnsafe("SELECT set_config('search_path', '\"$user\", ' || quote_ident(current_schema()), true) AS \"path\"")
        } else if (path === 'public_first') {
            await tx.$queryRawUnsafe("SELECT set_config('search_path', 'public, ' || quote_ident(current_schema()), true) AS \"path\"")
        } else {
            await tx.$queryRawUnsafe("SELECT set_config('search_path', quote_ident(current_schema()), true) AS \"path\"")
        }
        for (const guard of guards) await keepSessionPathOn(tx, guard)
    }, TRANSACTION)
}

proof('WhatsApp company-account foundation (isolated PostgreSQL)', () => {
    beforeAll(async () => {
        first = clientFor(FIRST)
        second = clientFor(SECOND)
        observer = clientFor('wa-account-proof-observer')
        await Promise.all([first.$connect(), second.$connect(), observer.$connect()])
        migrationPins = await observer.$queryRawUnsafe<Array<{ functionName: string; pinned: boolean }>>(
            `SELECT fn.proname AS "functionName",
                COALESCE(fn.proconfig = ARRAY['search_path=' || quote_ident(current_schema())], false) AS "pinned"
            FROM pg_proc fn
            JOIN pg_namespace ns ON ns.oid = fn.pronamespace
            WHERE ns.nspname = current_schema() AND fn.proname LIKE 'whatsapp%'
            ORDER BY fn.proname COLLATE "C"`,
        )
    })

    afterAll(async () => {
        await Promise.all([first?.$disconnect(), second?.$disconnect(), observer?.$disconnect()])
    })

    describe('account identity and provider keys', () => {
        it('creates an account only together with its complete PN and LID key set', async () => {
            const account = await createAccount()
            expect(await readAccount(account.accountId)).toMatchObject({ lifecycle: 'pending_approval', lifecycleVersion: 1 })
            expect(await countKeys(account.accountId)).toBe(2)

            // The key set is two different provider identifiers, never one value used twice.
            const single = newKeyValue()
            expect(refusal(await settle(createAccount(single, single)))).toContain('PN and LID of one account must be different provider values')

            for (const partial of [['whatsapp_pn_user'], ['whatsapp_lid_user'], []] as KeyKind[][]) {
                const accountId = newId('acc')
                const result = await settle(first.$transaction(async (tx) => {
                    await insertAccount(tx, accountId)
                    for (const kind of partial) await insertKey(tx, accountId, kind, newKeyValue())
                }, TRANSACTION))
                expect(refusal(result)).toContain('must be created with the complete provider key set')
                expect(await readAccount(accountId)).toBeUndefined()
                expect(await countKeys(accountId)).toBe(0)
            }
        })

        it('refuses activation from an incomplete key set', async () => {
            const accountId = newId('acc')
            const result = await settle(first.$transaction(async (tx) => {
                await insertAccount(tx, accountId)
                await insertKey(tx, accountId, 'whatsapp_pn_user', newKeyValue())
                await moveLifecycle(tx, accountId, 'active')
            }, TRANSACTION))
            expect(refusal(result)).toContain('activation requires the complete provider key set')
            expect(await readAccount(accountId)).toBeUndefined()
        })

        it('keeps provider keys exact, single-owner and permanent', async () => {
            const owner = await createAccount()

            const duplicate = await settle(createAccount(owner.pn))
            expect(refusal(duplicate)).toMatch(/23505|duplicate key/u)

            const secondPn = await settle(insertKey(first, owner.accountId, 'whatsapp_pn_user', newKeyValue()))
            expect(refusal(secondPn)).toMatch(/23505|duplicate key/u)

            const other = await createAccount()
            expect(refusal(await settle(first.$executeRawUnsafe(
                'UPDATE "WhatsAppAccountKey" SET "accountId" = $2 WHERE "keyKind" = \'whatsapp_pn_user\' AND "keyValue" = $1',
                owner.pn,
                other.accountId,
            )))).toContain('ownership is permanent and immutable')
            expect(refusal(await settle(first.$executeRawUnsafe(
                'UPDATE "WhatsAppAccountKey" SET "keyValue" = $2 WHERE "keyKind" = \'whatsapp_lid_user\' AND "keyValue" = $1',
                owner.lid,
                newKeyValue(),
            )))).toContain('ownership is permanent and immutable')
            expect(refusal(await settle(first.$executeRawUnsafe(
                'DELETE FROM "WhatsAppAccountKey" WHERE "accountId" = $1',
                owner.accountId,
            )))).toContain('ownership is permanent and immutable')
            expect(refusal(await settle(first.$executeRawUnsafe('TRUNCATE "WhatsAppAccountKey" CASCADE'))))
                .toContain('WhatsAppAccountKey is durable WhatsApp account history and cannot be truncated')
            expect(await countKeys(owner.accountId)).toBe(2)

            // Exact provider form: the database never normalizes a phone-like value.
            const digits = `7${newKeyValue().slice(0, 10)}`
            await createAccount(digits)
            const prefixed = await createAccount(`+${digits}`)
            const stored = await observer.$queryRawUnsafe<Array<{ keyValue: string }>>(
                'SELECT "keyValue" FROM "WhatsAppAccountKey" WHERE "accountId" = $1 AND "keyKind" = \'whatsapp_pn_user\'',
                prefixed.accountId,
            )
            expect(stored).toEqual([{ keyValue: `+${digits}` }])
        })

        it('keeps account identity immutable and account rows permanent', async () => {
            const account = await createAccount()
            expect(refusal(await settle(first.$executeRawUnsafe(
                'UPDATE "WhatsAppAccount" SET "accountId" = $2 WHERE "accountId" = $1',
                account.accountId,
                newId('acc'),
            )))).toContain('identity is immutable')
            expect(refusal(await settle(first.$executeRawUnsafe(
                'UPDATE "WhatsAppAccount" SET "accountKind" = \'whatsapp_business\' WHERE "accountId" = $1',
                account.accountId,
            )))).toContain('identity is immutable')
            expect(refusal(await settle(first.$executeRawUnsafe(
                'UPDATE "WhatsAppAccount" SET "createdAt" = "createdAt" - interval \'1 day\' WHERE "accountId" = $1',
                account.accountId,
            )))).toContain('identity is immutable')
            expect(refusal(await settle(first.$executeRawUnsafe(
                'DELETE FROM "WhatsAppAccount" WHERE "accountId" = $1',
                account.accountId,
            )))).toContain('permanent and cannot be removed')
            expect(refusal(await settle(first.$executeRawUnsafe('TRUNCATE "WhatsAppAccount" CASCADE'))))
                .toContain('WhatsAppAccount is durable WhatsApp account history and cannot be truncated')
            expect(await readAccount(account.accountId)).toMatchObject({ lifecycle: 'pending_approval' })
        })

        it('stamps lifecycle, key, binding and lease times from the database clock', async () => {
            const stale = '2001-01-01T00:00:00Z'
            const accountId = newId('acc')
            const pn = newKeyValue()
            const lid = newKeyValue()
            await first.$transaction(async (tx) => {
                await tx.$executeRawUnsafe(
                    `INSERT INTO "WhatsAppAccount"
                        ("accountId", "accountKind", "lifecycle", "lifecycleVersion", "lifecycleChangedAt",
                         "lifecycleChangedBy", "lifecycleReason", "createdAt")
                    VALUES ($1, 'whatsapp_user', 'pending_approval', 1, $2::timestamptz, 'system', 'observed', $2::timestamptz)`,
                    accountId,
                    stale,
                )
                await tx.$executeRawUnsafe(
                    `INSERT INTO "WhatsAppAccountKey" ("keyKind", "keyValue", "accountId", "firstAttestedAt")
                    VALUES ('whatsapp_pn_user', $2, $1, $4::timestamptz), ('whatsapp_lid_user', $3, $1, $4::timestamptz)`,
                    accountId,
                    pn,
                    lid,
                    stale,
                )
            }, TRANSACTION)
            const created = await readAccount(accountId)
            expect(Math.abs(secondsBetween(created!.dbNow, created!.createdAt))).toBeLessThan(60)
            expect(Math.abs(secondsBetween(created!.dbNow, created!.lifecycleChangedAt))).toBeLessThan(60)
            const keys = await observer.$queryRawUnsafe<Array<{ recent: boolean }>>(
                'SELECT "firstAttestedAt" > now() - interval \'1 minute\' AS "recent" FROM "WhatsAppAccountKey" WHERE "accountId" = $1',
                accountId,
            )
            expect(keys).toEqual([{ recent: true }, { recent: true }])

            expect(await first.$executeRawUnsafe(
                `UPDATE "WhatsAppAccount"
                SET "lifecycle" = 'active', "lifecycleVersion" = 2, "lifecycleChangedAt" = $2::timestamptz,
                    "lifecycleChangedBy" = 'operator-1', "lifecycleReason" = 'proof'
                WHERE "accountId" = $1`,
                accountId,
                stale,
            )).toBe(1)
            const activated = await readAccount(accountId)
            expect(Math.abs(secondsBetween(activated!.dbNow, activated!.lifecycleChangedAt))).toBeLessThan(60)

            // Binding openedAt and an operator confirmation recorded at insert.
            const bindingId = newId('bind')
            await first.$executeRawUnsafe(
                `INSERT INTO "WhatsAppTransportBinding" (
                    "bindingId", "transportKind", "transportRef", "transportGeneration", "accountId", "bindingSeq",
                    "trustState", "attestationOrigin", "claimedPnValue", "claimedLidValue", "attestingInstanceId",
                    "operatorConfirmedAt", "operatorConfirmedBy", "openedAt"
                ) VALUES ($1, 'whatsapp_web_slot', $2, 1, $3, 1, 'pending', 'transport_asserted', $4, $5, 'attester-1',
                    $6::timestamptz, 'operator-1', $6::timestamptz)`,
                bindingId,
                newId('slot'),
                accountId,
                pn,
                lid,
                stale,
            )
            const [binding] = await observer.$queryRawUnsafe<Array<{ openedRecent: boolean; confirmedRecent: boolean }>>(
                `SELECT "openedAt" > now() - interval '1 minute' AS "openedRecent",
                    "operatorConfirmedAt" > now() - interval '1 minute' AS "confirmedRecent"
                FROM "WhatsAppTransportBinding" WHERE "bindingId" = $1`,
                bindingId,
            )
            expect(binding).toEqual({ openedRecent: true, confirmedRecent: true })

            // lastAttestedAt at insert, and operatorConfirmedAt and closedAt on update.
            const futureStamp = newId('bind')
            await first.$executeRawUnsafe(
                `INSERT INTO "WhatsAppTransportBinding" (
                    "bindingId", "transportKind", "transportRef", "transportGeneration", "accountId", "bindingSeq",
                    "trustState", "attestationOrigin", "attestedPnValue", "attestedLidValue", "attestingInstanceId",
                    "attestedUntil", "lastAttestedAt"
                ) VALUES ($1, 'whatsapp_web_slot', $2, 1, $3, 1, 'verified', 'provider_verified', $4, $5, 'attester-1',
                    now() + interval '30 minutes', now() + interval '55 minutes')`,
                futureStamp,
                newId('slot'),
                accountId,
                pn,
                lid,
            )
            const confirmLater = await openAssertedBinding(first, accountId, pn, lid)
            expect(await first.$executeRawUnsafe(
                `UPDATE "WhatsAppTransportBinding"
                SET "operatorConfirmedAt" = $2::timestamptz, "operatorConfirmedBy" = 'operator-1'
                WHERE "bindingId" = $1`,
                confirmLater.bindingId,
                stale,
            )).toBe(1)
            expect(await first.$executeRawUnsafe(
                `UPDATE "WhatsAppTransportBinding"
                SET "trustState" = 'closed', "closeReason" = 'superseded', "closedAt" = $2::timestamptz
                WHERE "bindingId" = $1`,
                confirmLater.bindingId,
                stale,
            )).toBe(1)
            const stamps = await observer.$queryRawUnsafe<Array<{ attestedRecent: boolean; confirmedRecent: boolean; closedRecent: boolean }>>(
                `SELECT
                    (SELECT "lastAttestedAt" BETWEEN now() - interval '1 minute' AND now() + interval '1 minute'
                        FROM "WhatsAppTransportBinding" WHERE "bindingId" = $1) AS "attestedRecent",
                    (SELECT "operatorConfirmedAt" > now() - interval '1 minute'
                        FROM "WhatsAppTransportBinding" WHERE "bindingId" = $2) AS "confirmedRecent",
                    (SELECT "closedAt" > now() - interval '1 minute'
                        FROM "WhatsAppTransportBinding" WHERE "bindingId" = $2) AS "closedRecent"`,
                futureStamp,
                confirmLater.bindingId,
            )
            expect(stamps).toEqual([{ attestedRecent: true, confirmedRecent: true, closedRecent: true }])

            // A first lease acquisition ignores a caller-supplied quarantine and release time.
            const verified = await openBinding(first, { accountId, pn, lid })
            expect(await first.$executeRawUnsafe(
                `INSERT INTO "WhatsAppCapabilityLease"
                    ("accountId", "capability", "epoch", "version", "holderBindingId", "holderInstanceId", "state",
                     "heartbeatAt", "leaseUntil", "fenceUntil", "lastReleasedAt")
                VALUES ($1, 'inbound', 1, 1, $2, 'holder-1', 'held', $3::timestamptz, now() + interval '1 minute',
                    now() + interval '1 hour', $3::timestamptz)`,
                accountId,
                verified.bindingId,
                stale,
            )).toBe(1)
            const lease = await readLease(accountId, 'inbound')
            expect(Math.abs(secondsBetween(lease.dbNow, lease.heartbeatAt))).toBeLessThan(60)
            expect(lease.fenceUntil.getTime()).toBe(lease.heartbeatAt.getTime())
            expect(lease.lastReleasedAt).toBeNull()
        })
        it('refuses values outside each column domain', async () => {
            const account = await activeAccount()
            const createWith = (keyKind: string, pnValue: string) => settle(first.$transaction(async (tx) => {
                const accountId = newId('acc')
                await insertAccount(tx, accountId)
                await tx.$executeRawUnsafe(
                    'INSERT INTO "WhatsAppAccountKey" ("keyKind", "keyValue", "accountId") VALUES ($1, $2, $3)',
                    keyKind,
                    pnValue,
                    accountId,
                )
                await insertKey(tx, accountId, 'whatsapp_lid_user', newKeyValue())
            }, TRANSACTION))
            expect(refusal(await createWith('whatsapp_pn_user', ` ${newKeyValue()}`))).toContain('WhatsAppAccountKey_value_check')
            expect(refusal(await createWith('whatsapp_pn_user', `${newKeyValue()}\n`))).toContain('WhatsAppAccountKey_value_check')
            expect(refusal(await createWith('whatsapp_email_user', newKeyValue()))).toContain('WhatsAppAccountKey_value_check')

            expect(refusal(await settle(first.$executeRawUnsafe(
                `INSERT INTO "WhatsAppAccount"
                    ("accountId", "accountKind", "lifecycle", "lifecycleVersion", "lifecycleChangedBy", "lifecycleReason")
                VALUES ($1, 'whatsapp_business', 'pending_approval', 1, 'system', 'observed')`,
                newId('acc'),
            )))).toContain('WhatsAppAccount_identity_check')
            expect(refusal(await settle(first.$executeRawUnsafe(
                `INSERT INTO "WhatsAppAccount"
                    ("accountId", "accountKind", "lifecycle", "lifecycleVersion", "lifecycleChangedBy", "lifecycleReason")
                VALUES ($1, 'whatsapp_user', 'pending_approval', 2, 'system', 'observed')`,
                newId('acc'),
            )))).toContain('starts as pending_approval at lifecycle version 1')

            expect(refusal(await settle(first.$executeRawUnsafe(
                `INSERT INTO "WhatsAppTransportBinding" (
                    "bindingId", "transportKind", "transportRef", "transportGeneration", "accountId", "bindingSeq",
                    "trustState", "attestationOrigin", "attestingInstanceId"
                ) VALUES ($1, 'telegram_session', $2, 1, $3, 1, 'pending', 'provider_verified', 'attester-1')`,
                newId('bind'),
                newId('slot'),
                account.accountId,
            )))).toContain('WhatsAppTransportBinding_shape_check')
            // Every identifier and actor column refuses an empty value, surrounding spaces and a control
            // character, each of which only one part of its format check catches.
            const formatPending = await openPendingBinding(first, { accountId: account.accountId })
            const formatReady = await leaseReadyAccount()
            const formatCases: Array<[string, string, (value: string) => Promise<unknown>]> = [
                ['accountId', 'WhatsAppAccount_identity_check', (value) => first.$executeRawUnsafe(
                    `INSERT INTO "WhatsAppAccount"
                        ("accountId", "accountKind", "lifecycle", "lifecycleVersion", "lifecycleChangedBy", "lifecycleReason")
                    VALUES ($1, 'whatsapp_user', 'pending_approval', 1, 'system', 'observed')`,
                    value,
                )],
                ['lifecycleChangedBy', 'WhatsAppAccount_lifecycle_check', (value) => first.$executeRawUnsafe(
                    `INSERT INTO "WhatsAppAccount"
                        ("accountId", "accountKind", "lifecycle", "lifecycleVersion", "lifecycleChangedBy", "lifecycleReason")
                    VALUES ($1, 'whatsapp_user', 'pending_approval', 1, $2, 'observed')`,
                    newId('acc'),
                    value,
                )],
                ['lifecycleReason', 'WhatsAppAccount_lifecycle_check', (value) => first.$executeRawUnsafe(
                    `INSERT INTO "WhatsAppAccount"
                        ("accountId", "accountKind", "lifecycle", "lifecycleVersion", "lifecycleChangedBy", "lifecycleReason")
                    VALUES ($1, 'whatsapp_user', 'pending_approval', 1, 'system', $2)`,
                    newId('acc'),
                    value,
                )],
                ['keyValue', 'WhatsAppAccountKey_value_check', (value) => first.$transaction(async (tx) => {
                    const accountId = newId('acc')
                    await insertAccount(tx, accountId)
                    await insertKey(tx, accountId, 'whatsapp_pn_user', value)
                }, TRANSACTION)],
                ['bindingId', 'WhatsAppTransportBinding_shape_check', (value) => first.$executeRawUnsafe(
                    `INSERT INTO "WhatsAppTransportBinding" (
                        "bindingId", "transportKind", "transportRef", "transportGeneration", "accountId", "bindingSeq",
                        "trustState", "attestationOrigin", "attestingInstanceId"
                    ) VALUES ($1, 'whatsapp_web_slot', $2, 1, $3, 1, 'pending', 'provider_verified', 'attester-1')`,
                    value,
                    newId('slot'),
                    account.accountId,
                )],
                ['transportRef', 'WhatsAppTransportBinding_shape_check', (value) => first.$executeRawUnsafe(
                    `INSERT INTO "WhatsAppTransportBinding" (
                        "bindingId", "transportKind", "transportRef", "transportGeneration", "accountId", "bindingSeq",
                        "trustState", "attestationOrigin", "attestingInstanceId"
                    ) VALUES ($1, 'whatsapp_web_slot', $2, 1, $3, 1, 'pending', 'provider_verified', 'attester-1')`,
                    newId('bind'),
                    value,
                    account.accountId,
                )],
                ['attestingInstanceId', 'WhatsAppTransportBinding_shape_check', (value) => first.$executeRawUnsafe(
                    `INSERT INTO "WhatsAppTransportBinding" (
                        "bindingId", "transportKind", "transportRef", "transportGeneration", "accountId", "bindingSeq",
                        "trustState", "attestationOrigin", "attestingInstanceId"
                    ) VALUES ($1, 'whatsapp_web_slot', $2, 1, $3, 1, 'pending', 'provider_verified', $4)`,
                    newId('bind'),
                    newId('slot'),
                    account.accountId,
                    value,
                )],
                ['claimedPnValue', CLAIMED_KEY_SET, (value) => openAssertedBinding(first, account.accountId, value, null)],
                ['claimedLidValue', CLAIMED_KEY_SET, (value) => openAssertedBinding(first, account.accountId, null, value)],
                ['operatorConfirmedBy', 'WhatsAppTransportBinding_attestation_check', (value) => first.$executeRawUnsafe(
                    'UPDATE "WhatsAppTransportBinding" SET "operatorConfirmedAt" = now(), "operatorConfirmedBy" = $2 WHERE "bindingId" = $1',
                    formatPending.bindingId,
                    value,
                )],
                ['holderInstanceId', 'WhatsAppCapabilityLease_shape_check', (value) => acquire(first, {
                    accountId: formatReady.accountId,
                    capability: 'inbound',
                    bindingId: formatReady.primary.bindingId,
                    instanceId: value,
                    seconds: 30,
                })],
            ]
            for (const [column, constraint, write] of formatCases) {
                for (const value of ['', ' padded', 'control\n']) {
                    const result = await settle(write(value))
                    const outcome = result.ok ? 'accepted' : result.message.includes(constraint) ? constraint : result.message
                    expect({ column, value, outcome }).toEqual({ column, value, outcome: constraint })
                }
            }
            expect(await readLease(formatReady.accountId, 'inbound')).toBeUndefined()
            expect(refusal(await settle(first.$executeRawUnsafe(
                `INSERT INTO "WhatsAppTransportBinding" (
                    "bindingId", "transportKind", "transportRef", "transportGeneration", "accountId", "bindingSeq",
                    "trustState", "attestationOrigin", "attestingInstanceId"
                ) VALUES ($1, 'whatsapp_web_slot', $2, 1, $3, 1, 'pending', 'transport_assertd', 'attester-1')`,
                newId('bind'),
                newId('slot'),
                account.accountId,
            )))).toContain('WhatsAppTransportBinding_shape_check')

            // An attestation window that ends before, or exactly when, it starts.
            expect(refusal(await settle(first.$executeRawUnsafe(
                `INSERT INTO "WhatsAppTransportBinding" (
                    "bindingId", "transportKind", "transportRef", "transportGeneration", "accountId", "bindingSeq",
                    "trustState", "attestationOrigin", "attestedPnValue", "attestedLidValue", "attestingInstanceId", "attestedUntil"
                ) VALUES ($1, 'whatsapp_web_slot', $2, 1, $3, 1, 'pending', 'provider_verified', $4, $5, 'attester-1',
                    now() - interval '1 minute')`,
                newId('bind'),
                newId('slot'),
                account.accountId,
                account.pn,
                account.lid,
            )))).toContain('WhatsAppTransportBinding_attestation_check')
            for (const seconds of [-60, 0]) {
                expect(refusal(await settle(attestBinding(first, formatPending.bindingId, account.pn, account.lid, seconds))))
                    .toContain('WhatsAppTransportBinding_attestation_check')
            }
            for (const [bindingSeq, generation] of [[1, 0], [0, 1], [1, -5]] as const) {
                expect(refusal(await settle(openPendingBinding(first, { accountId: account.accountId, bindingSeq, generation }))))
                    .toContain('bindingSeq and transportGeneration must be at least 1')
            }
            const pending = await openPendingBinding(first, { accountId: account.accountId })
            expect(refusal(await settle(closeBinding(first, pending.bindingId, 'closed', 'operator_was_bored')))).toContain('WhatsAppTransportBinding_trust_check')
            expect(refusal(await settle(first.$executeRawUnsafe(
                'UPDATE "WhatsAppTransportBinding" SET "operatorConfirmedBy" = \'operator-1\' WHERE "bindingId" = $1',
                pending.bindingId,
            )))).toContain('WhatsAppTransportBinding_attestation_check')

            const ready = await leaseReadyAccount()
            for (const [version, state] of [[2, 'held'], [1, 'released']] as const) {
                expect(refusal(await settle(first.$executeRawUnsafe(
                    `INSERT INTO "WhatsAppCapabilityLease"
                        ("accountId", "capability", "epoch", "version", "holderBindingId", "holderInstanceId", "state", "leaseUntil")
                    VALUES ($1, 'inbound', 1, $2::bigint, $3, 'holder-1', $4, now() + interval '30 seconds')`,
                    ready.accountId,
                    version,
                    ready.primary.bindingId,
                    state,
                )))).toContain('first acquired as held at epoch 1 and version 1')
            }
            expect(refusal(await settle(acquire(first, { accountId: ready.accountId, capability: 'inbound', bindingId: ready.primary.bindingId, instanceId: 'holder-1', seconds: -1 }))))
                .toContain('leaseUntil must be in the future')
            await acquire(first, { accountId: ready.accountId, capability: 'history_import', bindingId: ready.primary.bindingId, instanceId: 'holder-1', seconds: 30 })
            expect(refusal(await settle(first.$executeRawUnsafe(
                `UPDATE "WhatsAppCapabilityLease" SET "state" = 'paused', "version" = "version" + 1
                WHERE "accountId" = $1 AND "capability" = 'history_import'`,
                ready.accountId,
            )))).toContain('WhatsAppCapabilityLease_shape_check')
            await acquire(first, { accountId: ready.accountId, capability: 'inbound', bindingId: ready.primary.bindingId, instanceId: 'holder-1', seconds: 1 })
            await pause(1_200)
            expect(refusal(await settle(first.$executeRawUnsafe(
                `UPDATE "WhatsAppCapabilityLease"
                SET "epoch" = "epoch" + 1, "version" = "version" + 1, "holderBindingId" = $2, "holderInstanceId" = 'holder-2', "state" = 'released'
                WHERE "accountId" = $1 AND "capability" = 'inbound'`,
                ready.accountId,
                ready.secondary.bindingId,
            )))).toContain('new epoch must be held')
        })

    })

    describe('account lifecycle', () => {
        it('follows the approved transitions with retired terminal', async () => {
            const account = await createAccount()
            const move = (lifecycle: string) => settle(moveLifecycle(first, account.accountId, lifecycle))

            expect(refusal(await move('retired'))).toContain('from pending_approval to retired is not permitted')
            expect(refusal(await move('disabled'))).toContain('from pending_approval to disabled is not permitted')
            expect(await move('rejected')).toEqual({ ok: true })
            expect(refusal(await move('active'))).toContain('from rejected to active is not permitted')
            expect(await move('pending_approval')).toEqual({ ok: true })
            expect(await move('active')).toEqual({ ok: true })
            expect(refusal(await move('pending_approval'))).toContain('from active to pending_approval is not permitted')
            expect(refusal(await move('retired'))).toContain('from active to retired is not permitted')
            // Temporary shutdown is DISABLED, and it may repeat.
            for (let cycle = 0; cycle < 2; cycle += 1) {
                expect(await move('disabled')).toEqual({ ok: true })
                expect(await move('active')).toEqual({ ok: true })
            }
            expect(await move('disabled')).toEqual({ ok: true })
            expect(await move('retired')).toEqual({ ok: true })
            for (const target of ['active', 'disabled', 'pending_approval', 'rejected']) {
                expect(refusal(await move(target))).toContain(`from retired to ${target} is not permitted`)
            }
            expect(await readAccount(account.accountId)).toMatchObject({ lifecycle: 'retired', lifecycleVersion: 10 })
        })

        it('refuses a lifecycle version skip and an account created in any other lifecycle', async () => {
            const account = await createAccount()
            expect(refusal(await settle(first.$executeRawUnsafe(
                `UPDATE "WhatsAppAccount" SET "lifecycle" = 'active', "lifecycleVersion" = "lifecycleVersion" + 2
                WHERE "accountId" = $1`,
                account.accountId,
            )))).toContain('advance by exactly one')
            expect(refusal(await settle(first.$executeRawUnsafe(
                `UPDATE "WhatsAppAccount" SET "lifecycle" = 'active'
                WHERE "accountId" = $1`,
                account.accountId,
            )))).toContain('advance by exactly one')
            expect(await moveLifecycle(first, account.accountId, 'active')).toBe(1)
            expect(refusal(await settle(first.$executeRawUnsafe(
                `UPDATE "WhatsAppAccount" SET "lifecycle" = 'disabled', "lifecycleVersion" = "lifecycleVersion" - 1
                WHERE "accountId" = $1`,
                account.accountId,
            )))).toContain('advance by exactly one')

            const accountId = newId('acc')
            expect(refusal(await settle(first.$executeRawUnsafe(
                `INSERT INTO "WhatsAppAccount"
                    ("accountId", "accountKind", "lifecycle", "lifecycleVersion", "lifecycleChangedBy", "lifecycleReason")
                VALUES ($1, 'whatsapp_user', 'active', 1, 'system', 'observed')`,
                accountId,
            )))).toContain('starts as pending_approval')
        })

        it('disables and re-enables without touching identity, keys or bindings, and retires only with every binding closed', async () => {
            const account = await activeAccount()
            const binding = await openBinding(first, { ...account })

            expect(await moveLifecycle(first, account.accountId, 'disabled')).toBe(1)
            expect(await countKeys(account.accountId)).toBe(2)
            expect(await readBinding(binding.bindingId)).toMatchObject({ accountId: account.accountId, trustState: 'verified', closedAt: null })
            expect(await moveLifecycle(first, account.accountId, 'active')).toBe(1)
            expect(await moveLifecycle(first, account.accountId, 'disabled')).toBe(1)

            expect(refusal(await settle(moveLifecycle(first, account.accountId, 'retired'))))
                .toContain('cannot retire while a transport binding is open')
            expect(await closeBinding(first, binding.bindingId, 'closed', 'transport_retired')).toBe(1)
            expect(await moveLifecycle(first, account.accountId, 'retired')).toBe(1)

            // Retired provider keys stay reserved and the history stays in place.
            expect(refusal(await settle(createAccount(account.pn)))).toMatch(/23505|duplicate key/u)
            expect(refusal(await settle(createAccount(newKeyValue(), account.lid)))).toMatch(/23505|duplicate key/u)
            expect(refusal(await settle(openPendingBinding(first, { accountId: account.accountId }))))
                .toContain('cannot open for a missing or retired account')
            expect(await countKeys(account.accountId)).toBe(2)
            expect(await readBinding(binding.bindingId)).toMatchObject({ accountId: account.accountId, trustState: 'closed' })
        })
    })

    describe('transport bindings', () => {
        it('allows several transports per account but one open binding per transport', async () => {
            const account = await activeAccount()
            const primary = await openBinding(first, { ...account })
            await openBinding(first, { ...account })

            const duplicateOpen = await settle(openBinding(first, {
                ...account,
                transportRef: primary.transportRef,
                bindingSeq: 2,
                generation: 2,
            }))
            expect(refusal(duplicateOpen)).toContain('cannot open while another binding on the transport is open')
        })

        it('keeps binding identity, transport, generation and account immutable and rows permanent', async () => {
            const account = await activeAccount()
            const other = await activeAccount()
            const binding = await openBinding(first, { ...account })
            const immutable = [
                ['UPDATE "WhatsAppTransportBinding" SET "accountId" = $2 WHERE "bindingId" = $1', other.accountId],
                ['UPDATE "WhatsAppTransportBinding" SET "transportRef" = $2 WHERE "bindingId" = $1', newId('slot')],
                ['UPDATE "WhatsAppTransportBinding" SET "transportGeneration" = "transportGeneration" + $2::bigint WHERE "bindingId" = $1', 1],
                ['UPDATE "WhatsAppTransportBinding" SET "bindingSeq" = "bindingSeq" + $2::int WHERE "bindingId" = $1', 1],
                ['UPDATE "WhatsAppTransportBinding" SET "attestationOrigin" = $2 WHERE "bindingId" = $1', 'transport_asserted'],
                ['UPDATE "WhatsAppTransportBinding" SET "bindingId" = $2 WHERE "bindingId" = $1', newId('bind')],
                ['UPDATE "WhatsAppTransportBinding" SET "openedAt" = "openedAt" - make_interval(secs => $2::double precision) WHERE "bindingId" = $1', 60],
            ] as const
            for (const [statement, value] of immutable) {
                expect(refusal(await settle(first.$executeRawUnsafe(statement, binding.bindingId, value))))
                    .toContain('identity, transport, generation and account are immutable')
            }
            expect(refusal(await settle(first.$executeRawUnsafe(
                'DELETE FROM "WhatsAppTransportBinding" WHERE "bindingId" = $1',
                binding.bindingId,
            )))).toContain('durable history and cannot be removed')
            expect(refusal(await settle(first.$executeRawUnsafe('TRUNCATE "WhatsAppTransportBinding" CASCADE'))))
                .toContain('WhatsAppTransportBinding is durable WhatsApp account history and cannot be truncated')
            expect(await readBinding(binding.bindingId)).toMatchObject({ accountId: account.accountId, trustState: 'verified', generation: 1 })
        })

        it('records a re-pair to a different account as new history without redefining the old identity', async () => {
            const original = await activeAccount()
            const replacement = await activeAccount()
            const old = await openBinding(first, { ...original })

            expect(await closeBinding(first, old.bindingId, 'mismatched', 'account_changed')).toBe(1)
            const repaired = await openBinding(first, {
                ...replacement,
                transportRef: old.transportRef,
                bindingSeq: 2,
                generation: 2,
            })

            expect(await readBinding(old.bindingId)).toMatchObject({
                accountId: original.accountId,
                trustState: 'mismatched',
                closeReason: 'account_changed',
                generation: 1,
                attestedPnValue: original.pn,
                attestedLidValue: original.lid,
            })
            expect(await readBinding(repaired.bindingId)).toMatchObject({
                accountId: replacement.accountId,
                generation: 2,
                attestedPnValue: replacement.pn,
                attestedLidValue: replacement.lid,
            })
            expect(refusal(await settle(verifyBinding(first, old.bindingId, original.pn, original.lid))))
                .toContain('closed and frozen')

            expect(await closeBinding(first, repaired.bindingId, 'closed', 'logged_out')).toBe(1)
            const slot = { accountId: original.accountId, transportRef: old.transportRef }
            expect(refusal(await settle(openPendingBinding(first, { ...slot, bindingSeq: 4, generation: 3 }))))
                .toContain('bindingSeq must be contiguous')
            expect(refusal(await settle(openPendingBinding(first, { ...slot, bindingSeq: 2, generation: 3 }))))
                .toContain(HISTORY_MUST_ADVANCE)
            expect(await openPendingBinding(first, { ...slot, bindingSeq: 3, generation: 3 }))
                .toMatchObject({ transportRef: old.transportRef })
            expect(await readSlotHistory(old.transportRef)).toEqual([
                { bindingSeq: 1, generation: 1 },
                { bindingSeq: 2, generation: 2 },
                { bindingSeq: 3, generation: 3 },
            ])
        })

        it('gives every new binding on a slot a strictly newer transport generation', async () => {
            const account = await activeAccount()
            const seventh = await openBinding(first, { ...account, generation: 7 })
            expect(await closeBinding(first, seventh.bindingId, 'closed', 'logged_out')).toBe(1)
            const next = { accountId: account.accountId, transportRef: seventh.transportRef, bindingSeq: 2 }

            // The same generation is not a new pairing, and an older one is a regression.
            expect(refusal(await settle(openPendingBinding(first, { ...next, generation: 7 })))).toContain(HISTORY_MUST_ADVANCE)
            expect(refusal(await settle(openPendingBinding(first, { ...next, generation: 6 })))).toContain(HISTORY_MUST_ADVANCE)
            // The same holds when the slot is re-paired to a different account.
            const other = await activeAccount()
            expect(refusal(await settle(openPendingBinding(first, { ...next, accountId: other.accountId, generation: 7 })))).toContain(HISTORY_MUST_ADVANCE)
            expect(refusal(await settle(openPendingBinding(first, { ...next, accountId: other.accountId, generation: 6 })))).toContain(HISTORY_MUST_ADVANCE)
            const eighth = await openPendingBinding(first, { ...next, generation: 8 })

            expect(await readBinding(eighth.bindingId)).toMatchObject({ generation: 8, trustState: 'pending' })
            expect(await readBinding(seventh.bindingId)).toMatchObject({ generation: 7, trustState: 'closed' })
            expect(await readSlotHistory(seventh.transportRef)).toEqual([
                { bindingSeq: 1, generation: 7 },
                { bindingSeq: 2, generation: 8 },
            ])
        })

        it('verifies a binding only with the complete PN and LID key set of its own account', async () => {
            const account = await activeAccount()
            const stranger = await activeAccount()
            const verifyPending = async (pn: string | null, lid: string | null): Promise<Settled> => {
                const pending = await openPendingBinding(first, { accountId: account.accountId })
                return settle(verifyBinding(first, pending.bindingId, pn, lid))
            }

            // 1. correct PN with a wrong LID
            expect(refusal(await verifyPending(account.pn, newKeyValue()))).toContain(LID_KEY_PROOF)
            // 2. a wrong PN with the correct LID
            expect(refusal(await verifyPending(newKeyValue(), account.lid))).toContain(PN_KEY_PROOF)
            // 3. PN only. PostgreSQL checks CHECK constraints in name order, so the pair check
            // refuses a lone half before the verified key-set check is reached.
            expect(refusal(await verifyPending(account.pn, null))).toContain(KEY_PAIR)
            // 4. LID only
            expect(refusal(await verifyPending(null, account.lid))).toContain(KEY_PAIR)
            expect(refusal(await verifyPending(null, null))).toContain(VERIFIED_KEY_SET)
            // 6. keys that resolve to different accounts
            expect(refusal(await verifyPending(account.pn, stranger.lid))).toContain(LID_KEY_PROOF)
            expect(refusal(await verifyPending(stranger.pn, account.lid))).toContain(PN_KEY_PROOF)
            // The kinds are not interchangeable: each value is proven against its own kind.
            expect(refusal(await verifyPending(account.lid, account.pn))).toMatch(new RegExp(`${PN_KEY_PROOF}|${LID_KEY_PROOF}`, 'u'))
            // 5. correct PN and correct LID
            expect(await verifyPending(account.pn, account.lid)).toEqual({ ok: true })

            // The insert path follows the same rules.
            expect(refusal(await settle(openBinding(first, { ...account, lid: stranger.lid })))).toContain(LID_KEY_PROOF)
            expect(refusal(await settle(openBinding(first, { ...account, pn: stranger.pn })))).toContain(PN_KEY_PROOF)
            expect(refusal(await settle(openBinding(first, { ...account, lid: null })))).toContain(KEY_PAIR)
            expect(refusal(await settle(openBinding(first, { ...account, pn: null })))).toContain(KEY_PAIR)
            expect(refusal(await settle(openBinding(first, { ...account, pn: null, lid: null })))).toContain(VERIFIED_KEY_SET)
            expect(refusal(await settle(openBinding(first, { ...stranger, pn: account.pn })))).toContain(PN_KEY_PROOF)
        })

        it('never verifies the old account for a re-pair that presents the same PN with a different LID', async () => {
            // Old account PN=A, LID=X. The slot re-pairs and presents PN=A, LID=Y.
            const old = await activeAccount()
            const presentedLid = newKeyValue()
            const binding = await openPendingBinding(first, { accountId: old.accountId })

            expect(refusal(await settle(verifyBinding(first, binding.bindingId, old.pn, presentedLid)))).toContain(LID_KEY_PROOF)
            expect(refusal(await settle(verifyBinding(first, binding.bindingId, old.pn, null)))).toContain(KEY_PAIR)
            expect(refusal(await settle(openBinding(first, { accountId: old.accountId, pn: old.pn, lid: presentedLid }))))
                .toContain(LID_KEY_PROOF)
            // Nor can the presented identity quietly claim PN=A: that key already has an owner.
            expect(refusal(await settle(createAccount(old.pn, presentedLid)))).toMatch(/23505|duplicate key/u)
            expect(await readBinding(binding.bindingId)).toMatchObject({ trustState: 'pending', attestedPnValue: null, attestedLidValue: null })
        })

        it('keeps the provider key kinds fixed so one value cannot stand in for the other kind', async () => {
            const account = await activeAccount()
            expect(refusal(await settle(first.$executeRawUnsafe(
                `INSERT INTO "WhatsAppTransportBinding" (
                    "bindingId", "transportKind", "transportRef", "transportGeneration", "accountId", "bindingSeq",
                    "trustState", "attestationOrigin", "attestedPnKind", "attestedPnValue", "attestedLidValue",
                    "attestingInstanceId", "attestedUntil"
                ) VALUES ($1, 'whatsapp_web_slot', $2, 1, $3, 1, 'verified', 'provider_verified', 'whatsapp_lid_user', $4, $4,
                    'attester-1', now() + interval '10 minutes')`,
                newId('bind'),
                newId('slot'),
                account.accountId,
                account.lid,
            )))).toContain(FIXED_KEY_KINDS)
            expect(refusal(await settle(first.$executeRawUnsafe(
                `INSERT INTO "WhatsAppTransportBinding" (
                    "bindingId", "transportKind", "transportRef", "transportGeneration", "accountId", "bindingSeq",
                    "trustState", "attestationOrigin", "attestedPnValue", "attestedLidKind", "attestedLidValue",
                    "attestingInstanceId", "attestedUntil"
                ) VALUES ($1, 'whatsapp_web_slot', $2, 1, $3, 1, 'verified', 'provider_verified', $4, 'whatsapp_pn_user', $4,
                    'attester-1', now() + interval '10 minutes')`,
                newId('bind'),
                newId('slot'),
                account.accountId,
                account.pn,
            )))).toContain(FIXED_KEY_KINDS)

            // A kind can never be absent: a NULL kind would skip that half of the key proof.
            const stranger = await activeAccount()
            expect(refusal(await settle(first.$executeRawUnsafe(
                `INSERT INTO "WhatsAppTransportBinding" (
                    "bindingId", "transportKind", "transportRef", "transportGeneration", "accountId", "bindingSeq",
                    "trustState", "attestationOrigin", "attestedPnKind", "attestedPnValue", "attestedLidValue",
                    "attestingInstanceId", "attestedUntil"
                ) VALUES ($1, 'whatsapp_web_slot', $2, 1, $3, 1, 'verified', 'provider_verified', NULL, $4, $5,
                    'attester-1', now() + interval '10 minutes')`,
                newId('bind'),
                newId('slot'),
                account.accountId,
                stranger.pn,
                account.lid,
            )))).toMatch(/23502|null value in column "attestedPnKind"|attestedPnKind/u)
            expect(refusal(await settle(first.$executeRawUnsafe(
                `INSERT INTO "WhatsAppTransportBinding" (
                    "bindingId", "transportKind", "transportRef", "transportGeneration", "accountId", "bindingSeq",
                    "trustState", "attestationOrigin", "attestedPnValue", "attestedLidKind", "attestedLidValue",
                    "attestingInstanceId", "attestedUntil"
                ) VALUES ($1, 'whatsapp_web_slot', $2, 1, $3, 1, 'verified', 'provider_verified', $4, NULL, $5,
                    'attester-1', now() + interval '10 minutes')`,
                newId('bind'),
                newId('slot'),
                account.accountId,
                account.pn,
                stranger.lid,
            )))).toMatch(/23502|null value in column "attestedLidKind"|attestedLidKind/u)
        })

        it('records attested provider values only as a complete pair and holds partial evidence as a pending claim', async () => {
            const account = await activeAccount()

            // A lone PN or LID is never attested evidence.
            const pending = await openPendingBinding(first, { accountId: account.accountId })
            expect(refusal(await settle(attestBinding(first, pending.bindingId, account.pn, null)))).toContain(KEY_PAIR)
            expect(refusal(await settle(attestBinding(first, pending.bindingId, null, account.lid)))).toContain(KEY_PAIR)
            expect(await readBinding(pending.bindingId)).toMatchObject({ trustState: 'pending', attestedPnValue: null, attestedLidValue: null })

            // It may be kept as what the transport presented while the binding stays pending.
            expect(await setClaimedPn(first, pending.bindingId, account.pn)).toBe(1)
            expect(await readBinding(pending.bindingId)).toMatchObject({ trustState: 'pending', attestedPnValue: null })

            // A complete pair is attested at once, and it is then immutable.
            expect(await attestBinding(first, pending.bindingId, account.pn, account.lid)).toBe(1)
            expect(await readBinding(pending.bindingId)).toMatchObject({ trustState: 'pending', attestedPnValue: account.pn, attestedLidValue: account.lid })
            expect(await verifyBinding(first, pending.bindingId, account.pn, account.lid)).toBe(1)

            const verified = await openBinding(first, { ...account })
            expect(refusal(await settle(verifyBinding(first, verified.bindingId, null, account.lid))))
                .toContain('attested provider key set is immutable once recorded')
            expect(refusal(await settle(verifyBinding(first, verified.bindingId, account.pn, null))))
                .toContain('attested provider key set is immutable once recorded')
            expect(await readBinding(verified.bindingId)).toMatchObject({ attestedPnValue: account.pn, attestedLidValue: account.lid })

            // Attested values never exist without the attestation window that recorded them.
            expect(refusal(await settle(first.$executeRawUnsafe(
                `INSERT INTO "WhatsAppTransportBinding" (
                    "bindingId", "transportKind", "transportRef", "transportGeneration", "accountId", "bindingSeq",
                    "trustState", "attestationOrigin", "attestedPnValue", "attestedLidValue", "attestingInstanceId"
                ) VALUES ($1, 'whatsapp_web_slot', $2, 1, $3, 1, 'pending', 'provider_verified', $4, $5, 'attester-1')`,
                newId('bind'),
                newId('slot'),
                account.accountId,
                account.pn,
                account.lid,
            )))).toContain(KEY_PAIR)
        })

        it('becomes verified only in an update that records a fresh attestation of the complete key set', async () => {
            const account = await activeAccount()
            const attestationOnly = 'attestation fields change only with a new attestation'
            const freshAttestation = 'becomes verified only with a fresh attestation recorded by the same update'

            const pending = await openPendingBinding(first, { accountId: account.accountId })
            expect(refusal(await settle(first.$executeRawUnsafe(
                `UPDATE "WhatsAppTransportBinding"
                SET "trustState" = 'verified', "attestedPnValue" = $2, "attestedLidValue" = $3
                WHERE "bindingId" = $1`,
                pending.bindingId,
                account.pn,
                account.lid,
            )))).toContain(attestationOnly)
            expect(await verifyBinding(first, pending.bindingId, account.pn, account.lid)).toBe(1)

            // Provider values are part of an attestation, never written beside one.
            const empty = await openPendingBinding(first, { accountId: account.accountId })
            expect(await attestBinding(first, empty.bindingId, null, null)).toBe(1)
            expect(refusal(await settle(first.$executeRawUnsafe(
                'UPDATE "WhatsAppTransportBinding" SET "attestedPnValue" = $2 WHERE "bindingId" = $1',
                empty.bindingId,
                account.pn,
            )))).toContain(attestationOnly)
            expect(refusal(await settle(first.$executeRawUnsafe(
                'UPDATE "WhatsAppTransportBinding" SET "attestedLidValue" = $2 WHERE "bindingId" = $1',
                empty.bindingId,
                account.lid,
            )))).toContain(attestationOnly)

            // A pending pair recorded by an earlier attestation counts only while that attestation
            // is live: it can neither be verified nor refreshed by a window-only re-attestation.
            const lapsedPair = 'pending key pair counts only while its current attestation window is live'
            const carried = await openPendingBinding(first, { accountId: account.accountId })
            expect(await attestBinding(first, carried.bindingId, account.pn, account.lid, 1)).toBe(1)
            await pause(1_300)
            expect(refusal(await settle(verifyBinding(first, carried.bindingId, account.pn, account.lid)))).toContain(lapsedPair)
            expect(refusal(await settle(first.$executeRawUnsafe(
                `UPDATE "WhatsAppTransportBinding"
                SET "attestedUntil" = now() + interval '5 minutes', "attestingInstanceId" = 'attester-2'
                WHERE "bindingId" = $1`,
                carried.bindingId,
            )))).toContain(lapsedPair)

            // Two attestations of one binding inside one transaction are not an older attestation,
            // whatever the sub-millisecond part of the transaction clock (repeated to cover it).
            for (let attempt = 0; attempt < 20; attempt += 1) {
                const sameTransaction = await openPendingBinding(first, { accountId: account.accountId })
                expect(await first.$transaction(async (tx) => {
                    await attestBinding(tx, sameTransaction.bindingId, account.pn, account.lid)
                    return verifyBinding(tx, sameTransaction.bindingId, account.pn, account.lid)
                }, TRANSACTION)).toBe(1)
            }

            // The verifying update's new window must itself be fresh on the database clock.
            const staleWindow = await openPendingBinding(first, { accountId: account.accountId })
            expect(refusal(await settle(first.$transaction(async (tx) => {
                await tx.$queryRawUnsafe('SELECT 1 AS "slept" FROM pg_sleep(1.5)')
                await tx.$executeRawUnsafe(
                    `UPDATE "WhatsAppTransportBinding"
                    SET "trustState" = 'verified', "attestedPnValue" = $2, "attestedLidValue" = $3,
                        "attestedUntil" = now() + interval '1 second'
                    WHERE "bindingId" = $1`,
                    staleWindow.bindingId,
                    account.pn,
                    account.lid,
                )
            }, TRANSACTION)))).toContain(freshAttestation)

            // A complete but earlier attestation does not verify later on its own window.
            const earlier = await openPendingBinding(first, { accountId: account.accountId })
            expect(await attestBinding(first, earlier.bindingId, account.pn, account.lid)).toBe(1)
            expect(refusal(await settle(first.$executeRawUnsafe(
                'UPDATE "WhatsAppTransportBinding" SET "trustState" = \'verified\' WHERE "bindingId" = $1',
                earlier.bindingId,
            )))).toContain(freshAttestation)
            expect(await verifyBinding(first, earlier.bindingId, account.pn, account.lid)).toBe(1)

            const lapsed = await openPendingBinding(first, { accountId: account.accountId })
            expect(await attestBinding(first, lapsed.bindingId, account.pn, account.lid, 1)).toBe(1)
            await pause(1_300)
            expect(refusal(await settle(first.$executeRawUnsafe(
                'UPDATE "WhatsAppTransportBinding" SET "trustState" = \'verified\' WHERE "bindingId" = $1',
                lapsed.bindingId,
            )))).toContain(freshAttestation)

            // Inserting a verified binding is itself the attestation: it needs a window that is
            // still fresh on the database clock, however long the inserting transaction has run.
            expect(refusal(await settle(first.$transaction(async (tx) => {
                await tx.$queryRawUnsafe('SELECT 1 AS "slept" FROM pg_sleep(1.5)')
                await tx.$executeRawUnsafe(
                    `INSERT INTO "WhatsAppTransportBinding" (
                        "bindingId", "transportKind", "transportRef", "transportGeneration", "accountId", "bindingSeq",
                        "trustState", "attestationOrigin", "attestedPnValue", "attestedLidValue", "attestingInstanceId", "attestedUntil"
                    ) VALUES ($1, 'whatsapp_web_slot', $2, 1, $3, 1, 'verified', 'provider_verified', $4, $5, 'attester-1',
                        now() + interval '1 second')`,
                    newId('bind'),
                    newId('slot'),
                    account.accountId,
                    account.pn,
                    account.lid,
                )
            }, TRANSACTION)))).toContain('opens as verified only with a fresh attestation')
            expect(refusal(await settle(first.$executeRawUnsafe(
                `INSERT INTO "WhatsAppTransportBinding" (
                    "bindingId", "transportKind", "transportRef", "transportGeneration", "accountId", "bindingSeq",
                    "trustState", "attestationOrigin", "attestedPnValue", "attestedLidValue", "attestingInstanceId"
                ) VALUES ($1, 'whatsapp_web_slot', $2, 1, $3, 1, 'verified', 'provider_verified', $4, $5, 'attester-1')`,
                newId('bind'),
                newId('slot'),
                account.accountId,
                account.pn,
                account.lid,
            )))).toContain('opens as verified only with a fresh attestation')

            // A pending pair lapses on the statement clock: a transaction that began while the pair was
            // live can neither carry it into a new window nor verify it once the window has ended.
            for (const operation of ['carry', 'verify'] as const) {
                const lapsing = await openPendingBinding(first, { accountId: account.accountId })
                expect(await attestBinding(first, lapsing.bindingId, account.pn, account.lid, 1)).toBe(1)
                expect(refusal(await settle(first.$transaction(async (tx) => {
                    await tx.$queryRawUnsafe('SELECT 1 AS "slept" FROM pg_sleep(1.3)')
                    if (operation === 'carry') {
                        await tx.$executeRawUnsafe(
                            `UPDATE "WhatsAppTransportBinding" SET "attestedUntil" = now() + interval '5 minutes' WHERE "bindingId" = $1`,
                            lapsing.bindingId,
                        )
                    } else {
                        await verifyBinding(tx, lapsing.bindingId, account.pn, account.lid)
                    }
                }, TRANSACTION)))).toContain('pending key pair counts only while its current attestation window is live')
            }
        }, 20_000)

        it('follows trust transitions with no resurrection and a reason for every close', async () => {
            const account = await activeAccount()
            expect(refusal(await settle(first.$executeRawUnsafe(
                `INSERT INTO "WhatsAppTransportBinding" (
                    "bindingId", "transportKind", "transportRef", "transportGeneration", "accountId", "bindingSeq",
                    "trustState", "attestationOrigin", "attestingInstanceId", "closeReason"
                ) VALUES ($1, 'whatsapp_web_slot', $2, 1, $3, 1, 'closed', 'provider_verified', 'attester-1', 'logged_out')`,
                newId('bind'),
                newId('slot'),
                account.accountId,
            )))).toContain('opens as pending or verified')

            const verified = await openBinding(first, { ...account })
            expect(refusal(await settle(first.$executeRawUnsafe(
                'UPDATE "WhatsAppTransportBinding" SET "trustState" = \'pending\' WHERE "bindingId" = $1',
                verified.bindingId,
            )))).toContain('from verified to pending is not permitted')
            expect(refusal(await settle(first.$executeRawUnsafe(
                'UPDATE "WhatsAppTransportBinding" SET "trustState" = \'revoked\' WHERE "bindingId" = $1',
                verified.bindingId,
            )))).toMatch(/23514|check constraint/u)
            expect(await closeBinding(first, verified.bindingId, 'revoked', 'revoked_by_operator')).toBe(1)
            for (const target of ['verified', 'pending', 'closed']) {
                expect(refusal(await settle(first.$executeRawUnsafe(
                    'UPDATE "WhatsAppTransportBinding" SET "trustState" = $2 WHERE "bindingId" = $1',
                    verified.bindingId,
                    target,
                )))).toContain('closed and frozen')
            }

            // A close time and reason without a closing trust state are refused, so a binding cannot
            // look closed to the open-slot index while it stays verified and holds a lease.
            const ready = await leaseReadyAccount()
            await acquire(first, { accountId: ready.accountId, capability: 'inbound', bindingId: ready.primary.bindingId, instanceId: 'holder-1', seconds: 60 })
            const unclosedPending = await openPendingBinding(first, { accountId: account.accountId })
            for (const bindingId of [ready.primary.bindingId, unclosedPending.bindingId]) {
                expect(refusal(await settle(first.$executeRawUnsafe(
                    'UPDATE "WhatsAppTransportBinding" SET "closedAt" = now(), "closeReason" = \'superseded\' WHERE "bindingId" = $1',
                    bindingId,
                )))).toContain('WhatsAppTransportBinding_trust_check')
            }
            expect(await readBinding(ready.primary.bindingId)).toMatchObject({ trustState: 'verified', closedAt: null })
            expect(await readBinding(unclosedPending.bindingId)).toMatchObject({ trustState: 'pending', closedAt: null })
            expect(await readLease(ready.accountId, 'inbound')).toMatchObject({ state: 'held', holderBindingId: ready.primary.bindingId })

            const pending = await openPendingBinding(first, { accountId: account.accountId })
            expect(await closeBinding(first, pending.bindingId, 'closed', 'superseded')).toBe(1)
            expect(await readBinding(pending.bindingId)).toMatchObject({ trustState: 'closed', closeReason: 'superseded' })
            expect((await readBinding(pending.bindingId)).closedAt).not.toBeNull()
        })

        it('requires operator confirmation of the complete claimed key set before a transport-asserted binding is verified', async () => {
            const account = await activeAccount()
            expect(refusal(await settle(openAssertedBinding(first, account.accountId, null, null)))).toContain(CLAIMED_KEY_SET)
            // A claim is an exact, trimmed provider value.
            expect(refusal(await settle(openAssertedBinding(first, account.accountId, '', null)))).toContain(CLAIMED_KEY_SET)
            expect(refusal(await settle(openAssertedBinding(first, account.accountId, null, ` ${account.lid}`)))).toContain(CLAIMED_KEY_SET)

            const unconfirmed = await openAssertedBinding(first, account.accountId, account.pn, account.lid)
            expect(refusal(await settle(verifyBinding(first, unconfirmed.bindingId, account.pn, account.lid))))
                .toContain('WhatsAppTransportBinding_attestation_check')

            // An operator can only confirm a complete claim, whichever half is missing.
            const pnClaim = await openAssertedBinding(first, account.accountId, account.pn, null)
            expect(refusal(await settle(confirmBinding(first, pnClaim.bindingId)))).toContain(CLAIMED_KEY_SET)
            const lidClaim = await openAssertedBinding(first, account.accountId, null, account.lid)
            expect(refusal(await settle(confirmBinding(first, lidClaim.bindingId)))).toContain(CLAIMED_KEY_SET)

            // Even pending, attested evidence must equal the claim half by half, and a missing
            // claim half is not a match.
            expect(refusal(await settle(attestBinding(first, pnClaim.bindingId, account.pn, account.lid)))).toContain(CLAIMED_KEY_SET)
            expect(refusal(await settle(attestBinding(first, lidClaim.bindingId, account.pn, account.lid)))).toContain(CLAIMED_KEY_SET)
            const foreignPnClaim = await openAssertedBinding(first, account.accountId, newKeyValue(), account.lid)
            expect(refusal(await settle(attestBinding(first, foreignPnClaim.bindingId, account.pn, account.lid)))).toContain(CLAIMED_KEY_SET)

            // Each claimed value is recorded once; only a missing half may be completed.
            const immutableClaim = 'claimed provider key set is immutable once recorded'
            expect(refusal(await settle(setClaimedPn(first, pnClaim.bindingId, newKeyValue())))).toContain(immutableClaim)
            expect(await setClaimedLid(first, pnClaim.bindingId, account.lid)).toBe(1)
            expect(refusal(await settle(setClaimedLid(first, pnClaim.bindingId, null)))).toContain(immutableClaim)
            expect(refusal(await settle(setClaimedPn(first, pnClaim.bindingId, null)))).toContain(immutableClaim)
            expect(await setClaimedPn(first, lidClaim.bindingId, account.pn)).toBe(1)
            expect(refusal(await settle(setClaimedLid(first, lidClaim.bindingId, newKeyValue())))).toContain(immutableClaim)

            // Evidence never contradicts the claim, pending or not, and a claim that is not the
            // account's key set cannot be corrected afterwards.
            const foreignClaim = await openAssertedBinding(first, account.accountId, account.pn, newKeyValue())
            expect(refusal(await settle(attestBinding(first, foreignClaim.bindingId, account.pn, account.lid)))).toContain(CLAIMED_KEY_SET)
            expect(await confirmBinding(first, foreignClaim.bindingId)).toBe(1)
            expect(refusal(await settle(verifyBinding(first, foreignClaim.bindingId, account.pn, account.lid)))).toContain(CLAIMED_KEY_SET)
            expect(refusal(await settle(setClaimedLid(first, foreignClaim.bindingId, account.lid)))).toContain(immutableClaim)

            // A confirmed complete claim verifies, and the confirmation cannot be rewritten.
            expect(await confirmBinding(first, pnClaim.bindingId)).toBe(1)
            expect(await verifyBinding(first, pnClaim.bindingId, account.pn, account.lid)).toBe(1)
            expect(refusal(await settle(first.$executeRawUnsafe(
                'UPDATE "WhatsAppTransportBinding" SET "operatorConfirmedBy" = \'operator-2\' WHERE "bindingId" = $1',
                pnClaim.bindingId,
            )))).toContain('operator confirmation is immutable')
            expect(refusal(await settle(first.$executeRawUnsafe(
                'UPDATE "WhatsAppTransportBinding" SET "operatorConfirmedAt" = now() + interval \'5 minutes\' WHERE "bindingId" = $1',
                pnClaim.bindingId,
            )))).toContain('operator confirmation is immutable')
            expect(refusal(await settle(first.$executeRawUnsafe(
                'UPDATE "WhatsAppTransportBinding" SET "operatorConfirmedAt" = NULL, "operatorConfirmedBy" = NULL WHERE "bindingId" = $1',
                pnClaim.bindingId,
            )))).toContain('operator confirmation is immutable')
        })

        it('never lets a verified binding carry a claim that contradicts its attested key set', async () => {
            const account = await activeAccount()
            const stranger = await activeAccount()
            expect(refusal(await settle(first.$executeRawUnsafe(
                `INSERT INTO "WhatsAppTransportBinding" (
                    "bindingId", "transportKind", "transportRef", "transportGeneration", "accountId", "bindingSeq",
                    "trustState", "attestationOrigin", "attestedPnValue", "attestedLidValue", "claimedPnValue", "claimedLidValue",
                    "attestingInstanceId", "attestedUntil"
                ) VALUES ($1, 'whatsapp_web_slot', $2, 1, $3, 1, 'verified', 'provider_verified', $4, $5, $6, $7,
                    'attester-1', now() + interval '10 minutes')`,
                newId('bind'),
                newId('slot'),
                account.accountId,
                account.pn,
                account.lid,
                stranger.pn,
                stranger.lid,
            )))).toContain(CLAIMED_KEY_SET)

            const verified = await openBinding(first, { ...account })
            expect(refusal(await settle(setClaimedPn(first, verified.bindingId, stranger.pn)))).toContain(CLAIMED_KEY_SET)
            expect(refusal(await settle(setClaimedLid(first, verified.bindingId, stranger.lid)))).toContain(CLAIMED_KEY_SET)
            expect(await setClaimedPn(first, verified.bindingId, account.pn)).toBe(1)

            // A pending binding may keep what the transport presented as mismatch evidence.
            const presented = await openPendingBinding(first, { accountId: account.accountId })
            expect(await setClaimedPn(first, presented.bindingId, account.pn)).toBe(1)
            expect(await setClaimedLid(first, presented.bindingId, stranger.lid)).toBe(1)
            expect(await closeBinding(first, presented.bindingId, 'mismatched', 'account_changed')).toBe(1)
        })

        it('moves attestation forward only and derives stale from attestedUntil without storing it', async () => {
            const account = await activeAccount()
            const binding = await openBinding(first, { ...account, attestedSeconds: 600 })
            const before = await readBinding(binding.bindingId)

            expect(refusal(await settle(first.$executeRawUnsafe(
                'UPDATE "WhatsAppTransportBinding" SET "attestedUntil" = now() + interval \'5 minutes\' WHERE "bindingId" = $1',
                binding.bindingId,
            )))).toContain('attestedUntil only moves forward')
            expect(refusal(await settle(first.$executeRawUnsafe(
                'UPDATE "WhatsAppTransportBinding" SET "attestedUntil" = now() + interval \'2 hours\' WHERE "bindingId" = $1',
                binding.bindingId,
            )))).toMatch(/23514|check constraint/u)
            expect(refusal(await settle(first.$executeRawUnsafe(
                'UPDATE "WhatsAppTransportBinding" SET "attestingInstanceId" = \'attester-2\' WHERE "bindingId" = $1',
                binding.bindingId,
            )))).toContain('change only with a new attestation')
            expect(refusal(await settle(first.$executeRawUnsafe(
                'UPDATE "WhatsAppTransportBinding" SET "lastAttestedAt" = now() - interval \'1 minute\' WHERE "bindingId" = $1',
                binding.bindingId,
            )))).toContain('change only with a new attestation')
            expect(await first.$executeRawUnsafe(
                `UPDATE "WhatsAppTransportBinding"
                SET "attestedUntil" = now() + interval '15 minutes', "attestingInstanceId" = 'attester-2',
                    "lastAttestedAt" = '2001-01-01T00:00:00Z'
                WHERE "bindingId" = $1`,
                binding.bindingId,
            )).toBe(1)
            const after = await readBinding(binding.bindingId)
            expect(after.lastAttestedAt!.getTime()).toBeGreaterThanOrEqual(before.lastAttestedAt!.getTime())
            expect(after.attestedUntil!.getTime()).toBeGreaterThan(before.attestedUntil!.getTime())

            const shortLived = await openBinding(first, { ...account, attestedSeconds: 1 })
            await pause(1_300)
            expect(await readBinding(shortLived.bindingId)).toMatchObject({ trustState: 'verified', stale: true, closedAt: null })
            const staleAcquire = await settle(acquire(first, {
                accountId: account.accountId,
                capability: 'inbound',
                bindingId: shortLived.bindingId,
                instanceId: 'holder-1',
                seconds: 30,
            }))
            expect(refusal(staleAcquire)).toContain('open, verified and freshly attested')
        })

        it('refuses an attestation computed in a transaction older than the recorded attestation', async () => {
            const account = await activeAccount()
            const binding = await openBinding(first, { ...account })
            let olderStarted!: () => void
            let newerCommitted!: () => void
            const started = new Promise<void>((resolve) => { olderStarted = resolve })
            const committed = new Promise<void>((resolve) => { newerCommitted = resolve })
            const older = settle(second.$transaction(async (tx) => {
                await tx.$queryRawUnsafe('SELECT now() AS "startedAt"')
                olderStarted()
                await committed
                await tx.$executeRawUnsafe(
                    'UPDATE "WhatsAppTransportBinding" SET "attestedUntil" = now() + interval \'50 minutes\' WHERE "bindingId" = $1',
                    binding.bindingId,
                )
            }, TRANSACTION))
            await started
            await pause(50)
            expect(await first.$executeRawUnsafe(
                'UPDATE "WhatsAppTransportBinding" SET "attestedUntil" = now() + interval \'40 minutes\' WHERE "bindingId" = $1',
                binding.bindingId,
            )).toBe(1)
            newerCommitted()
            expect(refusal(await older)).toContain('older than the recorded attestation')
        })
    })

    describe('capability leases', () => {
        it('acquires only for an active account through an open, verified, fresh binding of that account', async () => {
            const pendingAccount = await createAccount()
            const pendingBinding = await openBinding(first, { ...pendingAccount })
            expect(refusal(await settle(acquire(first, {
                accountId: pendingAccount.accountId,
                capability: 'outbound',
                bindingId: pendingBinding.bindingId,
                instanceId: 'holder-1',
                seconds: 30,
            })))).toContain('requires an active account')

            const account = await activeAccount()
            const other = await leaseReadyAccount()
            const unverified = await openPendingBinding(first, { accountId: account.accountId })
            const closed = await openBinding(first, { ...account })
            await closeBinding(first, closed.bindingId, 'closed', 'logged_out')
            for (const bindingId of [unverified.bindingId, closed.bindingId, other.primary.bindingId]) {
                expect(refusal(await settle(acquire(first, {
                    accountId: account.accountId,
                    capability: 'outbound',
                    bindingId,
                    instanceId: 'holder-1',
                    seconds: 30,
                })))).toContain('open, verified and freshly attested for the same account')
            }

            const ready = await leaseReadyAccount()
            expect(refusal(await settle(first.$executeRawUnsafe(
                `INSERT INTO "WhatsAppCapabilityLease"
                    ("accountId", "capability", "epoch", "version", "holderBindingId", "holderInstanceId", "state", "leaseUntil")
                VALUES ($1, 'outbound', 2, 1, $2, 'holder-1', 'held', now() + interval '30 seconds')`,
                ready.accountId,
                ready.primary.bindingId,
            )))).toContain('first acquired as held at epoch 1 and version 1')
            expect(refusal(await settle(first.$executeRawUnsafe(
                `INSERT INTO "WhatsAppCapabilityLease"
                    ("accountId", "capability", "epoch", "version", "holderBindingId", "holderInstanceId", "state", "leaseUntil")
                VALUES ($1, 'media_fetch', 1, 1, $2, 'holder-1', 'held', now() + interval '30 seconds')`,
                ready.accountId,
                ready.primary.bindingId,
            )))).toMatch(/23514|check constraint/u)

            const lease = { accountId: ready.accountId, capability: 'outbound' as const, bindingId: ready.primary.bindingId, instanceId: 'holder-1', seconds: 30 }
            expect(await acquire(first, lease)).toBe(1)
            expect(await readLease(ready.accountId, 'outbound')).toMatchObject({ epoch: 1, version: 1, state: 'held', lastReleasedAt: null })
            expect(refusal(await settle(acquire(first, { ...lease, bindingId: ready.secondary.bindingId, instanceId: 'holder-2' }))))
                .toMatch(/23505|duplicate key/u)

            // Exclusivity is per capability: other capabilities of the same account are independent.
            expect(await acquire(first, { ...lease, capability: 'inbound', bindingId: ready.secondary.bindingId, instanceId: 'holder-2' })).toBe(1)
            expect(await acquire(first, { ...lease, capability: 'history_import', instanceId: 'holder-3' })).toBe(1)
        })

        it('clamps the lease window to the capability maximum and outbound to the holder attestation', async () => {
            const ready = await leaseReadyAccount(600)
            await acquire(first, { accountId: ready.accountId, capability: 'inbound', bindingId: ready.primary.bindingId, instanceId: 'h', seconds: 3_600 })
            await acquire(first, { accountId: ready.accountId, capability: 'history_import', bindingId: ready.primary.bindingId, instanceId: 'h', seconds: 3_600 })
            await acquire(first, { accountId: ready.accountId, capability: 'outbound', bindingId: ready.primary.bindingId, instanceId: 'h', seconds: 3_600 })
            const inbound = await readLease(ready.accountId, 'inbound')
            const history = await readLease(ready.accountId, 'history_import')
            const outbound = await readLease(ready.accountId, 'outbound')
            expect(secondsBetween(inbound.leaseUntil, inbound.heartbeatAt)).toBe(120)
            expect(secondsBetween(history.leaseUntil, history.heartbeatAt)).toBe(300)
            expect(secondsBetween(outbound.leaseUntil, outbound.heartbeatAt)).toBe(60)
            expect(inbound.fenceUntil.getTime()).toBe(inbound.heartbeatAt.getTime())

            const shortAttestation = await leaseReadyAccount(20)
            await acquire(first, {
                accountId: shortAttestation.accountId,
                capability: 'outbound',
                bindingId: shortAttestation.primary.bindingId,
                instanceId: 'h',
                seconds: 60,
            })
            const clamped = await readLease(shortAttestation.accountId, 'outbound')
            const attestation = await readBinding(shortAttestation.primary.bindingId)
            expect(clamped.leaseUntil.getTime()).toBe(attestation.attestedUntil!.getTime())
        })

        it('enforces version and epoch contiguity, a fixed scope and a fixed holder within an epoch', async () => {
            const ready = await leaseReadyAccount()
            await acquire(first, { accountId: ready.accountId, capability: 'inbound', bindingId: ready.primary.bindingId, instanceId: 'holder-1', seconds: 60 })
            const refusals: Array<[string, string]> = [
                ['UPDATE "WhatsAppCapabilityLease" SET "version" = "version" + 2 WHERE "accountId" = $1 AND "capability" = \'inbound\'', 'version must advance by exactly one'],
                ['UPDATE "WhatsAppCapabilityLease" SET "leaseUntil" = now() + interval \'30 seconds\' WHERE "accountId" = $1 AND "capability" = \'inbound\'', 'version must advance by exactly one'],
                ['UPDATE "WhatsAppCapabilityLease" SET "version" = "version" - 1 WHERE "accountId" = $1 AND "capability" = \'inbound\'', 'version must advance by exactly one'],
                ['UPDATE "WhatsAppCapabilityLease" SET "version" = "version" + 1, "epoch" = "epoch" + 2 WHERE "accountId" = $1 AND "capability" = \'inbound\'', 'epoch must be monotonic and contiguous'],
                ['UPDATE "WhatsAppCapabilityLease" SET "version" = "version" + 1, "holderInstanceId" = \'intruder\' WHERE "accountId" = $1 AND "capability" = \'inbound\'', 'holder cannot change without a new epoch'],
                ['UPDATE "WhatsAppCapabilityLease" SET "version" = "version" + 1, "capability" = \'outbound\' WHERE "accountId" = $1 AND "capability" = \'inbound\'', 'scope is immutable'],
                ['UPDATE "WhatsAppCapabilityLease" SET "version" = "version" + 1, "accountId" = "accountId" || \'-moved\' WHERE "accountId" = $1 AND "capability" = \'inbound\'', 'scope is immutable'],
                ['DELETE FROM "WhatsAppCapabilityLease" WHERE "accountId" = $1', 'durable fencing history and cannot be removed'],
            ]
            for (const [statement, message] of refusals) {
                expect(refusal(await settle(first.$executeRawUnsafe(statement, ready.accountId)))).toContain(message)
            }
            expect(refusal(await settle(first.$executeRawUnsafe(
                `UPDATE "WhatsAppCapabilityLease" SET "version" = "version" + 1, "holderBindingId" = $2
                WHERE "accountId" = $1 AND "capability" = 'inbound'`,
                ready.accountId,
                ready.secondary.bindingId,
            )))).toContain('holder cannot change without a new epoch')
            expect(refusal(await settle(first.$executeRawUnsafe('TRUNCATE "WhatsAppCapabilityLease"'))))
                .toContain('WhatsAppCapabilityLease is durable WhatsApp account history and cannot be truncated')
            expect(await readLease(ready.accountId, 'inbound')).toMatchObject({ epoch: 1, version: 1, holderInstanceId: 'holder-1' })
        })

        it('refuses premature takeover, takes over after expiry and fences the stale epoch', async () => {
            const ready = await leaseReadyAccount()
            await acquire(first, { accountId: ready.accountId, capability: 'inbound', bindingId: ready.primary.bindingId, instanceId: 'holder-1', seconds: 1.5 })
            const takeoverInput = {
                accountId: ready.accountId,
                capability: 'inbound' as const,
                fromEpoch: 1,
                bindingId: ready.secondary.bindingId,
                instanceId: 'holder-2',
                seconds: 60,
            }
            expect(refusal(await settle(takeover(first, takeoverInput)))).toContain('before the held lease expires')

            await pause(1_700)
            expect(await takeover(first, takeoverInput)).toBe(1)
            expect(await readLease(ready.accountId, 'inbound')).toMatchObject({
                epoch: 2,
                version: 2,
                state: 'held',
                holderBindingId: ready.secondary.bindingId,
                holderInstanceId: 'holder-2',
            })

            const stale = { accountId: ready.accountId, capability: 'inbound' as const, epoch: 1, instanceId: 'holder-1', seconds: 60 }
            expect(await renew(first, stale)).toBe(0)
            expect(await holdsAuthority(first, { ...stale, bindingId: ready.primary.bindingId })).toBe(false)
            expect(refusal(await settle(first.$executeRawUnsafe(
                `UPDATE "WhatsAppCapabilityLease"
                SET "epoch" = 1, "version" = "version" + 1, "holderBindingId" = $2, "holderInstanceId" = 'holder-1'
                WHERE "accountId" = $1 AND "capability" = 'inbound'`,
                ready.accountId,
                ready.primary.bindingId,
            )))).toContain('epoch must be monotonic and contiguous')
            expect(await holdsAuthority(first, {
                accountId: ready.accountId,
                capability: 'inbound',
                epoch: 2,
                instanceId: 'holder-2',
                bindingId: ready.secondary.bindingId,
            })).toBe(true)
        })

        it('never revives a released epoch and quarantines a release that does not come from the holder', async () => {
            const ready = await leaseReadyAccount()
            await acquire(first, { accountId: ready.accountId, capability: 'inbound', bindingId: ready.primary.bindingId, instanceId: 'holder-1', seconds: 2.5 })
            const held = await readLease(ready.accountId, 'inbound')

            expect(await releaseByOperator(first, ready.accountId, 'inbound')).toBe(1)
            const released = await readLease(ready.accountId, 'inbound')
            expect(released).toMatchObject({ epoch: 1, version: 2, state: 'released' })
            expect(released.lastReleasedAt).not.toBeNull()
            expect(released.fenceUntil.getTime()).toBeGreaterThanOrEqual(held.leaseUntil.getTime())

            expect(refusal(await settle(first.$executeRawUnsafe(
                `UPDATE "WhatsAppCapabilityLease"
                SET "state" = 'held', "version" = "version" + 1, "leaseUntil" = now() + interval '30 seconds'
                WHERE "accountId" = $1 AND "capability" = 'inbound'`,
                ready.accountId,
            )))).toContain('released epoch cannot be revived or rewritten')
            // Releasing again, with or without a holder declaration, cannot recompute the quarantine.
            expect(refusal(await settle(first.$executeRawUnsafe(
                `UPDATE "WhatsAppCapabilityLease" SET "state" = 'released', "version" = "version" + 1
                WHERE "accountId" = $1 AND "capability" = 'inbound'`,
                ready.accountId,
            )))).toContain('released epoch cannot be revived or rewritten')
            expect(refusal(await settle(first.$transaction(async (tx) => {
                await tx.$queryRawUnsafe(
                    "SELECT set_config('yoko.whatsapp_lease_holder', $1 || ':' || pg_current_xact_id()::text, true) AS \"holder\"",
                    'holder-1',
                )
                await tx.$executeRawUnsafe(
                    `UPDATE "WhatsAppCapabilityLease" SET "state" = 'released', "version" = "version" + 1
                    WHERE "accountId" = $1 AND "capability" = 'inbound'`,
                    ready.accountId,
                )
            }, TRANSACTION)))).toContain('released epoch cannot be revived or rewritten')
            const stillReleased = await readLease(ready.accountId, 'inbound')
            expect(stillReleased).toMatchObject({ epoch: 1, version: 2, state: 'released' })
            expect(stillReleased.fenceUntil.getTime()).toBe(released.fenceUntil.getTime())
            expect(stillReleased.leaseUntil.getTime()).toBe(released.leaseUntil.getTime())
            expect(stillReleased.lastReleasedAt!.getTime()).toBe(released.lastReleasedAt!.getTime())

            const takeoverInput = {
                accountId: ready.accountId,
                capability: 'inbound' as const,
                fromEpoch: 1,
                bindingId: ready.secondary.bindingId,
                instanceId: 'holder-2',
                seconds: 60,
            }
            expect(refusal(await settle(takeover(first, takeoverInput)))).toContain('previous epoch is quarantined')
            await pause(Math.max(0, released.fenceUntil.getTime() - released.dbNow.getTime()) + 300)
            expect(await takeover(first, takeoverInput)).toBe(1)
            expect(await readLease(ready.accountId, 'inbound')).toMatchObject({ epoch: 2, state: 'held', holderInstanceId: 'holder-2' })
        })

        it('lets only the declared holder release without quarantine', async () => {
            const ready = await leaseReadyAccount()
            const base = { accountId: ready.accountId, epoch: 1, instanceId: 'holder-1' }
            await acquire(first, { ...base, capability: 'inbound', bindingId: ready.primary.bindingId, seconds: 60 })
            await acquire(first, { ...base, capability: 'history_import', bindingId: ready.primary.bindingId, seconds: 60 })

            expect(await releaseAsInstance({ ...base, capability: 'inbound', declaredInstanceId: 'holder-1' })).toBe(1)
            const selfReleased = await readLease(ready.accountId, 'inbound')
            expect(selfReleased.fenceUntil.getTime()).toBeLessThanOrEqual(selfReleased.dbNow.getTime())
            expect(await takeover(first, {
                accountId: ready.accountId,
                capability: 'inbound',
                fromEpoch: 1,
                bindingId: ready.secondary.bindingId,
                instanceId: 'holder-2',
                seconds: 60,
            })).toBe(1)

            expect(await releaseAsInstance({ ...base, capability: 'history_import', declaredInstanceId: 'someone-else' })).toBe(1)
            const foreignRelease = await readLease(ready.accountId, 'history_import')
            expect(secondsBetween(foreignRelease.fenceUntil, foreignRelease.dbNow)).toBeGreaterThan(50)
            expect(refusal(await settle(takeover(first, {
                accountId: ready.accountId,
                capability: 'history_import',
                fromEpoch: 1,
                bindingId: ready.secondary.bindingId,
                instanceId: 'holder-2',
                seconds: 60,
            })))).toContain('previous epoch is quarantined')
        })

        it('takes over inside the transaction that releases, whatever the sub-millisecond clock', async () => {
            const ready = await leaseReadyAccount()
            const holders = [
                { bindingId: ready.primary.bindingId, instanceId: 'holder-a' },
                { bindingId: ready.secondary.bindingId, instanceId: 'holder-b' },
            ]
            // A declared release and the takeover in one transaction, repeated so that the
            // transaction clock lands on both halves of a millisecond.
            await acquire(first, { accountId: ready.accountId, capability: 'inbound', ...holders[0], seconds: 60 })
            for (let epoch = 1; epoch <= 16; epoch += 1) {
                const from = holders[(epoch - 1) % 2]
                const to = holders[epoch % 2]
                await first.$transaction(async (tx) => {
                    await tx.$queryRawUnsafe(
                        "SELECT set_config('yoko.whatsapp_lease_holder', $1 || ':' || pg_current_xact_id()::text, true) AS \"holder\"",
                        from.instanceId,
                    )
                    expect(await releaseByOperator(tx, ready.accountId, 'inbound')).toBe(1)
                    expect(await takeover(tx, { accountId: ready.accountId, capability: 'inbound', fromEpoch: epoch, ...to, seconds: 60 })).toBe(1)
                }, TRANSACTION)
            }
            expect(await readLease(ready.accountId, 'inbound')).toMatchObject({ epoch: 17, state: 'held', holderInstanceId: 'holder-a' })

            // An expired lease released without a declaration and the takeover in one transaction.
            await acquire(first, { accountId: ready.accountId, capability: 'history_import', ...holders[0], seconds: 0.05 })
            for (let epoch = 1; epoch <= 16; epoch += 1) {
                const to = holders[epoch % 2]
                await pause(80)
                await first.$transaction(async (tx) => {
                    expect(await releaseByOperator(tx, ready.accountId, 'history_import')).toBe(1)
                    expect(await takeover(tx, { accountId: ready.accountId, capability: 'history_import', fromEpoch: epoch, ...to, seconds: 0.05 })).toBe(1)
                }, TRANSACTION)
            }
            expect(await readLease(ready.accountId, 'history_import')).toMatchObject({ epoch: 17, state: 'held', holderInstanceId: 'holder-a' })
        }, 20_000)

        it('refuses to leave active or to close the holder binding while a lease is held', async () => {
            const ready = await leaseReadyAccount()
            await acquire(first, { accountId: ready.accountId, capability: 'outbound', bindingId: ready.primary.bindingId, instanceId: 'holder-1', seconds: 30 })

            expect(refusal(await settle(moveLifecycle(first, ready.accountId, 'disabled'))))
                .toContain('cannot leave active while a capability lease is held')
            for (const [trustState, reason] of [['revoked', 'credential_invalid'], ['mismatched', 'account_changed'], ['closed', 'logged_out']] as const) {
                expect(refusal(await settle(closeBinding(first, ready.primary.bindingId, trustState, reason))))
                    .toContain('cannot close or leave verified while it holds a capability lease')
            }
            // A transport that holds nothing may close while the other one holds.
            expect(await closeBinding(first, ready.secondary.bindingId, 'closed', 'logged_out')).toBe(1)

            expect(await releaseByOperator(first, ready.accountId, 'outbound')).toBe(1)
            expect(await closeBinding(first, ready.primary.bindingId, 'revoked', 'credential_invalid')).toBe(1)
            expect(await moveLifecycle(first, ready.accountId, 'disabled')).toBe(1)
            expect(await readLease(ready.accountId, 'outbound')).toMatchObject({ state: 'released', epoch: 1 })
        })

        it('keeps the database-clock lease columns on renew, takeover and release', async () => {
            const ready = await leaseReadyAccount()
            const stale = '2001-01-01T00:00:00Z'
            await acquire(first, { accountId: ready.accountId, capability: 'inbound', bindingId: ready.primary.bindingId, instanceId: 'holder-1', seconds: 1 })
            const acquired = await readLease(ready.accountId, 'inbound')

            // Renew: a caller cannot extend the quarantine or rewrite the last release.
            expect(await first.$executeRawUnsafe(
                `UPDATE "WhatsAppCapabilityLease"
                SET "version" = "version" + 1, "leaseUntil" = now() + interval '1 second',
                    "fenceUntil" = now() + interval '1 hour', "lastReleasedAt" = $2::timestamptz, "heartbeatAt" = $2::timestamptz
                WHERE "accountId" = $1 AND "capability" = 'inbound'`,
                ready.accountId,
                stale,
            )).toBe(1)
            const renewed = await readLease(ready.accountId, 'inbound')
            expect(renewed.fenceUntil.getTime()).toBe(acquired.fenceUntil.getTime())
            expect(renewed.lastReleasedAt).toBeNull()
            expect(Math.abs(secondsBetween(renewed.dbNow, renewed.heartbeatAt))).toBeLessThan(60)

            // Takeover: the new epoch starts with no quarantine, whatever the caller writes.
            await pause(1_200)
            expect(await first.$executeRawUnsafe(
                `UPDATE "WhatsAppCapabilityLease"
                SET "epoch" = "epoch" + 1, "version" = "version" + 1, "holderBindingId" = $2, "holderInstanceId" = 'holder-2',
                    "state" = 'held', "leaseUntil" = now() + interval '1 minute', "fenceUntil" = now() + interval '1 hour'
                WHERE "accountId" = $1 AND "capability" = 'inbound' AND "epoch" = 1`,
                ready.accountId,
                ready.secondary.bindingId,
            )).toBe(1)
            const taken = await readLease(ready.accountId, 'inbound')
            expect(taken.fenceUntil.getTime()).toBe(taken.heartbeatAt.getTime())

            // Release: the release time is the database clock, and the heartbeat is not rewritten.
            expect(await first.$executeRawUnsafe(
                `UPDATE "WhatsAppCapabilityLease"
                SET "state" = 'released', "version" = "version" + 1, "lastReleasedAt" = $2::timestamptz, "heartbeatAt" = $2::timestamptz
                WHERE "accountId" = $1 AND "capability" = 'inbound'`,
                ready.accountId,
                stale,
            )).toBe(1)
            const released = await readLease(ready.accountId, 'inbound')
            expect(Math.abs(secondsBetween(released.dbNow, released.lastReleasedAt!))).toBeLessThan(60)
            expect(released.heartbeatAt.getTime()).toBe(taken.heartbeatAt.getTime())
            expect(released.leaseUntil.getTime()).toBeLessThanOrEqual(released.lastReleasedAt!.getTime())
        })

        it('never shortens a granted lease window on renew and refuses a lease write older than its latest heartbeat', async () => {
            const ready = await leaseReadyAccount()
            const lease = { accountId: ready.accountId, capability: 'inbound' as const, epoch: 1, instanceId: 'holder-1' }
            await acquire(first, { ...lease, bindingId: ready.primary.bindingId, seconds: 60 })
            const granted = await readLease(ready.accountId, 'inbound')

            // A renew that asks for a shorter window keeps the window already granted, so a takeover
            // still waits for it instead of skipping the quarantine that a release would apply.
            expect(await renew(first, { ...lease, seconds: 0.005 })).toBe(1)
            await pause(50)
            const renewed = await readLease(ready.accountId, 'inbound')
            expect(renewed.leaseUntil.getTime()).toBe(granted.leaseUntil.getTime())
            expect(refusal(await settle(takeover(first, {
                accountId: ready.accountId,
                capability: 'inbound',
                fromEpoch: 1,
                bindingId: ready.secondary.bindingId,
                instanceId: 'holder-2',
                seconds: 30,
            })))).toContain('takeover refused before the held lease expires')

            // A renew or a release from a transaction that started before a newer renew.
            const olderThanHeartbeat = 'started before its latest heartbeat'
            expect(refusal(await fromOlderTransaction(
                () => renew(first, { ...lease, seconds: 60 }),
                (tx) => renew(tx, { ...lease, seconds: 60 }),
            ))).toContain(olderThanHeartbeat)
            expect(refusal(await fromOlderTransaction(
                () => renew(first, { ...lease, seconds: 60 }),
                (tx) => releaseByOperator(tx, ready.accountId, 'inbound'),
            ))).toContain(olderThanHeartbeat)
            expect(await readLease(ready.accountId, 'inbound')).toMatchObject({ epoch: 1, version: 4, state: 'held', holderInstanceId: 'holder-1' })
        })

        it('refuses takeover on an account that is no longer active', async () => {
            const ready = await leaseReadyAccount()
            await acquire(first, { accountId: ready.accountId, capability: 'inbound', bindingId: ready.primary.bindingId, instanceId: 'holder-1', seconds: 60 })
            expect(await releaseAsInstance({ accountId: ready.accountId, capability: 'inbound', epoch: 1, instanceId: 'holder-1', declaredInstanceId: 'holder-1' })).toBe(1)
            expect(await moveLifecycle(first, ready.accountId, 'disabled')).toBe(1)
            expect(refusal(await settle(takeover(first, {
                accountId: ready.accountId,
                capability: 'inbound',
                fromEpoch: 1,
                bindingId: ready.secondary.bindingId,
                instanceId: 'holder-2',
                seconds: 30,
            })))).toContain('requires an active account')
            expect(await readLease(ready.accountId, 'inbound')).toMatchObject({ epoch: 1, state: 'released' })
        })

        it('refuses renew and takeover through a stale binding', async () => {
            const ready = await leaseReadyAccount(2)
            await acquire(first, { accountId: ready.accountId, capability: 'inbound', bindingId: ready.primary.bindingId, instanceId: 'holder-1', seconds: 1 })
            await pause(2_300)
            expect(refusal(await settle(renew(first, { accountId: ready.accountId, capability: 'inbound', epoch: 1, instanceId: 'holder-1', seconds: 30 }))))
                .toContain('open, verified and freshly attested')
            expect(refusal(await settle(takeover(first, {
                accountId: ready.accountId,
                capability: 'inbound',
                fromEpoch: 1,
                bindingId: ready.secondary.bindingId,
                instanceId: 'holder-2',
                seconds: 30,
            })))).toContain('open, verified and freshly attested')

            // The freshness gate reads the statement clock: a renew in a transaction that began while the
            // holder binding was fresh is refused once its attestation has lapsed.
            const lapsing = await leaseReadyAccount(2)
            await acquire(first, { accountId: lapsing.accountId, capability: 'inbound', bindingId: lapsing.primary.bindingId, instanceId: 'holder-1', seconds: 30 })
            expect(refusal(await settle(first.$transaction(async (tx) => {
                await tx.$queryRawUnsafe('SELECT 1 AS "slept" FROM pg_sleep(2.3)')
                await renew(tx, { accountId: lapsing.accountId, capability: 'inbound', epoch: 1, instanceId: 'holder-1', seconds: 30 })
            }, TRANSACTION)))).toContain('open, verified and freshly attested')
            expect(await readLease(lapsing.accountId, 'inbound')).toMatchObject({ version: 1 })
        }, 20_000)

        it('answers authority-scoped reads only for the current, held, unexpired epoch', async () => {
            const ready = await leaseReadyAccount()
            const current = { accountId: ready.accountId, capability: 'inbound' as const, epoch: 1, instanceId: 'holder-1', bindingId: ready.primary.bindingId }
            await acquire(first, { ...current, seconds: 1 })
            expect(await holdsAuthority(first, current)).toBe(true)
            expect(await holdsAuthority(first, { ...current, epoch: 2 })).toBe(false)
            expect(await holdsAuthority(first, { ...current, instanceId: 'holder-2' })).toBe(false)
            expect(await holdsAuthority(first, { ...current, bindingId: ready.secondary.bindingId })).toBe(false)
            await pause(1_200)
            expect(await holdsAuthority(first, current)).toBe(false)

            const released = { ...current, capability: 'history_import' as const }
            await acquire(first, { ...released, seconds: 60 })
            await releaseByOperator(first, ready.accountId, 'history_import')
            expect(await holdsAuthority(first, released)).toBe(false)
        })
    })

    describe('table resolution inside the guards', () => {
        it('ignores rows that a session temp child table adds under a foundation table', async () => {
            // Keys: a fake key row under WhatsAppAccountKey never completes either half of a key set,
            // neither for account creation nor for an activation in the creating transaction.
            for (const [realKind, fakeKind] of [
                ['whatsapp_pn_user', 'whatsapp_lid_user'],
                ['whatsapp_lid_user', 'whatsapp_pn_user'],
            ] as const) {
                for (const activate of [false, true]) {
                    const halfAccountId = newId('acc')
                    const result = await settle(first.$transaction(async (tx) => {
                        await tx.$executeRawUnsafe('CREATE TEMP TABLE "fakeKeys" () INHERITS ("WhatsAppAccountKey") ON COMMIT DROP')
                        await insertAccount(tx, halfAccountId)
                        await insertKey(tx, halfAccountId, realKind, newKeyValue())
                        await tx.$executeRawUnsafe(
                            'INSERT INTO "fakeKeys" ("keyKind", "keyValue", "accountId") VALUES ($2, $3, $1)',
                            halfAccountId,
                            fakeKind,
                            newKeyValue(),
                        )
                        if (activate) await moveLifecycle(tx, halfAccountId, 'active')
                    }, TRANSACTION))
                    expect(refusal(result)).toContain(activate
                        ? 'activation requires the complete provider key set'
                        : 'must be created with the complete provider key set')
                    expect(await readAccount(halfAccountId)).toBeUndefined()
                }
            }

            // Accounts: a fake account row with an old creation time does not let a transaction that
            // started before the account was created open a binding for it.
            let created!: AccountFixture
            expect(refusal(await fromOlderTransaction(
                async () => { created = await createAccount() },
                async (tx) => {
                    await tx.$executeRawUnsafe('CREATE TEMP TABLE "fakeCreated" () INHERITS ("WhatsAppAccount") ON COMMIT DROP')
                    await tx.$executeRawUnsafe(
                        `INSERT INTO "fakeCreated" (
                            "accountId", "accountKind", "lifecycle", "lifecycleVersion", "lifecycleChangedBy", "lifecycleReason",
                            "lifecycleChangedAt", "createdAt"
                        ) VALUES ($1, 'whatsapp_user', 'pending_approval', 1, 'system', 'fake', '2001-01-01T00:00:00Z', '2001-01-01T00:00:00Z')`,
                        created.accountId,
                    )
                    await openPendingBinding(tx, { accountId: created.accountId })
                },
            ))).toContain('started before its account was created')

            // Accounts: a fake active account row does not reopen a retired account.
            const retired = await activeAccount()
            await moveLifecycle(first, retired.accountId, 'disabled')
            await moveLifecycle(first, retired.accountId, 'retired')
            expect(refusal(await settle(first.$transaction(async (tx) => {
                await tx.$executeRawUnsafe('CREATE TEMP TABLE "fakeAccounts" () INHERITS ("WhatsAppAccount") ON COMMIT DROP')
                await tx.$executeRawUnsafe(
                    `INSERT INTO "fakeAccounts" ("accountId", "accountKind", "lifecycle", "lifecycleVersion", "lifecycleChangedBy", "lifecycleReason")
                    VALUES ($1, 'whatsapp_user', 'active', 1, 'system', 'fake')`,
                    retired.accountId,
                )
                await openPendingBinding(tx, { accountId: retired.accountId })
            }, TRANSACTION)))).toContain('cannot open for a missing or retired account')

            // Bindings: a fake verified holder binding does not satisfy the lease gate, and fake
            // history rows do not move the slot sequence.
            const ready = await leaseReadyAccount()
            const pending = await openPendingBinding(first, { accountId: ready.accountId })
            expect(refusal(await settle(first.$transaction(async (tx) => {
                await tx.$executeRawUnsafe('CREATE TEMP TABLE "fakeBindings" () INHERITS ("WhatsAppTransportBinding") ON COMMIT DROP')
                await tx.$executeRawUnsafe(
                    `INSERT INTO "fakeBindings" (
                        "bindingId", "transportKind", "transportRef", "transportGeneration", "accountId", "bindingSeq",
                        "trustState", "attestationOrigin", "attestedPnValue", "attestedLidValue", "attestingInstanceId",
                        "attestedUntil", "lastAttestedAt", "openedAt"
                    ) VALUES ($1, 'whatsapp_web_slot', $2, 1, $3, 1, 'verified', 'provider_verified', $4, $5, 'fake',
                        now() + interval '10 minutes', now(), now())`,
                    pending.bindingId,
                    pending.transportRef,
                    ready.accountId,
                    ready.pn,
                    ready.lid,
                )
                await acquire(tx, { accountId: ready.accountId, capability: 'outbound', bindingId: pending.bindingId, instanceId: 'holder-1', seconds: 30 })
            }, TRANSACTION)))).toContain('open, verified and freshly attested')
            const slotRef = newId('slot')
            expect(refusal(await settle(first.$transaction(async (tx) => {
                await tx.$executeRawUnsafe('CREATE TEMP TABLE "fakeHistory" () INHERITS ("WhatsAppTransportBinding") ON COMMIT DROP')
                await tx.$executeRawUnsafe(
                    `INSERT INTO "fakeHistory" (
                        "bindingId", "transportKind", "transportRef", "transportGeneration", "accountId", "bindingSeq",
                        "trustState", "attestationOrigin", "attestingInstanceId", "closedAt", "closeReason"
                    ) VALUES ($1, 'whatsapp_web_slot', $2, 1, $3, 1, 'closed', 'provider_verified', 'fake', now(), 'superseded')`,
                    newId('bind'),
                    slotRef,
                    ready.accountId,
                )
                await openPendingBinding(tx, { accountId: ready.accountId, transportRef: slotRef, bindingSeq: 2, generation: 2 })
            }, TRANSACTION)))).toContain('bindingSeq must be contiguous')
            expect(await readLease(ready.accountId, 'outbound')).toBeUndefined()

            // Accounts: a fake active account row does not let a disabled account acquire a lease.
            expect(await moveLifecycle(first, ready.accountId, 'disabled')).toBe(1)
            expect(refusal(await settle(first.$transaction(async (tx) => {
                await tx.$executeRawUnsafe('CREATE TEMP TABLE "fakeActive" () INHERITS ("WhatsAppAccount") ON COMMIT DROP')
                await tx.$executeRawUnsafe(
                    `INSERT INTO "fakeActive" ("accountId", "accountKind", "lifecycle", "lifecycleVersion", "lifecycleChangedBy", "lifecycleReason")
                    VALUES ($1, 'whatsapp_user', 'active', 1, 'system', 'fake')`,
                    ready.accountId,
                )
                await acquire(tx, { accountId: ready.accountId, capability: 'inbound', bindingId: ready.primary.bindingId, instanceId: 'holder-1', seconds: 30 })
            }, TRANSACTION)))).toContain('requires an active account')
            expect(await readLease(ready.accountId, 'inbound')).toBeUndefined()
        })

        it('refuses every guarded write when a session temp table shadows a foundation table', async () => {
            const shadowed = `WhatsApp account foundation tables must resolve to the schema of`
            const account = await activeAccount()
            const ready = await leaseReadyAccount()

            // Binding guard, with the account table shadowed.
            expect(refusal(await settle(first.$transaction(async (tx) => {
                await tx.$executeRawUnsafe('CREATE TEMP TABLE "WhatsAppAccount" ("accountId" TEXT, "lifecycle" TEXT) ON COMMIT DROP')
                await openPendingBinding(tx, { accountId: account.accountId })
            }, TRANSACTION)))).toContain(`${shadowed} WhatsAppTransportBinding`)

            // Account guard, with the lease table shadowed.
            expect(refusal(await settle(first.$transaction(async (tx) => {
                await tx.$executeRawUnsafe('CREATE TEMP TABLE "WhatsAppCapabilityLease" ("accountId" TEXT, "state" TEXT) ON COMMIT DROP')
                await moveLifecycle(tx, account.accountId, 'disabled')
            }, TRANSACTION)))).toContain(`${shadowed} WhatsAppAccount`)

            // Key guard, with the account table shadowed.
            const keyAccountId = newId('acc')
            expect(refusal(await settle(first.$transaction(async (tx) => {
                await insertAccount(tx, keyAccountId)
                await tx.$executeRawUnsafe('CREATE TEMP TABLE "WhatsAppAccount" ("accountId" TEXT, "lifecycle" TEXT) ON COMMIT DROP')
                await insertKey(tx, keyAccountId, 'whatsapp_pn_user', newKeyValue())
            }, TRANSACTION)))).toContain(`${shadowed} WhatsAppAccountKey`)

            // Deferred key-set guard, with the binding table shadowed only at commit.
            const setAccountId = newId('acc')
            expect(refusal(await settle(first.$transaction(async (tx) => {
                await insertAccount(tx, setAccountId)
                await insertKey(tx, setAccountId, 'whatsapp_pn_user', newKeyValue())
                await insertKey(tx, setAccountId, 'whatsapp_lid_user', newKeyValue())
                await tx.$executeRawUnsafe('CREATE TEMP TABLE "WhatsAppTransportBinding" ("bindingId" TEXT) ON COMMIT DROP')
            }, TRANSACTION)))).toContain(`${shadowed} WhatsAppAccount`)
            expect(await readAccount(setAccountId)).toBeUndefined()

            // Lease guard, with the key table shadowed.
            expect(refusal(await settle(first.$transaction(async (tx) => {
                await tx.$executeRawUnsafe('CREATE TEMP TABLE "WhatsAppAccountKey" ("accountId" TEXT) ON COMMIT DROP')
                await acquire(tx, { accountId: ready.accountId, capability: 'inbound', bindingId: ready.primary.bindingId, instanceId: 'holder-1', seconds: 30 })
            }, TRANSACTION)))).toContain(`${shadowed} WhatsAppCapabilityLease`)

            // A session temp type named like a built-in type cannot run code inside a guard:
            // the guards name their types through SQL keywords. PL/pgSQL compiles a function
            // once per session, so this runs on a new session where the guards compile while
            // the temp type exists.
            const outbound = await leaseReadyAccount(20)
            const lifecycleInShadow = await activeAccount()
            const freshSession = clientFor('wa-account-proof-type-shadow')
            const clampedLease = await freshSession.$transaction(async (tx) => {
                // Any value of this temp type, even the NULL a declared variable starts with, fails.
                await tx.$executeRawUnsafe('CREATE DOMAIN pg_temp.timestamptz AS pg_catalog.timestamptz CHECK (false)')
                const acquired = await acquire(tx, { accountId: outbound.accountId, capability: 'outbound', bindingId: outbound.primary.bindingId, instanceId: 'holder-1', seconds: 60 })
                const pendingInShadow = await openPendingBinding(tx, { accountId: outbound.accountId })
                const attested = await attestBinding(tx, pendingInShadow.bindingId, outbound.pn, outbound.lid)
                // The account and lease update paths compile in this session too.
                const disabled = await moveLifecycle(tx, lifecycleInShadow.accountId, 'disabled')
                const inbound = await acquire(tx, { accountId: outbound.accountId, capability: 'inbound', bindingId: outbound.secondary.bindingId, instanceId: 'holder-2', seconds: 30 })
                const renewed = await renew(tx, { accountId: outbound.accountId, capability: 'inbound', epoch: 1, instanceId: 'holder-2', seconds: 30 })
                const released = await releaseByOperator(tx, outbound.accountId, 'inbound')
                await tx.$executeRawUnsafe('DROP DOMAIN pg_temp.timestamptz')
                return { acquired, attested, disabled, inbound, renewed, released }
            }, TRANSACTION).finally(() => freshSession.$disconnect())
            expect(clampedLease).toEqual({ acquired: 1, attested: 1, disabled: 1, inbound: 1, renewed: 1, released: 1 })
            const outboundLease = await readLease(outbound.accountId, 'outbound')
            const outboundBinding = await readBinding(outbound.primary.bindingId)
            expect(outboundLease.leaseUntil.getTime()).toBe(outboundBinding.attestedUntil!.getTime())

            // Nothing was written, and the same writes pass once the shadow is gone.
            expect(await readLease(ready.accountId, 'inbound')).toBeUndefined()
            expect(await readAccount(account.accountId)).toMatchObject({ lifecycle: 'active' })
            expect(await openPendingBinding(first, { accountId: account.accountId })).toMatchObject({ bindingId: expect.any(String) })
        })
    })

    describe('guard search_path', () => {
        it('works with the production migration path and refuses every guarded write when that path reaches another schema', async () => {
            const beyondOwnSchema = 'guards must run with a search_path of only the schema of'
            const [{ roleSchemaAbsent }] = await observer.$queryRawUnsafe<Array<{ roleSchemaAbsent: boolean }>>(
                'SELECT to_regnamespace(quote_ident(current_user)) IS NULL AS "roleSchemaAbsent"',
            )
            expect(roleSchemaAbsent).toBe(true)
            try {
                // prisma migrate deploy without a schema parameter stores "$user", <schema>. With no
                // schema named after the writing role, every guard runs and admits legitimate writes.
                await pinGuards(GUARD_FUNCTIONS, 'role_schema_first')
                const production = await activeAccount()
                const productionBinding = await openBinding(first, { ...production })
                expect(await acquire(first, { accountId: production.accountId, capability: 'inbound', bindingId: productionBinding.bindingId, instanceId: 'holder-1', seconds: 30 })).toBe(1)
                await pinGuards(GUARD_FUNCTIONS, 'own_schema')

                // Any other schema on the path, such as one named after the writing role, makes each
                // guard refuse. public stands in for that schema.
                const account = await activeAccount()
                const ready = await leaseReadyAccount()

                await pinGuards(['whatsapp_account_guard'], 'public_first')
                expect(refusal(await settle(moveLifecycle(first, account.accountId, 'disabled')))).toContain(`${beyondOwnSchema} WhatsAppAccount`)
                await pinGuards(['whatsapp_account_guard'], 'own_schema')

                await pinGuards(['whatsapp_account_key_guard'], 'public_first')
                const keyAccountId = newId('acc')
                expect(refusal(await settle(first.$transaction(async (tx) => {
                    await insertAccount(tx, keyAccountId)
                    await insertKey(tx, keyAccountId, 'whatsapp_pn_user', newKeyValue())
                }, TRANSACTION)))).toContain(`${beyondOwnSchema} WhatsAppAccountKey`)
                await pinGuards(['whatsapp_account_key_guard'], 'own_schema')

                await pinGuards(['whatsapp_account_key_set_guard'], 'public_first')
                const setAccountId = newId('acc')
                expect(refusal(await settle(first.$transaction(async (tx) => {
                    await insertAccount(tx, setAccountId)
                    await insertKey(tx, setAccountId, 'whatsapp_pn_user', newKeyValue())
                    await insertKey(tx, setAccountId, 'whatsapp_lid_user', newKeyValue())
                }, TRANSACTION)))).toContain(`${beyondOwnSchema} WhatsAppAccount`)
                await pinGuards(['whatsapp_account_key_set_guard'], 'own_schema')

                await pinGuards(['whatsapp_transport_binding_guard'], 'public_first')
                expect(refusal(await settle(openPendingBinding(first, { accountId: account.accountId })))).toContain(`${beyondOwnSchema} WhatsAppTransportBinding`)
                await pinGuards(['whatsapp_transport_binding_guard'], 'own_schema')

                await pinGuards(['whatsapp_capability_lease_guard'], 'public_first')
                expect(refusal(await settle(acquire(first, { accountId: ready.accountId, capability: 'inbound', bindingId: ready.primary.bindingId, instanceId: 'holder-1', seconds: 30 }))))
                    .toContain(`${beyondOwnSchema} WhatsAppCapabilityLease`)
                await pinGuards(['whatsapp_capability_lease_guard'], 'own_schema')

                expect(await readAccount(keyAccountId)).toBeUndefined()
                expect(await readAccount(setAccountId)).toBeUndefined()
                expect(await readAccount(account.accountId)).toMatchObject({ lifecycle: 'active' })
                expect(await readLease(ready.accountId, 'inbound')).toBeUndefined()
            } finally {
                await pinGuards(GUARD_FUNCTIONS, 'own_schema')
            }
        })
    })

    describe('transaction isolation and session state', () => {
        it('refuses foundation writes outside READ COMMITTED, so an older snapshot cannot bypass a guard', async () => {
            const readCommittedOnly = 'WhatsApp account foundation writes require READ COMMITTED isolation'
            const account = await activeAccount()
            const ready = await leaseReadyAccount()
            for (const isolationLevel of ['RepeatableRead', 'Serializable'] as const) {
                expect(refusal(await settle(first.$transaction(
                    (tx) => moveLifecycle(tx, account.accountId, 'disabled'),
                    { ...TRANSACTION, isolationLevel },
                )))).toContain(readCommittedOnly)
                expect(refusal(await settle(first.$transaction(
                    (tx) => openPendingBinding(tx, { accountId: account.accountId }),
                    { ...TRANSACTION, isolationLevel },
                )))).toContain(readCommittedOnly)
                expect(refusal(await settle(first.$transaction(
                    (tx) => acquire(tx, { accountId: ready.accountId, capability: 'inbound', bindingId: ready.primary.bindingId, instanceId: 'holder-1', seconds: 30 }),
                    { ...TRANSACTION, isolationLevel },
                )))).toContain(readCommittedOnly)
            }

            // The race that motivated it: a REPEATABLE READ transaction whose snapshot predates a
            // committed lease cannot then disable the account.
            let snapshotTaken!: () => void
            let leaseCommitted!: () => void
            const taken = new Promise<void>((resolve) => { snapshotTaken = resolve })
            const committed = new Promise<void>((resolve) => { leaseCommitted = resolve })
            const stale = settle(second.$transaction(async (tx) => {
                await tx.$queryRawUnsafe('SELECT 1 AS "snapshot" FROM "WhatsAppAccount" LIMIT 1')
                snapshotTaken()
                await committed
                await moveLifecycle(tx, ready.accountId, 'disabled')
            }, { ...TRANSACTION, isolationLevel: 'RepeatableRead' }))
            await taken
            expect(await acquire(first, { accountId: ready.accountId, capability: 'inbound', bindingId: ready.primary.bindingId, instanceId: 'holder-1', seconds: 60 })).toBe(1)
            leaseCommitted()
            expect(refusal(await stale)).toContain(readCommittedOnly)
            expect(await readAccount(ready.accountId)).toMatchObject({ lifecycle: 'active' })
        })

        it('counts a holder declaration only for the transaction that makes it', async () => {
            const ready = await leaseReadyAccount()
            await acquire(first, { accountId: ready.accountId, capability: 'inbound', bindingId: ready.primary.bindingId, instanceId: 'holder-1', seconds: 60 })
            await acquire(first, { accountId: ready.accountId, capability: 'history_import', bindingId: ready.primary.bindingId, instanceId: 'holder-1', seconds: 60 })

            // A pooled connection that once declared the holder at session scope.
            const leaky = clientFor('wa-account-proof-leaky-holder', 1)
            try {
                await leaky.$executeRawUnsafe("SET yoko.whatsapp_lease_holder = 'holder-1'")
                expect(await releaseByOperator(leaky, ready.accountId, 'inbound')).toBe(1)
                const plain = await readLease(ready.accountId, 'inbound')
                expect(secondsBetween(plain.fenceUntil, plain.dbNow)).toBeGreaterThan(50)

                // A declaration carrying some other transaction id does not count either.
                await leaky.$executeRawUnsafe("SET yoko.whatsapp_lease_holder = 'holder-1:1'")
                expect(await releaseByOperator(leaky, ready.accountId, 'history_import')).toBe(1)
                const earlier = await readLease(ready.accountId, 'history_import')
                expect(secondsBetween(earlier.fenceUntil, earlier.dbNow)).toBeGreaterThan(50)
            } finally {
                await leaky.$disconnect()
            }
        })

        it('refuses a successor while the predecessor on the slot is still open, even if its close is in flight', async () => {
            const account = await activeAccount()
            const rival = await activeAccount()
            const predecessor = await openBinding(first, { ...account })
            const successor = { accountId: rival.accountId, pn: rival.pn, lid: rival.lid, transportRef: predecessor.transportRef, bindingSeq: 2, generation: 2 }

            // The close is uncommitted when the rival pairing reads the slot history.
            const inFlight = await whileUncommitted(
                (tx) => closeBinding(tx, predecessor.bindingId, 'mismatched', 'account_changed'),
                () => settle(second.$transaction((tx) => openBinding(tx, successor), TRANSACTION)),
            )
            expect(inFlight.lead).toEqual({ ok: true })
            expect(refusal(inFlight.attempt)).toContain('cannot open while another binding on the transport is open')

            // Once the close is committed, the same pairing opens the next generation.
            expect(await openBinding(first, successor)).toMatchObject({ transportRef: predecessor.transportRef })
            const [ordering] = await observer.$queryRawUnsafe<Array<{ ordered: boolean }>>(
                `SELECT bool_and(next."openedAt" >= previous."closedAt") AS "ordered"
                FROM "WhatsAppTransportBinding" previous
                JOIN "WhatsAppTransportBinding" next
                    ON next."transportRef" = previous."transportRef" AND next."bindingSeq" = previous."bindingSeq" + 1
                WHERE previous."transportRef" = $1`,
                predecessor.transportRef,
            )
            expect(ordering).toEqual({ ordered: true })
        })

        it('stamps an operator confirmation when its statement runs, after the claim it confirms', async () => {
            const account = await activeAccount()
            const claim = await openAssertedBinding(first, account.accountId, account.pn, null)
            let started!: () => void
            let completed!: () => void
            const operatorStarted = new Promise<void>((resolve) => { started = resolve })
            const claimCompleted = new Promise<void>((resolve) => { completed = resolve })
            const operator = second.$transaction(async (tx) => {
                const [{ startedAt }] = await tx.$queryRawUnsafe<Array<{ startedAt: Date }>>('SELECT now() AS "startedAt"')
                started()
                await claimCompleted
                await confirmBinding(tx, claim.bindingId)
                return startedAt
            }, TRANSACTION)
            await operatorStarted
            await pause(300)
            expect(await setClaimedLid(first, claim.bindingId, account.lid)).toBe(1)
            completed()
            const operatorStartedAt = await operator
            const [row] = await observer.$queryRawUnsafe<Array<{ operatorConfirmedAt: Date }>>(
                'SELECT "operatorConfirmedAt" FROM "WhatsAppTransportBinding" WHERE "bindingId" = $1',
                claim.bindingId,
            )
            expect(row.operatorConfirmedAt.getTime() - operatorStartedAt.getTime()).toBeGreaterThanOrEqual(250)

            // A confirmation recorded by the insert that opens the binding is stamped by that statement too.
            const confirmedAtInsert = newId('bind')
            const insertStartedAt = await second.$transaction(async (tx) => {
                const [{ startedAt }] = await tx.$queryRawUnsafe<Array<{ startedAt: Date }>>('SELECT now() AS "startedAt"')
                await pause(300)
                await tx.$executeRawUnsafe(
                    `INSERT INTO "WhatsAppTransportBinding" (
                        "bindingId", "transportKind", "transportRef", "transportGeneration", "accountId", "bindingSeq",
                        "trustState", "attestationOrigin", "claimedPnValue", "claimedLidValue", "attestingInstanceId",
                        "operatorConfirmedAt", "operatorConfirmedBy"
                    ) VALUES ($1, 'whatsapp_web_slot', $2, 1, $3, 1, 'pending', 'transport_asserted', $4, $5, 'attester-1',
                        now(), 'operator-1')`,
                    confirmedAtInsert,
                    newId('slot'),
                    account.accountId,
                    account.pn,
                    account.lid,
                )
                return startedAt
            }, TRANSACTION)
            const [inserted] = await observer.$queryRawUnsafe<Array<{ operatorConfirmedAt: Date }>>(
                'SELECT "operatorConfirmedAt" FROM "WhatsAppTransportBinding" WHERE "bindingId" = $1',
                confirmedAtInsert,
            )
            expect(inserted.operatorConfirmedAt.getTime() - insertStartedAt.getTime()).toBeGreaterThanOrEqual(250)
        })

        it('refuses attestation, confirmation and slot history recorded from a transaction older than the binding', async () => {
            const account = await activeAccount()
            const olderThanBinding = 'WhatsAppTransportBinding_attestation_check'
            let olderStarted!: () => void
            let newerDone!: () => void
            const started = new Promise<void>((resolve) => { olderStarted = resolve })
            const done = new Promise<void>((resolve) => { newerDone = resolve })

            const verified = await openBinding(first, { ...account })
            let opened!: BindingFixture
            let asserted!: BindingFixture
            const older = settle(second.$transaction(async (tx) => {
                await tx.$queryRawUnsafe('SELECT now() AS "startedAt"')
                olderStarted()
                await done
                // Verify the binding opened after this transaction began.
                await tx.$executeRawUnsafe(
                    `UPDATE "WhatsAppTransportBinding"
                    SET "trustState" = 'verified', "attestedPnValue" = $2, "attestedLidValue" = $3,
                        "attestedUntil" = now() + interval '40 minutes'
                    WHERE "bindingId" = $1`,
                    opened.bindingId,
                    account.pn,
                    account.lid,
                )
            }, TRANSACTION))
            await started
            await pause(50)
            expect(await closeBinding(first, verified.bindingId, 'closed', 'superseded')).toBe(1)
            opened = await openPendingBinding(first, { accountId: account.accountId, transportRef: verified.transportRef, bindingSeq: 2, generation: 2 })
            newerDone()
            expect(refusal(await older)).toContain(olderThanBinding)

            // A confirmation from an older transaction is stamped when its statement runs, so it
            // is never recorded as older than the binding it confirms.
            const confirmStarted = deferredSignal()
            const confirmDone = deferredSignal()
            const olderConfirm = settle(second.$transaction(async (tx) => {
                await tx.$queryRawUnsafe('SELECT now() AS "startedAt"')
                confirmStarted.resolve()
                await confirmDone.promise
                await confirmBinding(tx, asserted.bindingId)
            }, TRANSACTION))
            await confirmStarted.promise
            await pause(50)
            asserted = await openAssertedBinding(first, account.accountId, account.pn, account.lid)
            confirmDone.resolve()
            expect(await olderConfirm).toEqual({ ok: true })
            const [confirmation] = await observer.$queryRawUnsafe<Array<{ notOlder: boolean }>>(
                'SELECT "operatorConfirmedAt" >= "openedAt" AS "notOlder" FROM "WhatsAppTransportBinding" WHERE "bindingId" = $1',
                asserted.bindingId,
            )
            expect(confirmation).toEqual({ notOlder: true })

            // A new binding opened from a transaction older than the previous binding's close.
            const slotStarted = deferredSignal()
            const slotDone = deferredSignal()
            const olderOpen = settle(second.$transaction(async (tx) => {
                await tx.$queryRawUnsafe('SELECT now() AS "startedAt"')
                slotStarted.resolve()
                await slotDone.promise
                await openBinding(tx, { ...account, transportRef: verified.transportRef, bindingSeq: 3, generation: 3 })
            }, TRANSACTION))
            await slotStarted.promise
            await pause(50)
            expect(await closeBinding(first, opened.bindingId, 'mismatched', 'account_changed')).toBe(1)
            slotDone.resolve()
            expect(refusal(await olderOpen)).toContain('cannot open: the latest slot history is newer than this transaction')
            expect(await readSlotHistory(verified.transportRef)).toEqual([
                { bindingSeq: 1, generation: 1 },
                { bindingSeq: 2, generation: 2 },
            ])
        })
    })

    describe('history order', () => {
        it('refuses a claim, a close, a lifecycle change or a new binding from a transaction older than the history it follows', async () => {
            const account = await activeAccount()
            const closedBeforeHistory = 'WhatsAppTransportBinding_trust_check'

            // A close of a binding opened, attested or confirmed after the closing transaction began.
            let opened!: BindingFixture
            expect(refusal(await fromOlderTransaction(
                async () => { opened = await openPendingBinding(first, { accountId: account.accountId }) },
                (tx) => closeBinding(tx, opened.bindingId, 'mismatched', 'account_changed'),
            ))).toContain(closedBeforeHistory)
            const attested = await openPendingBinding(first, { accountId: account.accountId })
            expect(refusal(await fromOlderTransaction(
                () => attestBinding(first, attested.bindingId, account.pn, account.lid),
                (tx) => closeBinding(tx, attested.bindingId, 'revoked', 'revoked_by_operator'),
            ))).toContain(closedBeforeHistory)
            const confirmed = await openAssertedBinding(first, account.accountId, account.pn, account.lid)
            expect(refusal(await fromOlderTransaction(
                () => confirmBinding(first, confirmed.bindingId),
                (tx) => closeBinding(tx, confirmed.bindingId, 'closed', 'superseded'),
            ))).toContain(closedBeforeHistory)
            expect(await closeBinding(first, opened.bindingId, 'mismatched', 'account_changed')).toBe(1)
            expect(await closeBinding(first, attested.bindingId, 'revoked', 'revoked_by_operator')).toBe(1)
            expect(await closeBinding(first, confirmed.bindingId, 'closed', 'superseded')).toBe(1)

            // A claim of either half on a binding opened after the claiming transaction began.
            const claimFromOlder = 'claim cannot be recorded from a transaction that started before the binding opened'
            let pnClaimed!: BindingFixture
            expect(refusal(await fromOlderTransaction(
                async () => { pnClaimed = await openPendingBinding(first, { accountId: account.accountId }) },
                (tx) => setClaimedPn(tx, pnClaimed.bindingId, account.pn),
            ))).toContain(claimFromOlder)
            let lidClaimed!: BindingFixture
            expect(refusal(await fromOlderTransaction(
                async () => { lidClaimed = await openPendingBinding(first, { accountId: account.accountId }) },
                (tx) => setClaimedLid(tx, lidClaimed.bindingId, account.lid),
            ))).toContain(claimFromOlder)
            expect(await setClaimedPn(first, pnClaimed.bindingId, account.pn)).toBe(1)
            expect(await setClaimedLid(first, lidClaimed.bindingId, account.lid)).toBe(1)

            // A lifecycle change from a transaction that started before the latest one.
            expect(refusal(await fromOlderTransaction(
                () => moveLifecycle(first, account.accountId, 'disabled'),
                (tx) => moveLifecycle(tx, account.accountId, 'active'),
            ))).toContain('started before its latest lifecycle change')
            expect(await readAccount(account.accountId)).toMatchObject({ lifecycle: 'disabled', lifecycleVersion: 3 })

            // A new binding from a transaction that started before its account was created.
            let created!: AccountFixture
            expect(refusal(await fromOlderTransaction(
                async () => { created = await createAccount() },
                (tx) => openPendingBinding(tx, { accountId: created.accountId }),
            ))).toContain('started before its account was created')
            expect(await openPendingBinding(first, { accountId: created.accountId })).toMatchObject({ bindingId: expect.any(String) })
        })
    })

    describe('two-connection interleavings', () => {
        it('two competing first acquisitions leave exactly one holder', async () => {
            const ready = await leaseReadyAccount()
            const { lead, follow } = await interleave(
                (tx) => acquire(tx, { accountId: ready.accountId, capability: 'outbound', bindingId: ready.primary.bindingId, instanceId: 'holder-1', seconds: 30 }),
                (tx) => acquire(tx, { accountId: ready.accountId, capability: 'outbound', bindingId: ready.secondary.bindingId, instanceId: 'holder-2', seconds: 30 }),
            )
            expect(lead).toEqual({ ok: true })
            expect(refusal(follow)).toMatch(/23505|duplicate key/u)
            expect(await readLease(ready.accountId, 'outbound')).toMatchObject({ epoch: 1, version: 1, holderInstanceId: 'holder-1' })
        })

        it('acquire against binding close: the loser is refused in both orders', async () => {
            const acquireFirst = await leaseReadyAccount()
            const one = await interleave(
                (tx) => acquire(tx, { accountId: acquireFirst.accountId, capability: 'outbound', bindingId: acquireFirst.primary.bindingId, instanceId: 'holder-1', seconds: 30 }),
                (tx) => closeBinding(tx, acquireFirst.primary.bindingId, 'mismatched', 'account_changed'),
            )
            expect(one.lead).toEqual({ ok: true })
            expect(refusal(one.follow)).toContain('cannot close or leave verified while it holds a capability lease')
            expect(await readBinding(acquireFirst.primary.bindingId)).toMatchObject({ trustState: 'verified' })

            const closeFirst = await leaseReadyAccount()
            const two = await interleave(
                (tx) => closeBinding(tx, closeFirst.primary.bindingId, 'mismatched', 'account_changed'),
                (tx) => acquire(tx, { accountId: closeFirst.accountId, capability: 'outbound', bindingId: closeFirst.primary.bindingId, instanceId: 'holder-1', seconds: 30 }),
            )
            expect(two.lead).toEqual({ ok: true })
            expect(refusal(two.follow)).toContain('open, verified and freshly attested')
            expect(await readLease(closeFirst.accountId, 'outbound')).toBeUndefined()
        })

        it('acquire against account disable: the loser is refused in both orders', async () => {
            const acquireFirst = await leaseReadyAccount()
            const one = await interleave(
                (tx) => acquire(tx, { accountId: acquireFirst.accountId, capability: 'inbound', bindingId: acquireFirst.primary.bindingId, instanceId: 'holder-1', seconds: 30 }),
                (tx) => moveLifecycle(tx, acquireFirst.accountId, 'disabled'),
            )
            expect(one.lead).toEqual({ ok: true })
            expect(refusal(one.follow)).toContain('cannot leave active while a capability lease is held')
            expect(await readAccount(acquireFirst.accountId)).toMatchObject({ lifecycle: 'active' })

            const disableFirst = await leaseReadyAccount()
            const two = await interleave(
                (tx) => moveLifecycle(tx, disableFirst.accountId, 'disabled'),
                (tx) => acquire(tx, { accountId: disableFirst.accountId, capability: 'inbound', bindingId: disableFirst.primary.bindingId, instanceId: 'holder-1', seconds: 30 }),
            )
            expect(two.lead).toEqual({ ok: true })
            expect(refusal(two.follow)).toContain('requires an active account')
            expect(await readLease(disableFirst.accountId, 'inbound')).toBeUndefined()
        })

        it('renew against binding trust downgrade: never a held lease on a downgraded binding', async () => {
            const renewal = (accountId: string) => ({ accountId, capability: 'inbound' as const, epoch: 1, instanceId: 'holder-1', seconds: 90 })

            // Reviewed order on both sides: account row, then lease, then binding.
            const renewFirst = await leaseReadyAccount()
            await acquire(first, { ...renewal(renewFirst.accountId), bindingId: renewFirst.primary.bindingId, seconds: 30 })
            let renewed = -1
            const one = await interleave(
                async (tx) => {
                    await lockAccount(tx, renewFirst.accountId)
                    renewed = await renew(tx, renewal(renewFirst.accountId))
                },
                async (tx) => {
                    await lockAccount(tx, renewFirst.accountId)
                    expect(await releaseByOperator(tx, renewFirst.accountId, 'inbound')).toBe(1)
                    expect(await closeBinding(tx, renewFirst.primary.bindingId, 'revoked', 'credential_invalid')).toBe(1)
                },
            )
            expect(one).toEqual({ lead: { ok: true }, follow: { ok: true } })
            expect(renewed).toBe(1)
            const quarantined = await readLease(renewFirst.accountId, 'inbound')
            expect(quarantined).toMatchObject({ state: 'released', version: 3 })
            // The downgrade waited for the renewal, so its quarantine covers the renewed window.
            expect(secondsBetween(quarantined.fenceUntil, quarantined.dbNow)).toBeGreaterThan(75)
            expect(await readBinding(renewFirst.primary.bindingId)).toMatchObject({ trustState: 'revoked' })

            const downgradeFirst = await leaseReadyAccount()
            await acquire(first, { ...renewal(downgradeFirst.accountId), bindingId: downgradeFirst.primary.bindingId, seconds: 30 })
            let lateRenewal = -1
            const two = await interleave(
                async (tx) => {
                    await lockAccount(tx, downgradeFirst.accountId)
                    await releaseByOperator(tx, downgradeFirst.accountId, 'inbound')
                    await closeBinding(tx, downgradeFirst.primary.bindingId, 'mismatched', 'account_changed')
                },
                async (tx) => {
                    await lockAccount(tx, downgradeFirst.accountId)
                    lateRenewal = await renew(tx, renewal(downgradeFirst.accountId))
                },
            )
            expect(two).toEqual({ lead: { ok: true }, follow: { ok: true } })
            expect(lateRenewal).toBe(0)
            expect(await readLease(downgradeFirst.accountId, 'inbound')).toMatchObject({ state: 'released', version: 2 })

            // Without the caller taking the account row, the trigger lock still serializes renew and close.
            const bare = await leaseReadyAccount()
            await acquire(first, { ...renewal(bare.accountId), bindingId: bare.primary.bindingId, seconds: 30 })
            const three = await interleave(
                (tx) => renew(tx, renewal(bare.accountId)),
                (tx) => closeBinding(tx, bare.primary.bindingId, 'revoked', 'credential_invalid'),
            )
            expect(three.lead).toEqual({ ok: true })
            expect(refusal(three.follow)).toContain('cannot close or leave verified while it holds a capability lease')
        })

        it('renew against takeover of an expired lease: exactly one epoch wins in both orders', async () => {
            const renewal = (accountId: string) => ({ accountId, capability: 'inbound' as const, epoch: 1, instanceId: 'holder-1', seconds: 60 })
            const takeoverOf = (ready: { accountId: string; secondary: BindingFixture }) => ({
                accountId: ready.accountId,
                capability: 'inbound' as const,
                fromEpoch: 1,
                bindingId: ready.secondary.bindingId,
                instanceId: 'holder-2',
                seconds: 60,
            })

            const renewFirst = await leaseReadyAccount()
            const takeoverFirst = await leaseReadyAccount()
            for (const ready of [renewFirst, takeoverFirst]) {
                await acquire(first, { ...renewal(ready.accountId), bindingId: ready.primary.bindingId, seconds: 1 })
            }
            await pause(1_300)

            const one = await interleave(
                (tx) => renew(tx, renewal(renewFirst.accountId)),
                (tx) => takeover(tx, takeoverOf(renewFirst)),
            )
            expect(one.lead).toEqual({ ok: true })
            expect(refusal(one.follow)).toContain('before the held lease expires')
            expect(await readLease(renewFirst.accountId, 'inbound')).toMatchObject({ epoch: 1, version: 2, holderInstanceId: 'holder-1' })

            let staleRenewal = -1
            const two = await interleave(
                (tx) => takeover(tx, takeoverOf(takeoverFirst)),
                async (tx) => { staleRenewal = await renew(tx, renewal(takeoverFirst.accountId)) },
            )
            expect(two).toEqual({ lead: { ok: true }, follow: { ok: true } })
            expect(staleRenewal).toBe(0)
            expect(await readLease(takeoverFirst.accountId, 'inbound')).toMatchObject({ epoch: 2, version: 2, holderInstanceId: 'holder-2' })
        })

        it('an authority-scoped read holds off a release until its transaction ends', async () => {
            const ready = await leaseReadyAccount()
            const current = { accountId: ready.accountId, capability: 'outbound' as const, epoch: 1, instanceId: 'holder-1', bindingId: ready.primary.bindingId }
            await acquire(first, { ...current, seconds: 30 })
            let authorized = false
            const { lead, follow } = await interleave(
                async (tx) => { authorized = await holdsAuthority(tx, current) },
                (tx) => releaseByOperator(tx, ready.accountId, 'outbound'),
            )
            expect(authorized).toBe(true)
            expect(lead).toEqual({ ok: true })
            expect(follow).toEqual({ ok: true })
            expect(await readLease(ready.accountId, 'outbound')).toMatchObject({ state: 'released' })
        })

        it('retire against opening a binding: the loser is refused in both orders', async () => {
            const retireFirst = await activeAccount()
            await moveLifecycle(first, retireFirst.accountId, 'disabled')
            const one = await interleave(
                (tx) => moveLifecycle(tx, retireFirst.accountId, 'retired'),
                (tx) => openPendingBinding(tx, { accountId: retireFirst.accountId }),
            )
            expect(one.lead).toEqual({ ok: true })
            expect(refusal(one.follow)).toContain('cannot open for a missing or retired account')

            const openFirst = await activeAccount()
            await moveLifecycle(first, openFirst.accountId, 'disabled')
            const two = await interleave(
                (tx) => openPendingBinding(tx, { accountId: openFirst.accountId }),
                (tx) => moveLifecycle(tx, openFirst.accountId, 'retired'),
            )
            expect(two.lead).toEqual({ ok: true })
            expect(refusal(two.follow)).toContain('cannot retire while a transport binding is open')
            expect(await readAccount(openFirst.accountId)).toMatchObject({ lifecycle: 'disabled' })
        })
    })

    describe('slot history under concurrency', () => {
        it('racing new bindings on one slot: exactly one takes the next sequence and generation', async () => {
            const account = await activeAccount()
            const rival = await activeAccount()
            const seventh = await openBinding(first, { ...account, generation: 7 })
            expect(await closeBinding(first, seventh.bindingId, 'closed', 'logged_out')).toBe(1)
            const slot = { transportRef: seventh.transportRef }
            const closeSeq = async (bindingSeq: number): Promise<void> => {
                const [row] = await observer.$queryRawUnsafe<Array<{ bindingId: string }>>(
                    'SELECT "bindingId" FROM "WhatsAppTransportBinding" WHERE "transportRef" = $1 AND "bindingSeq" = $2::int',
                    slot.transportRef,
                    bindingSeq,
                )
                expect(await closeBinding(first, row.bindingId, 'closed', 'logged_out')).toBe(1)
            }

            // Same account, same generation: the account row lock serializes the two
            // pairings, and the loser then sees the committed history.
            const sameAccount = await interleave(
                (tx) => openPendingBinding(tx, { ...slot, accountId: account.accountId, bindingSeq: 2, generation: 8 }),
                (tx) => openPendingBinding(tx, { ...slot, accountId: account.accountId, bindingSeq: 2, generation: 8 }),
            )
            expect(sameAccount.lead).toEqual({ ok: true })
            expect(refusal(sameAccount.follow)).toContain(HISTORY_MUST_ADVANCE)
            await closeSeq(2)

            // Different accounts, same generation: the account row locks do not serialize
            // the triggers, so a unique slot index refuses the loser after it waits.
            const rivalSameGeneration = await interleave(
                (tx) => openPendingBinding(tx, { ...slot, accountId: account.accountId, bindingSeq: 3, generation: 9 }),
                (tx) => openPendingBinding(tx, { ...slot, accountId: rival.accountId, bindingSeq: 3, generation: 9 }),
            )
            expect(rivalSameGeneration.lead).toEqual({ ok: true })
            expect(refusal(rivalSameGeneration.follow)).toContain(SEQUENCE_TAKEN)
            await closeSeq(3)

            // Different accounts, and the loser carries a lower generation than the winner:
            // it cannot slip in behind the winner's newer generation.
            const rivalOtherGeneration = await interleave(
                (tx) => openPendingBinding(tx, { ...slot, accountId: account.accountId, bindingSeq: 4, generation: 11 }),
                (tx) => openPendingBinding(tx, { ...slot, accountId: rival.accountId, bindingSeq: 4, generation: 10 }),
            )
            expect(rivalOtherGeneration.lead).toEqual({ ok: true })
            expect(refusal(rivalOtherGeneration.follow)).toContain(SEQUENCE_TAKEN)
            await closeSeq(4)

            // A leader that closes its new binding before committing still owns that sequence,
            // so a rival with a lower generation cannot fork the history behind it.
            const closedLeader = await interleave(
                async (tx) => {
                    const lead = await openPendingBinding(tx, { ...slot, accountId: account.accountId, bindingSeq: 5, generation: 13 })
                    await closeBinding(tx, lead.bindingId, 'mismatched', 'account_changed')
                },
                (tx) => openPendingBinding(tx, { ...slot, accountId: rival.accountId, bindingSeq: 5, generation: 12 }),
            )
            expect(closedLeader.lead).toEqual({ ok: true })
            expect(refusal(closedLeader.follow)).toContain(SEQUENCE_TAKEN)

            // A successor of an uncommitted binding cannot fork the history.
            const fork = await whileUncommitted(
                (tx) => openPendingBinding(tx, { ...slot, accountId: account.accountId, bindingSeq: 6, generation: 14 }),
                () => settle(second.$transaction(async (tx) => {
                    await openPendingBinding(tx, { ...slot, accountId: rival.accountId, bindingSeq: 7, generation: 15 })
                }, TRANSACTION)),
            )
            expect(fork.lead).toEqual({ ok: true })
            expect(refusal(fork.attempt)).toContain('bindingSeq must be contiguous')

            expect(await readSlotHistory(slot.transportRef)).toEqual([
                { bindingSeq: 1, generation: 7 },
                { bindingSeq: 2, generation: 8 },
                { bindingSeq: 3, generation: 9 },
                { bindingSeq: 4, generation: 11 },
                { bindingSeq: 5, generation: 13 },
                { bindingSeq: 6, generation: 14 },
            ])
        })
    })

    describe('inert, isolated foundation', () => {
        it('relates only within the four tables: no Contact, ChannelIdentity or WhatsAppConnection relation', async () => {
            const relations = await observer.$queryRawUnsafe<Array<{ fromTable: string; constraintName: string; toTable: string }>>(
                `SELECT src.relname AS "fromTable", con.conname AS "constraintName", dst.relname AS "toTable"
                FROM pg_constraint con
                JOIN pg_class src ON src.oid = con.conrelid
                JOIN pg_class dst ON dst.oid = con.confrelid
                JOIN pg_namespace ns ON ns.oid = src.relnamespace
                WHERE con.contype = 'f'
                    AND ns.nspname = current_schema()
                    AND (src.relname = ANY($1::text[]) OR dst.relname = ANY($1::text[]))
                ORDER BY con.conname COLLATE "C"`,
                NEW_TABLES,
            )
            expect(relations).toEqual([
                { fromTable: 'WhatsAppAccountKey', constraintName: 'WhatsAppAccountKey_accountId_fkey', toTable: 'WhatsAppAccount' },
                { fromTable: 'WhatsAppCapabilityLease', constraintName: 'WhatsAppCapabilityLease_accountId_fkey', toTable: 'WhatsAppAccount' },
                { fromTable: 'WhatsAppCapabilityLease', constraintName: 'WhatsAppCapabilityLease_holderBindingId_accountId_fkey', toTable: 'WhatsAppTransportBinding' },
                { fromTable: 'WhatsAppTransportBinding', constraintName: 'WhatsAppTransportBinding_accountId_fkey', toTable: 'WhatsAppAccount' },
                { fromTable: 'WhatsAppTransportBinding', constraintName: LID_KEY_PROOF, toTable: 'WhatsAppAccountKey' },
                { fromTable: 'WhatsAppTransportBinding', constraintName: PN_KEY_PROOF, toTable: 'WhatsAppAccountKey' },
            ])
        })

        it('pins the search_path of every foundation function to the schema it was created in', async () => {
            // Asserted on the pins read before the guard search_path tests re-pinned any guard.
            expect(migrationPins).toEqual([
                'whatsapp_account_foundation_resolves',
                'whatsapp_account_foundation_truncate_guard',
                'whatsapp_account_guard',
                'whatsapp_account_key_guard',
                'whatsapp_account_key_set_guard',
                'whatsapp_capability_lease_guard',
                'whatsapp_transport_binding_guard',
            ].map((functionName) => ({ functionName, pinned: true })))
        })

        it('declares the uniqueness that backs identity, key ownership, open bindings and slot history', async () => {
            const indexes = await observer.$queryRawUnsafe<Array<{ indexName: string; definition: string }>>(
                `SELECT indexname AS "indexName", regexp_replace(indexdef, ' ON [^ ]+ USING ', ' USING ') AS "definition"
                FROM pg_indexes
                WHERE schemaname = current_schema() AND tablename = ANY($1::text[])
                ORDER BY indexname COLLATE "C"`,
                NEW_TABLES,
            )
            expect(indexes).toEqual([
                { indexName: 'WhatsAppAccountKey_accountId_keyKind_key', definition: 'CREATE UNIQUE INDEX "WhatsAppAccountKey_accountId_keyKind_key" USING btree ("accountId", "keyKind")' },
                { indexName: 'WhatsAppAccountKey_keyKind_keyValue_accountId_key', definition: 'CREATE UNIQUE INDEX "WhatsAppAccountKey_keyKind_keyValue_accountId_key" USING btree ("keyKind", "keyValue", "accountId")' },
                { indexName: 'WhatsAppAccountKey_pkey', definition: 'CREATE UNIQUE INDEX "WhatsAppAccountKey_pkey" USING btree ("keyKind", "keyValue")' },
                { indexName: 'WhatsAppAccount_pkey', definition: 'CREATE UNIQUE INDEX "WhatsAppAccount_pkey" USING btree ("accountId")' },
                { indexName: 'WhatsAppCapabilityLease_holderBindingId_idx', definition: 'CREATE INDEX "WhatsAppCapabilityLease_holderBindingId_idx" USING btree ("holderBindingId")' },
                { indexName: 'WhatsAppCapabilityLease_pkey', definition: 'CREATE UNIQUE INDEX "WhatsAppCapabilityLease_pkey" USING btree ("accountId", capability)' },
                { indexName: 'WhatsAppTransportBinding_accountId_idx', definition: 'CREATE INDEX "WhatsAppTransportBinding_accountId_idx" USING btree ("accountId")' },
                { indexName: 'WhatsAppTransportBinding_bindingId_accountId_key', definition: 'CREATE UNIQUE INDEX "WhatsAppTransportBinding_bindingId_accountId_key" USING btree ("bindingId", "accountId")' },
                { indexName: 'WhatsAppTransportBinding_open_transport_key', definition: 'CREATE UNIQUE INDEX "WhatsAppTransportBinding_open_transport_key" USING btree ("transportKind", "transportRef") WHERE ("closedAt" IS NULL)' },
                { indexName: 'WhatsAppTransportBinding_pkey', definition: 'CREATE UNIQUE INDEX "WhatsAppTransportBinding_pkey" USING btree ("bindingId")' },
                { indexName: 'WhatsAppTransportBinding_transportKind_transportRef_binding_key', definition: 'CREATE UNIQUE INDEX "WhatsAppTransportBinding_transportKind_transportRef_binding_key" USING btree ("transportKind", "transportRef", "bindingSeq")' },
                { indexName: 'WhatsAppTransportBinding_transportKind_transportRef_transpo_key', definition: 'CREATE UNIQUE INDEX "WhatsAppTransportBinding_transportKind_transportRef_transpo_key" USING btree ("transportKind", "transportRef", "transportGeneration")' },
            ])
        })

        it('installs its guards only on the four new tables', async () => {
            const triggers = await observer.$queryRawUnsafe<Array<{ tableName: string; triggerName: string }>>(
                `SELECT cls.relname AS "tableName", tg.tgname AS "triggerName"
                FROM pg_trigger tg
                JOIN pg_class cls ON cls.oid = tg.tgrelid
                JOIN pg_proc fn ON fn.oid = tg.tgfoid
                JOIN pg_namespace ns ON ns.oid = cls.relnamespace
                WHERE NOT tg.tgisinternal
                    AND ns.nspname = current_schema()
                    AND (fn.proname LIKE 'whatsapp%' OR cls.relname = ANY($1::text[]))
                ORDER BY cls.relname COLLATE "C", tg.tgname COLLATE "C"`,
                NEW_TABLES,
            )
            expect(triggers).toEqual([
                { tableName: 'WhatsAppAccount', triggerName: 'WhatsAppAccount_guard' },
                { tableName: 'WhatsAppAccount', triggerName: 'WhatsAppAccount_key_set_complete' },
                { tableName: 'WhatsAppAccount', triggerName: 'WhatsAppAccount_truncate_guard' },
                { tableName: 'WhatsAppAccountKey', triggerName: 'WhatsAppAccountKey_guard' },
                { tableName: 'WhatsAppAccountKey', triggerName: 'WhatsAppAccountKey_truncate_guard' },
                { tableName: 'WhatsAppCapabilityLease', triggerName: 'WhatsAppCapabilityLease_guard' },
                { tableName: 'WhatsAppCapabilityLease', triggerName: 'WhatsAppCapabilityLease_truncate_guard' },
                { tableName: 'WhatsAppTransportBinding', triggerName: 'WhatsAppTransportBinding_guard' },
                { tableName: 'WhatsAppTransportBinding', triggerName: 'WhatsAppTransportBinding_truncate_guard' },
            ])
        })
    })
})
