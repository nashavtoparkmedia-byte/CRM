/**
 * Isolated-PostgreSQL proof for the M2A2-MAX1A MAX provider-account foundation.
 * Gated behind YOKO_MAX_PROVIDER_ACCOUNT_POSTGRES_PROOF=1 and an isolated
 * DATABASE_URL. It never touches a production database.
 *
 * The pure tests prove the decision table; this proves the writer is a correct
 * client of the real constraints and guards, and that each negative case fails
 * closed in the database rather than only in application code.
 */
import { randomInt, randomUUID } from 'node:crypto'

import { PrismaClient } from '@prisma/client'
import { afterAll, describe, expect, it } from 'vitest'

import {
    MaxAccountRefusalV1,
    readMaxProviderAccountProjectionV1,
    recordMaxTransportAttestationV1,
} from './max-account-writer'

const proof = process.env.YOKO_MAX_PROVIDER_ACCOUNT_POSTGRES_PROOF === '1' ? describe : describe.skip
const db = new PrismaClient()

/** Synthetic principals and locators; never a real provider or production value. */
const freshPrincipal = () => String(randomInt(900_000_000_000, 999_999_999_999))
const freshRef = () => `max-personal-${randomUUID().replace(/-/gu, '').slice(0, 24)}`

async function openBindingRow(transportRef: string) {
    const rows = await db.$queryRawUnsafe<Array<Record<string, unknown>>>(
        'SELECT * FROM "MaxTransportBinding" WHERE "transportRef" = $1 AND "closedAt" IS NULL', transportRef,
    )
    return rows[0] ?? null
}

async function allBindings(transportRef: string) {
    return await db.$queryRawUnsafe<Array<Record<string, unknown>>>(
        'SELECT * FROM "MaxTransportBinding" WHERE "transportRef" = $1 ORDER BY "transportGeneration"', transportRef,
    )
}

async function accountRow(accountId: string) {
    const rows = await db.$queryRawUnsafe<Array<Record<string, unknown>>>(
        'SELECT * FROM "MaxAccount" WHERE "accountId" = $1', accountId,
    )
    return rows[0] ?? null
}

function attest(overrides: { transportRef: string; providerUserId: string } & Partial<Parameters<typeof recordMaxTransportAttestationV1>[0]>) {
    return recordMaxTransportAttestationV1({
        transportKind: 'web_session',
        attestingInstanceId: 'instance-1',
        authEventKind: 'ws_owner_op53',
        ...overrides,
    })
}

