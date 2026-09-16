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

let first: PrismaClient
let second: PrismaClient
let observer: PrismaClient

function clientFor(applicationName: string): PrismaClient {
    const url = new URL(process.env.DATABASE_URL ?? '')
    url.searchParams.set('application_name', applicationName)
    url.searchParams.set('connection_limit', '2')
    return new PrismaClient({ datasourceUrl: url.toString() })
}

const newId = (prefix: string): string => `${prefix}-${randomUUID()}`
const newKeyValue = (): string => `${randomInt(100_000, 1_000_000)}${randomInt(100_000, 1_000_000)}`
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const secondsBetween = (later: Date, earlier: Date): number => (later.getTime() - earlier.getTime()) / 1000

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

async function readAccount(accountId: string): Promise<{ lifecycle: string; lifecycleVersion: number; createdAt: Date; dbNow: Date } | undefined> {
    const rows = await observer.$queryRawUnsafe<Array<{ lifecycle: string; lifecycleVersion: number; createdAt: Date; dbNow: Date }>>(
        'SELECT "lifecycle", "lifecycleVersion", "createdAt", now() AS "dbNow" FROM "WhatsAppAccount" WHERE "accountId" = $1',
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
        keyValue: string
        keyKind?: KeyKind
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
            "trustState", "attestationOrigin", "attestedKeyKind", "attestedKeyValue", "attestingInstanceId", "attestedUntil"
        ) VALUES (
            $1, 'whatsapp_web_slot', $2, $3::bigint, $4, $5::int,
            'verified', 'provider_verified', $6, $7, 'attester-1', now() + make_interval(secs => $8::double precision)
        )`,
        bindingId,
        transportRef,
        input.generation ?? 1,
        input.accountId,
        input.bindingSeq ?? 1,
        input.keyKind ?? 'whatsapp_pn_user',
        input.keyValue,
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

async function openAssertedBinding(db: Db, accountId: string, claimedKind: KeyKind, claimedValue: string): Promise<BindingFixture> {
    const bindingId = newId('bind')
    const transportRef = newId('slot')
    await db.$executeRawUnsafe(
        `INSERT INTO "WhatsAppTransportBinding" (
            "bindingId", "transportKind", "transportRef", "transportGeneration", "accountId", "bindingSeq",
            "trustState", "attestationOrigin", "claimedKeyKind", "claimedKeyValue", "attestingInstanceId"
        ) VALUES ($1, 'whatsapp_web_slot', $2, 1, $3, 1, 'pending', 'transport_asserted', $4, $5, 'attester-1')`,
        bindingId,
        transportRef,
        accountId,
        claimedKind,
        claimedValue,
    )
    return { bindingId, transportRef }
}

async function verifyBinding(db: Db, bindingId: string, keyKind: KeyKind, keyValue: string): Promise<number> {
    return db.$executeRawUnsafe(
        `UPDATE "WhatsAppTransportBinding"
        SET "trustState" = 'verified',
            "attestedKeyKind" = $2,
            "attestedKeyValue" = $3,
            "attestedUntil" = now() + interval '10 minutes'
        WHERE "bindingId" = $1`,
        bindingId,
        keyKind,
        keyValue,
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
    }>>(
        `SELECT "accountId", "transportRef", "transportGeneration"::int AS "generation", "trustState", "closedAt",
            "closeReason", "lastAttestedAt", "attestedUntil", "attestedUntil" <= clock_timestamp() AS "stale"
        FROM "WhatsAppTransportBinding" WHERE "bindingId" = $1`,
        bindingId,
    )
    return rows[0]
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
            "SELECT set_config('yoko.whatsapp_lease_holder', $1, true) AS \"holder\"",
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
    const primary = await openBinding(first, { accountId: account.accountId, keyValue: account.pn, attestedSeconds })
    const secondary = await openBinding(first, {
        accountId: account.accountId,
        keyKind: 'whatsapp_lid_user',
        keyValue: account.lid,
        attestedSeconds,
    })
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

proof('WhatsApp company-account foundation (isolated PostgreSQL)', () => {
    beforeAll(async () => {
        first = clientFor(FIRST)
        second = clientFor(SECOND)
        observer = clientFor('wa-account-proof-observer')
        await Promise.all([first.$connect(), second.$connect(), observer.$connect()])
    })

    afterAll(async () => {
        await Promise.all([first?.$disconnect(), second?.$disconnect(), observer?.$disconnect()])
    })

    describe('account identity and provider keys', () => {
        it('creates an account only together with its complete PN and LID key set', async () => {
            const account = await createAccount()
            expect(await readAccount(account.accountId)).toMatchObject({ lifecycle: 'pending_approval', lifecycleVersion: 1 })
            expect(await countKeys(account.accountId)).toBe(2)

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

        it('stamps lifecycle and creation times from the database clock', async () => {
            const accountId = newId('acc')
            await first.$transaction(async (tx) => {
                await tx.$executeRawUnsafe(
                    `INSERT INTO "WhatsAppAccount"
                        ("accountId", "accountKind", "lifecycle", "lifecycleVersion", "lifecycleChangedAt",
                         "lifecycleChangedBy", "lifecycleReason", "createdAt")
                    VALUES ($1, 'whatsapp_user', 'pending_approval', 1, '2001-01-01T00:00:00Z', 'system', 'observed', '2001-01-01T00:00:00Z')`,
                    accountId,
                )
                await insertKey(tx, accountId, 'whatsapp_pn_user', newKeyValue())
                await insertKey(tx, accountId, 'whatsapp_lid_user', newKeyValue())
            }, TRANSACTION)
            const stored = await readAccount(accountId)
            expect(Math.abs(secondsBetween(stored!.dbNow, stored!.createdAt))).toBeLessThan(60)
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
            const binding = await openBinding(first, { accountId: account.accountId, keyValue: account.pn })

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
            const primary = await openBinding(first, { accountId: account.accountId, keyValue: account.pn })
            await openBinding(first, { accountId: account.accountId, keyKind: 'whatsapp_lid_user', keyValue: account.lid })

            const duplicateOpen = await settle(openBinding(first, {
                accountId: account.accountId,
                keyValue: account.pn,
                transportRef: primary.transportRef,
                bindingSeq: 2,
            }))
            expect(refusal(duplicateOpen)).toMatch(/23505|duplicate key/u)
        })

        it('keeps binding identity, transport, generation and account immutable and rows permanent', async () => {
            const account = await activeAccount()
            const other = await activeAccount()
            const binding = await openBinding(first, { accountId: account.accountId, keyValue: account.pn })
            const immutable = [
                ['UPDATE "WhatsAppTransportBinding" SET "accountId" = $2 WHERE "bindingId" = $1', other.accountId],
                ['UPDATE "WhatsAppTransportBinding" SET "transportRef" = $2 WHERE "bindingId" = $1', newId('slot')],
                ['UPDATE "WhatsAppTransportBinding" SET "transportGeneration" = "transportGeneration" + $2::bigint WHERE "bindingId" = $1', 1],
                ['UPDATE "WhatsAppTransportBinding" SET "bindingSeq" = "bindingSeq" + $2::int WHERE "bindingId" = $1', 1],
                ['UPDATE "WhatsAppTransportBinding" SET "attestationOrigin" = $2 WHERE "bindingId" = $1', 'transport_asserted'],
                ['UPDATE "WhatsAppTransportBinding" SET "bindingId" = $2 WHERE "bindingId" = $1', newId('bind')],
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
            const old = await openBinding(first, { accountId: original.accountId, keyValue: original.pn })

            expect(await closeBinding(first, old.bindingId, 'mismatched', 'account_changed')).toBe(1)
            const repaired = await openBinding(first, {
                accountId: replacement.accountId,
                keyValue: replacement.pn,
                transportRef: old.transportRef,
                bindingSeq: 2,
                generation: 2,
            })

            expect(await readBinding(old.bindingId)).toMatchObject({
                accountId: original.accountId,
                trustState: 'mismatched',
                closeReason: 'account_changed',
                generation: 1,
            })
            expect(await readBinding(repaired.bindingId)).toMatchObject({ accountId: replacement.accountId, generation: 2 })
            expect(refusal(await settle(verifyBinding(first, old.bindingId, 'whatsapp_pn_user', original.pn))))
                .toContain('closed and frozen')

            expect(await closeBinding(first, repaired.bindingId, 'closed', 'logged_out')).toBe(1)
            const gap = await settle(openPendingBinding(first, { accountId: original.accountId, transportRef: old.transportRef, bindingSeq: 4, generation: 3 }))
            expect(refusal(gap)).toContain('bindingSeq must be contiguous')
            const reused = await settle(openPendingBinding(first, { accountId: original.accountId, transportRef: old.transportRef, bindingSeq: 2, generation: 3 }))
            expect(refusal(reused)).toContain('history must advance')
            const olderGeneration = await settle(openPendingBinding(first, { accountId: original.accountId, transportRef: old.transportRef, bindingSeq: 3, generation: 1 }))
            expect(refusal(olderGeneration)).toContain('history must advance')
            expect(await openPendingBinding(first, { accountId: original.accountId, transportRef: old.transportRef, bindingSeq: 3, generation: 2 }))
                .toMatchObject({ transportRef: old.transportRef })
        })

        it('attests only a key owned by the bound account and requires key plus freshness to verify', async () => {
            const account = await activeAccount()
            const stranger = await activeAccount()

            const foreignKey = await settle(openBinding(first, { accountId: account.accountId, keyValue: stranger.pn }))
            expect(refusal(foreignKey)).toMatch(/23503|foreign key/u)

            const pending = await openPendingBinding(first, { accountId: account.accountId })
            expect(refusal(await settle(first.$executeRawUnsafe(
                `UPDATE "WhatsAppTransportBinding"
                SET "trustState" = 'verified', "attestedUntil" = now() + interval '10 minutes'
                WHERE "bindingId" = $1`,
                pending.bindingId,
            )))).toMatch(/23514|check constraint/u)
            expect(refusal(await settle(first.$executeRawUnsafe(
                `UPDATE "WhatsAppTransportBinding"
                SET "trustState" = 'verified', "attestedKeyKind" = 'whatsapp_pn_user', "attestedKeyValue" = $2
                WHERE "bindingId" = $1`,
                pending.bindingId,
                account.pn,
            )))).toContain('becomes verified only with a fresh attestation')
            expect(await verifyBinding(first, pending.bindingId, 'whatsapp_pn_user', account.pn)).toBe(1)

            const lapsed = await openPendingBinding(first, { accountId: account.accountId })
            expect(await first.$executeRawUnsafe(
                'UPDATE "WhatsAppTransportBinding" SET "attestedUntil" = now() + interval \'1 second\' WHERE "bindingId" = $1',
                lapsed.bindingId,
            )).toBe(1)
            await pause(1_300)
            expect(refusal(await settle(first.$executeRawUnsafe(
                `UPDATE "WhatsAppTransportBinding"
                SET "trustState" = 'verified', "attestedKeyKind" = 'whatsapp_pn_user', "attestedKeyValue" = $2
                WHERE "bindingId" = $1`,
                lapsed.bindingId,
                account.pn,
            )))).toContain('becomes verified only with a fresh attestation')
        })

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

            const verified = await openBinding(first, { accountId: account.accountId, keyValue: account.pn })
            expect(refusal(await settle(first.$executeRawUnsafe(
                `UPDATE "WhatsAppTransportBinding"
                SET "attestedKeyKind" = 'whatsapp_lid_user', "attestedKeyValue" = $2, "attestedUntil" = now() + interval '20 minutes'
                WHERE "bindingId" = $1`,
                verified.bindingId,
                account.lid,
            )))).toContain('attested provider key is immutable once recorded')
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

            const pending = await openPendingBinding(first, { accountId: account.accountId })
            expect(await closeBinding(first, pending.bindingId, 'closed', 'superseded')).toBe(1)
            expect(await readBinding(pending.bindingId)).toMatchObject({ trustState: 'closed', closeReason: 'superseded' })
            expect((await readBinding(pending.bindingId)).closedAt).not.toBeNull()
        })

        it('requires operator confirmation of the claimed key before a transport-asserted binding is verified', async () => {
            const account = await activeAccount()
            expect(refusal(await settle(first.$executeRawUnsafe(
                `INSERT INTO "WhatsAppTransportBinding" (
                    "bindingId", "transportKind", "transportRef", "transportGeneration", "accountId", "bindingSeq",
                    "trustState", "attestationOrigin", "attestingInstanceId"
                ) VALUES ($1, 'whatsapp_web_slot', $2, 1, $3, 1, 'pending', 'transport_asserted', 'attester-1')`,
                newId('bind'),
                newId('slot'),
                account.accountId,
            )))).toMatch(/23514|check constraint/u)

            const asserted = await openAssertedBinding(first, account.accountId, 'whatsapp_pn_user', account.pn)
            expect(refusal(await settle(verifyBinding(first, asserted.bindingId, 'whatsapp_pn_user', account.pn))))
                .toMatch(/23514|check constraint/u)

            expect(await first.$executeRawUnsafe(
                `UPDATE "WhatsAppTransportBinding"
                SET "operatorConfirmedAt" = now(), "operatorConfirmedBy" = 'operator-1'
                WHERE "bindingId" = $1`,
                asserted.bindingId,
            )).toBe(1)
            expect(refusal(await settle(verifyBinding(first, asserted.bindingId, 'whatsapp_lid_user', account.lid))))
                .toMatch(/23514|check constraint/u)
            expect(await verifyBinding(first, asserted.bindingId, 'whatsapp_pn_user', account.pn)).toBe(1)
            expect(refusal(await settle(first.$executeRawUnsafe(
                'UPDATE "WhatsAppTransportBinding" SET "operatorConfirmedBy" = \'operator-2\' WHERE "bindingId" = $1',
                asserted.bindingId,
            )))).toContain('operator confirmation is immutable')
        })

        it('moves attestation forward only and derives stale from attestedUntil without storing it', async () => {
            const account = await activeAccount()
            const binding = await openBinding(first, { accountId: account.accountId, keyValue: account.pn, attestedSeconds: 600 })
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

            const shortLived = await openBinding(first, {
                accountId: account.accountId,
                keyKind: 'whatsapp_lid_user',
                keyValue: account.lid,
                attestedSeconds: 1,
            })
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
            const binding = await openBinding(first, { accountId: account.accountId, keyValue: account.pn })
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
            const pendingBinding = await openBinding(first, { accountId: pendingAccount.accountId, keyValue: pendingAccount.pn })
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
            const closed = await openBinding(first, { accountId: account.accountId, keyValue: account.pn })
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
                ['UPDATE "WhatsAppCapabilityLease" SET "version" = "version" + 1, "epoch" = "epoch" + 2 WHERE "accountId" = $1 AND "capability" = \'inbound\'', 'epoch must be monotonic and contiguous'],
                ['UPDATE "WhatsAppCapabilityLease" SET "version" = "version" + 1, "holderInstanceId" = \'intruder\' WHERE "accountId" = $1 AND "capability" = \'inbound\'', 'holder cannot change without a new epoch'],
                ['UPDATE "WhatsAppCapabilityLease" SET "version" = "version" + 1, "capability" = \'outbound\' WHERE "accountId" = $1 AND "capability" = \'inbound\'', 'scope is immutable'],
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

        it('refuses renew and takeover through a stale binding or an inactive account', async () => {
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
        })

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

    describe('inert, isolated foundation', () => {
        it('relates only within the four tables: no Contact, ChannelIdentity or WhatsAppConnection relation', async () => {
            const relations = await observer.$queryRawUnsafe<Array<{ fromTable: string; toTable: string }>>(
                `SELECT src.relname AS "fromTable", dst.relname AS "toTable"
                FROM pg_constraint con
                JOIN pg_class src ON src.oid = con.conrelid
                JOIN pg_class dst ON dst.oid = con.confrelid
                JOIN pg_namespace ns ON ns.oid = src.relnamespace
                WHERE con.contype = 'f'
                    AND ns.nspname = current_schema()
                    AND (src.relname = ANY($1::text[]) OR dst.relname = ANY($1::text[]))
                ORDER BY src.relname COLLATE "C", dst.relname COLLATE "C"`,
                NEW_TABLES,
            )
            expect(relations).toEqual([
                { fromTable: 'WhatsAppAccountKey', toTable: 'WhatsAppAccount' },
                { fromTable: 'WhatsAppCapabilityLease', toTable: 'WhatsAppAccount' },
                { fromTable: 'WhatsAppCapabilityLease', toTable: 'WhatsAppTransportBinding' },
                { fromTable: 'WhatsAppTransportBinding', toTable: 'WhatsAppAccount' },
                { fromTable: 'WhatsAppTransportBinding', toTable: 'WhatsAppAccountKey' },
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