proof('MAX provider account foundation on real PostgreSQL', () => {
    afterAll(async () => { await db.$disconnect() })

    it('opens a pending account and one verified-by-construction generation', async () => {
        const transportRef = freshRef()
        const providerUserId = freshPrincipal()
        const result = await attest({ transportRef, providerUserId })

        expect(result).toMatchObject({
            action: 'open_first_generation',
            outcome: 'opened_first_generation',
            accountLifecycle: 'pending_approval',
            generation: 1,
            principalChanged: false,
        })

        const binding = await openBindingRow(transportRef)
        expect(binding).toBeTruthy()
        expect(binding!.attestedProviderUserId).toBe(providerUserId)
        expect(binding!.openTransportKey).toBe(`web_session:${transportRef}`)
        expect(binding!.lastAuthEventKind).toBe('ws_owner_op53')
        expect(binding!.closedAt).toBeNull()
        expect(binding!.closeReason).toBeNull()
        expect(binding!.lastAttestedAt).toBeInstanceOf(Date)

        const account = await accountRow(String(binding!.accountId))
        expect(account).toMatchObject({ lifecycle: 'pending_approval', lifecycleVersion: 1, providerUserId })
        expect(account!.lifecycleChangedBy).toBe('max-channel:provider-account-writer')
    })

    it('has no trust column at all', async () => {
        const rows = await db.$queryRawUnsafe<Array<{ column_name: string }>>(
            `SELECT column_name FROM information_schema.columns
             WHERE table_schema = current_schema() AND table_name = 'MaxTransportBinding'`,
        )
        const columns = rows.map(row => row.column_name)
        expect(columns).not.toContain('trustState')
        expect(columns).not.toContain('attestedUntil')
    })

    it('keeps one provider principal in exactly one account', async () => {
        const providerUserId = freshPrincipal()
        const first = await attest({ transportRef: freshRef(), providerUserId })
        const second = await attest({ transportRef: freshRef(), providerUserId })
        expect(first.generation).toBe(1)
        expect(second.generation).toBe(1)

        const accounts = await db.$queryRawUnsafe<Array<{ accountId: string }>>(
            'SELECT "accountId" FROM "MaxAccount" WHERE "providerUserId" = $1', providerUserId,
        )
        expect(accounts).toHaveLength(1)
    })

    it('re-attests the open generation without opening a new one', async () => {
        const transportRef = freshRef()
        const providerUserId = freshPrincipal()
        await attest({ transportRef, providerUserId })
        const before = await openBindingRow(transportRef)

        const again = await attest({
            transportRef, providerUserId,
            attestingInstanceId: 'instance-2',
            authEventKind: 'ws_auth_op19',
        })
        expect(again).toMatchObject({ action: 'reattest_existing_generation', outcome: 'reattested', generation: 1 })

        const after = await openBindingRow(transportRef)
        expect(after!.bindingId).toBe(before!.bindingId)
        expect(after!.attestingInstanceId).toBe('instance-2')
        expect(after!.lastAuthEventKind).toBe('ws_auth_op19')
        expect((after!.lastAttestedAt as Date).getTime()).toBeGreaterThanOrEqual((before!.lastAttestedAt as Date).getTime())
        expect(await allBindings(transportRef)).toHaveLength(1)
    })

    it('closes the old generation and opens the next when the principal changes', async () => {
        const transportRef = freshRef()
        const first = freshPrincipal()
        const second = freshPrincipal()
        await attest({ transportRef, providerUserId: first })
        const replaced = await attest({ transportRef, providerUserId: second })

        expect(replaced).toMatchObject({
            action: 'replace_on_principal_change',
            outcome: 'replaced_on_principal_change',
            generation: 2,
            principalChanged: true,
        })

        const bindings = await allBindings(transportRef)
        expect(bindings).toHaveLength(2)
        expect(bindings[0]).toMatchObject({ closeReason: 'principal_changed', openTransportKey: null })
        expect(bindings[0].closedAt).toBeInstanceOf(Date)
        expect(bindings[0].attestedProviderUserId).toBe(first)
        expect(bindings[1]).toMatchObject({ closeReason: null, attestedProviderUserId: second })
        expect(bindings[1].openTransportKey).toBe(`web_session:${transportRef}`)
        // The old row still points at the account it always pointed at.
        expect(bindings[0].accountId).not.toBe(bindings[1].accountId)
    })

    it('refuses a binding that attests a principal its account does not own', async () => {
        const transportRef = freshRef()
        const providerUserId = freshPrincipal()
        await attest({ transportRef, providerUserId })
        const binding = await openBindingRow(transportRef)

        await expect(db.$executeRawUnsafe(
            'UPDATE "MaxTransportBinding" SET "attestedProviderUserId" = $1 WHERE "bindingId" = $2',
            freshPrincipal(), binding!.bindingId,
        )).rejects.toThrow()
    })

    it('refuses a second open generation for the same transport', async () => {
        const transportRef = freshRef()
        const providerUserId = freshPrincipal()
        await attest({ transportRef, providerUserId })
        const binding = await openBindingRow(transportRef)

        await expect(db.$executeRawUnsafe(
            `INSERT INTO "MaxTransportBinding"
             ("bindingId","accountId","transportKind","transportRef","transportGeneration",
              "attestedProviderUserId","attestingInstanceId","lastAuthEventKind","openTransportKey")
             VALUES ($1,$2,'web_session',$3,99,$4,'instance-x','ws_auth_op19',$5)`,
            randomUUID(), binding!.accountId, transportRef, providerUserId, `web_session:${transportRef}`,
        )).rejects.toThrow()
    })

    it('rejects DELETE on both tables', async () => {
        const transportRef = freshRef()
        await attest({ transportRef, providerUserId: freshPrincipal() })
        const binding = await openBindingRow(transportRef)

        await expect(db.$executeRawUnsafe(
            'DELETE FROM "MaxTransportBinding" WHERE "bindingId" = $1', binding!.bindingId,
        )).rejects.toThrow(/durable history/u)
        await expect(db.$executeRawUnsafe(
            'DELETE FROM "MaxAccount" WHERE "accountId" = $1', binding!.accountId,
        )).rejects.toThrow(/permanent/u)
    })

    it('rejects TRUNCATE on both tables, including the CASCADE form', async () => {
        await expect(db.$executeRawUnsafe('TRUNCATE "MaxTransportBinding"')).rejects.toThrow(/cannot be truncated/u)
        // The guard, not only the foreign key, refuses the forms that would
        // otherwise succeed: CASCADE and truncating both tables together.
        await expect(db.$executeRawUnsafe('TRUNCATE "MaxAccount" CASCADE')).rejects.toThrow(/cannot be truncated/u)
        await expect(db.$executeRawUnsafe('TRUNCATE "MaxAccount", "MaxTransportBinding"')).rejects.toThrow(/cannot be truncated/u)
        // And the bare form is refused before the guard is even reached.
        await expect(db.$executeRawUnsafe('TRUNCATE "MaxAccount"')).rejects.toThrow()
    })

    it('rejects mutation of an immutable identity', async () => {
        const transportRef = freshRef()
        await attest({ transportRef, providerUserId: freshPrincipal() })
        const binding = await openBindingRow(transportRef)

        await expect(db.$executeRawUnsafe(
            'UPDATE "MaxAccount" SET "providerUserId" = $1 WHERE "accountId" = $2',
            freshPrincipal(), binding!.accountId,
        )).rejects.toThrow(/identity is immutable/u)
        await expect(db.$executeRawUnsafe(
            'UPDATE "MaxTransportBinding" SET "transportGeneration" = 42 WHERE "bindingId" = $1', binding!.bindingId,
        )).rejects.toThrow(/immutable/u)
        await expect(db.$executeRawUnsafe(
            'UPDATE "MaxTransportBinding" SET "transportRef" = $1 WHERE "bindingId" = $2', freshRef(), binding!.bindingId,
        )).rejects.toThrow(/immutable/u)
    })

    it('rejects closing a binding without naming a reason', async () => {
        const transportRef = freshRef()
        await attest({ transportRef, providerUserId: freshPrincipal() })
        const binding = await openBindingRow(transportRef)

        await expect(db.$executeRawUnsafe(
            'UPDATE "MaxTransportBinding" SET "openTransportKey" = NULL WHERE "bindingId" = $1', binding!.bindingId,
        )).rejects.toThrow(/closes only by recording a close reason/u)
    })

    it('enforces the lifecycle transition table and a version step of exactly one', async () => {
        const transportRef = freshRef()
        await attest({ transportRef, providerUserId: freshPrincipal() })
        const accountId = String((await openBindingRow(transportRef))!.accountId)
        const move = (lifecycle: string, version: number) => db.$executeRawUnsafe(
            `UPDATE "MaxAccount" SET "lifecycle" = $1, "lifecycleVersion" = $2,
             "lifecycleChangedBy" = 'test', "lifecycleChangeReason" = 'transition-proof' WHERE "accountId" = $3`,
            lifecycle, version, accountId,
        )

        await expect(move('retired', 2)).rejects.toThrow(/not permitted/u)
        await expect(move('active', 3)).rejects.toThrow(/exactly one/u)
        await move('active', 2)
        expect(await accountRow(accountId)).toMatchObject({ lifecycle: 'active', lifecycleVersion: 2 })
        await expect(move('retired', 3)).rejects.toThrow(/not permitted/u)
        await move('disabled', 3)
        await move('active', 4)
        await move('disabled', 5)
        // Retiring is refused while the transport binding is still open.
        await expect(move('retired', 6)).rejects.toThrow(/cannot retire while a transport binding is open/u)
    })

    it('allows retiring only once no binding is open', async () => {
        const transportRef = freshRef()
        const first = freshPrincipal()
        await attest({ transportRef, providerUserId: first })
        const firstAccountId = String((await openBindingRow(transportRef))!.accountId)
        // A principal change closes the first account's generation.
        await attest({ transportRef, providerUserId: freshPrincipal() })

        const move = (lifecycle: string, version: number) => db.$executeRawUnsafe(
            `UPDATE "MaxAccount" SET "lifecycle" = $1, "lifecycleVersion" = $2,
             "lifecycleChangedBy" = 'test', "lifecycleChangeReason" = 'retire-proof' WHERE "accountId" = $3`,
            lifecycle, version, firstAccountId,
        )
        await move('active', 2)
        await move('disabled', 3)
        await move('retired', 4)
        expect(await accountRow(firstAccountId)).toMatchObject({ lifecycle: 'retired' })
    })

    it('refuses a principal the database considers unusable', async () => {
        const transportRef = freshRef()
        for (const providerUserId of ['legacy', 'max-default']) {
            const result = await attest({ transportRef, providerUserId })
            expect(result).toMatchObject({ action: 'none', outcome: 'principal_not_usable' })
        }
        expect(await openBindingRow(transportRef)).toBeNull()

        // And the constraint itself refuses the sentinel even by raw insert.
        await expect(db.$executeRawUnsafe(
            `INSERT INTO "MaxAccount" ("accountId","providerUserId","lifecycle","lifecycleVersion",
              "lifecycleChangedBy","lifecycleChangeReason") VALUES ($1,'legacy','pending_approval',1,'t','r')`,
            randomUUID(),
        )).rejects.toThrow()
    })

    it('refuses an unknown transport kind and a malformed locator', async () => {
        await expect(attest({
            transportRef: freshRef(), providerUserId: freshPrincipal(), transportKind: 'bot_runtime' as never,
        })).rejects.toBeInstanceOf(MaxAccountRefusalV1)
        await expect(attest({
            transportRef: 'conn-1', providerUserId: freshPrincipal(),
        })).rejects.toBeInstanceOf(MaxAccountRefusalV1)
    })

    it('converges when two first observations race', async () => {
        const transportRef = freshRef()
        const providerUserId = freshPrincipal()
        const results = await Promise.all([
            attest({ transportRef, providerUserId }),
            attest({ transportRef, providerUserId }),
        ])
        for (const result of results) expect(result.generation).toBe(1)
        expect(await allBindings(transportRef)).toHaveLength(1)
    })

    it('converges when duplicate observations race', async () => {
        const transportRef = freshRef()
        const providerUserId = freshPrincipal()
        await attest({ transportRef, providerUserId })
        await Promise.all([
            attest({ transportRef, providerUserId, attestingInstanceId: 'a' }),
            attest({ transportRef, providerUserId, attestingInstanceId: 'b' }),
            attest({ transportRef, providerUserId, attestingInstanceId: 'c' }),
        ])
        expect(await allBindings(transportRef)).toHaveLength(1)
    })

    it('converges when a principal change races with itself', async () => {
        const transportRef = freshRef()
        await attest({ transportRef, providerUserId: freshPrincipal() })
        const next = freshPrincipal()
        await Promise.all([
            attest({ transportRef, providerUserId: next }).catch(() => null),
            attest({ transportRef, providerUserId: next }).catch(() => null),
        ])
        const bindings = await allBindings(transportRef)
        expect(bindings.length).toBeLessThanOrEqual(2)
        const open = bindings.filter(row => row.closedAt === null)
        expect(open).toHaveLength(1)
        expect(open[0].attestedProviderUserId).toBe(next)
    })

    it('projects durable state only', async () => {
        const transportRef = freshRef()
        const absent = await readMaxProviderAccountProjectionV1('web_session', transportRef)
        expect(absent).toEqual({
            channel: 'max', providerAccountId: null, lifecycle: null,
            identityState: 'no_open_transport', lastAttestedAt: null, capabilities: [],
        })

        await attest({ transportRef, providerUserId: freshPrincipal() })
        const pending = await readMaxProviderAccountProjectionV1('web_session', transportRef)
        expect(pending).toMatchObject({
            channel: 'max', lifecycle: 'pending_approval', identityState: 'not_admitted', capabilities: [],
        })
        expect(pending.providerAccountId).toBeTruthy()
        expect(pending.lastAttestedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u)

        await db.$executeRawUnsafe(
            `UPDATE "MaxAccount" SET "lifecycle" = 'active', "lifecycleVersion" = 2,
             "lifecycleChangedBy" = 'test', "lifecycleChangeReason" = 'projection-proof' WHERE "accountId" = $1`,
            pending.providerAccountId,
        )
        const active = await readMaxProviderAccountProjectionV1('web_session', transportRef)
        expect(active).toMatchObject({ lifecycle: 'active', identityState: 'identity_established', capabilities: [] })
    })

    it('never reports a stale or fresh identity state', async () => {
        const transportRef = freshRef()
        await attest({ transportRef, providerUserId: freshPrincipal() })
        const projection = await readMaxProviderAccountProjectionV1('web_session', transportRef)
        expect(['no_open_transport', 'not_admitted', 'identity_established']).toContain(projection.identityState)
        expect(JSON.stringify(projection)).not.toContain('stale')
    })
})
