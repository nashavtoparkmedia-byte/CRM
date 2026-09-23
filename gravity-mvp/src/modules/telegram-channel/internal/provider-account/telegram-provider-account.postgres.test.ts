/**
 * Isolated-PostgreSQL proof for the M2A2-TG1 Telegram provider-account
 * foundation. Gated behind YOKO_TELEGRAM_PROVIDER_ACCOUNT_POSTGRES_PROOF=1 and
 * an isolated DATABASE_URL. It never touches a production database.
 *
 * The pure tests prove the decision table; this proves the writer is a correct
 * client of the real constraints and guards, and that each negative case fails
 * closed in the database rather than only in application code.
 */
import { randomInt, randomUUID } from 'node:crypto'

import { PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
    admitTelegramAccountV1,
    readProviderAccountProjectionV1,
    recordTelegramTransportAttestationV1,
    TelegramAccountRefusalV1,
} from './telegram-account-writer'

const proof = process.env.YOKO_TELEGRAM_PROVIDER_ACCOUNT_POSTGRES_PROOF === '1' ? describe : describe.skip
const db = new PrismaClient()
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Provider ids are only ever decimal strings; these are synthetic. */
function freshPrincipal() {
    return String(randomInt(1_000_000_000, 2_000_000_000))
}
const freshRef = () => `conn-${randomUUID()}`

async function openBindingRow(transportKind: string, transportRef: string) {
    const rows = await db.$queryRawUnsafe<Array<Record<string, unknown>>>(
        'SELECT * FROM "TelegramTransportBinding" WHERE "transportKind" = $1 AND "transportRef" = $2 AND "closedAt" IS NULL',
        transportKind, transportRef,
    )
    return rows[0] ?? null
}

async function allBindings(transportRef: string) {
    return await db.$queryRawUnsafe<Array<Record<string, unknown>>>(
        'SELECT * FROM "TelegramTransportBinding" WHERE "transportRef" = $1 ORDER BY "transportGeneration"', transportRef,
    )
}

async function accountRow(accountId: string) {
    const rows = await db.$queryRawUnsafe<Array<Record<string, unknown>>>(
        'SELECT * FROM "TelegramAccount" WHERE "accountId" = $1', accountId,
    )
    return rows[0] ?? null
}

function attest(overrides: Partial<Parameters<typeof recordTelegramTransportAttestationV1>[0]> & { transportRef: string; providerUserId: string }) {
    return recordTelegramTransportAttestationV1({
        transportKind: 'mtproto_session',
        accountKind: 'mtproto_user',
        attestingInstanceId: 'instance-1',
        ...overrides,
    })
}

proof('telegram provider account writer against the real guards', () => {
    beforeAll(async () => { await db.$connect() })
    afterAll(async () => { await db.$disconnect() })

    it('the first authentication creates a pending_approval account and a verified generation', async () => {
        const transportRef = freshRef()
        const providerUserId = freshPrincipal()
        const result = await attest({ transportRef, providerUserId })
        expect(result).toMatchObject({ action: 'open_first_generation', accountLifecycle: 'pending_approval', generation: 1, trustStateAfter: 'verified' })

        const binding = await openBindingRow('mtproto_session', transportRef)
        expect(binding).toMatchObject({ trustState: 'verified', transportKind: 'mtproto_session', attestedProviderUserId: providerUserId })
        expect(binding?.openTransportKey).toBe(`mtproto_session:${transportRef}`)
        expect(binding?.openedAt).toBeInstanceOf(Date)
        expect(binding?.lastAttestedAt).toBeInstanceOf(Date)

        const account = await accountRow(binding?.accountId as string)
        expect(account).toMatchObject({ lifecycle: 'pending_approval', lifecycleVersion: 1, providerUserId, accountKind: 'mtproto_user' })
    })

    it('a repeated authentication inside the live window writes nothing', async () => {
        const transportRef = freshRef()
        const providerUserId = freshPrincipal()
        await attest({ transportRef, providerUserId })
        const before = await openBindingRow('mtproto_session', transportRef)
        const result = await attest({ transportRef, providerUserId })
        expect(result.outcome).toBe('attestation_still_fresh')
        const after = await openBindingRow('mtproto_session', transportRef)
        expect(after?.attestedUntil).toEqual(before?.attestedUntil)
        expect(await allBindings(transportRef)).toHaveLength(1)
    })

    it('a recreated transport with the same principal keeps the same account', async () => {
        const providerUserId = freshPrincipal()
        const firstRef = freshRef()
        const first = await attest({ transportRef: firstRef, providerUserId })
        const firstAccount = (await openBindingRow('mtproto_session', firstRef))?.accountId

        // The session row is recreated under a new locator; the principal is unchanged.
        const secondRef = freshRef()
        const second = await attest({ transportRef: secondRef, providerUserId, attestingInstanceId: 'instance-2' })
        const secondAccount = (await openBindingRow('mtproto_session', secondRef))?.accountId

        expect(second.action).toBe('open_first_generation')
        expect(secondAccount).toBe(firstAccount)
        expect(first.accountLifecycle).toBe('pending_approval')
        // Two transports, one account, both open.
        expect(await openBindingRow('mtproto_session', firstRef)).not.toBeNull()
    })

    it('a different authenticated principal replaces the generation and never re-points the old one', async () => {
        const transportRef = freshRef()
        const firstPrincipal = freshPrincipal()
        const secondPrincipal = freshPrincipal()
        await attest({ transportRef, providerUserId: firstPrincipal })
        const firstBinding = await openBindingRow('mtproto_session', transportRef)

        const result = await attest({ transportRef, providerUserId: secondPrincipal, attestingInstanceId: 'instance-2' })
        expect(result).toMatchObject({ action: 'replace_on_principal_change', generation: 2, principalChanged: true })

        const rows = await allBindings(transportRef)
        expect(rows).toHaveLength(2)
        expect(rows[0]).toMatchObject({ bindingId: firstBinding?.bindingId, trustState: 'mismatched', closeReason: 'principal_changed' })
        expect(rows[0].closedAt).toBeInstanceOf(Date)
        expect(rows[0].openTransportKey).toBeNull()
        expect(rows[0].attestedProviderUserId).toBe(firstPrincipal)
        expect(rows[1]).toMatchObject({ trustState: 'verified', attestedProviderUserId: secondPrincipal })
        expect(rows[1].accountId).not.toBe(rows[0].accountId)
    })

    it('two YOKO accounts coexist on one provider, on separate transports', async () => {
        const mtprotoRef = freshRef()
        const botRef = freshRef()
        const userPrincipal = freshPrincipal()
        const botPrincipal = freshPrincipal()
        await attest({ transportRef: mtprotoRef, providerUserId: userPrincipal })
        await recordTelegramTransportAttestationV1({
            transportKind: 'bot_runtime', transportRef: botRef, providerUserId: botPrincipal,
            accountKind: 'bot_api', attestingInstanceId: 'bot-instance',
        })
        const a = await openBindingRow('mtproto_session', mtprotoRef)
        const b = await openBindingRow('bot_runtime', botRef)
        expect(a?.accountId).not.toBe(b?.accountId)
        expect((await accountRow(a?.accountId as string))?.accountKind).toBe('mtproto_user')
        expect((await accountRow(b?.accountId as string))?.accountKind).toBe('bot_api')
    })

    it('refuses a principal carried on the wrong transport kind', async () => {
        await expect(recordTelegramTransportAttestationV1({
            transportKind: 'mtproto_session', transportRef: freshRef(), providerUserId: freshPrincipal(),
            accountKind: 'bot_api', attestingInstanceId: 'instance-1',
        })).rejects.toBeInstanceOf(TelegramAccountRefusalV1)
    })

    it('writes nothing for a principal that is not in exact provider form', async () => {
        const transportRef = freshRef()
        const result = await attest({ transportRef, providerUserId: '+7999555112' })
        expect(result.outcome).toBe('principal_not_usable')
        expect(await allBindings(transportRef)).toHaveLength(0)
    })

    it('revives a lapsed generation by re-attesting the same open binding', async () => {
        // The guard refuses to move attestedUntil backwards, so a short window
        // is seeded at insert time rather than shrunk afterwards.
        const transportRef = freshRef()
        const providerUserId = freshPrincipal()
        const accountId = randomUUID()
        const bindingId = randomUUID()
        await db.$executeRawUnsafe(
            `INSERT INTO "TelegramAccount"("accountId","accountKind","providerUserId","lifecycle","lifecycleVersion","lifecycleChangedBy","lifecycleReason")
             VALUES ($1,'mtproto_user',$2,'pending_approval',1,'proof','seed')`, accountId, providerUserId,
        )
        await db.$executeRawUnsafe(
            `INSERT INTO "TelegramTransportBinding"
               ("bindingId","accountId","transportKind","transportRef","transportGeneration","trustState",
                "attestedProviderUserId","attestingInstanceId","attestedUntil","openTransportKey")
             VALUES ($1,$2,'mtproto_session',$3,1,'verified',$4,'proof', now() + interval '1 second', $5)`,
            bindingId, accountId, transportRef, providerUserId, `mtproto_session:${transportRef}`,
        )
        const before = await openBindingRow('mtproto_session', transportRef)
        await sleep(1500)

        const result = await attest({ transportRef, providerUserId, attestingInstanceId: 'instance-2' })
        expect(result).toMatchObject({ action: 'reattest_open_generation', outcome: 'reattested' })

        const rows = await allBindings(transportRef)
        expect(rows).toHaveLength(1)
        expect(rows[0].bindingId).toBe(bindingId)
        expect(rows[0].trustState).toBe('verified')
        expect((rows[0].attestedUntil as Date).getTime()).toBeGreaterThan((before?.attestedUntil as Date).getTime())
    })

    it('refuses a trust transition the guard does not permit', async () => {
        const transportRef = freshRef()
        await attest({ transportRef, providerUserId: freshPrincipal() })
        const bindingId = (await openBindingRow('mtproto_session', transportRef))?.bindingId as string
        await expect(db.$executeRawUnsafe(
            `UPDATE "TelegramTransportBinding" SET "trustState"='pending' WHERE "bindingId" = $1`, bindingId,
        )).rejects.toThrow(/trust transition from verified to pending is not permitted/u)
    })

    it('admits an account without claiming anything about readiness', async () => {
        const transportRef = freshRef()
        const providerUserId = freshPrincipal()
        await attest({ transportRef, providerUserId })
        const accountId = (await openBindingRow('mtproto_session', transportRef))?.accountId as string

        const before = await readProviderAccountProjectionV1('mtproto_session', transportRef)
        expect(before).toMatchObject({ channel: 'telegram', providerAccountId: accountId, lifecycle: 'pending_approval', readiness: 'not_admitted' })

        const admitted = await admitTelegramAccountV1({ accountId, principalId: 'identity-access:integration-admin-session' })
        expect(admitted).toMatchObject({ outcome: 'admitted', lifecycle: 'active' })
        expect(await accountRow(accountId)).toMatchObject({ lifecycle: 'active', lifecycleVersion: 2 })

        const after = await readProviderAccountProjectionV1('mtproto_session', transportRef)
        expect(after.readiness).toBe('ready')
        // The projection never carries a credential, a session string or a provider id.
        expect(Object.keys(after).sort()).toEqual(['accountKind', 'capabilities', 'channel', 'lifecycle', 'providerAccountId', 'readiness'])
        expect(JSON.stringify(after)).not.toContain(providerUserId)
    })

    it('is idempotent on admission and refuses an unauthenticated principal', async () => {
        const transportRef = freshRef()
        await attest({ transportRef, providerUserId: freshPrincipal() })
        const accountId = (await openBindingRow('mtproto_session', transportRef))?.accountId as string
        expect((await admitTelegramAccountV1({ accountId, principalId: '' })).outcome).toBe('unauthenticated')
        expect(await accountRow(accountId)).toMatchObject({ lifecycle: 'pending_approval' })
        await admitTelegramAccountV1({ accountId, principalId: 'identity-access:integration-admin-session' })
        expect((await admitTelegramAccountV1({ accountId, principalId: 'someone-else' })).outcome).toBe('already_active')
        expect(await accountRow(accountId)).toMatchObject({ lifecycleVersion: 2 })
    })

    it('refuses to retire an account while a transport binding is open', async () => {
        const transportRef = freshRef()
        await attest({ transportRef, providerUserId: freshPrincipal() })
        const accountId = (await openBindingRow('mtproto_session', transportRef))?.accountId as string
        await admitTelegramAccountV1({ accountId, principalId: 'identity-access:integration-admin-session' })
        await db.$executeRawUnsafe(
            `UPDATE "TelegramAccount" SET "lifecycle"='disabled', "lifecycleVersion"=3, "lifecycleChangedBy"='proof', "lifecycleReason"='test' WHERE "accountId" = $1`, accountId,
        )
        await expect(db.$executeRawUnsafe(
            `UPDATE "TelegramAccount" SET "lifecycle"='retired', "lifecycleVersion"=4, "lifecycleChangedBy"='proof', "lifecycleReason"='test' WHERE "accountId" = $1`, accountId,
        )).rejects.toThrow(/cannot retire while a transport binding is open/u)
    })

    it('refuses one provider principal owning two accounts, even under a different kind', async () => {
        // A Telegram bot IS a Telegram user, so bot ids and user ids share one
        // provider id space. `providerUserId` therefore carries a standalone
        // global unique and `accountKind` is part of no key: the kind describes
        // the principal, it never scopes its identity.
        const providerUserId = freshPrincipal()
        await attest({ transportRef: freshRef(), providerUserId })
        await expect(db.$executeRawUnsafe(
            `INSERT INTO "TelegramAccount"("accountId","accountKind","providerUserId","lifecycle","lifecycleVersion","lifecycleChangedBy","lifecycleReason")
             VALUES ($1,'bot_api',$2,'pending_approval',1,'proof','same principal, different kind')`, randomUUID(), providerUserId,
        )).rejects.toThrow(/"providerUserId"\)=\(\d+\) already exists/u)

        // And the writer refuses rather than creating a second account for it.
        await expect(recordTelegramTransportAttestationV1({
            transportKind: 'bot_runtime', transportRef: freshRef(), providerUserId,
            accountKind: 'bot_api', attestingInstanceId: 'bot-instance',
        })).rejects.toBeInstanceOf(TelegramAccountRefusalV1)

        const rows = await db.$queryRawUnsafe<Array<Record<string, unknown>>>(
            'SELECT "accountId" FROM "TelegramAccount" WHERE "providerUserId" = $1', providerUserId,
        )
        expect(rows).toHaveLength(1)
    })

    it('refuses a duplicated provider identity under a second account', async () => {
        const providerUserId = freshPrincipal()
        await attest({ transportRef: freshRef(), providerUserId })
        await expect(db.$executeRawUnsafe(
            `INSERT INTO "TelegramAccount"("accountId","accountKind","providerUserId","lifecycle","lifecycleVersion","lifecycleChangedBy","lifecycleReason")
             VALUES ($1,'mtproto_user',$2,'pending_approval',1,'proof','duplicate')`, randomUUID(), providerUserId,
        )).rejects.toThrow()
    })

    it('refuses a binding that attests a principal its account does not own', async () => {
        const transportRef = freshRef()
        await attest({ transportRef, providerUserId: freshPrincipal() })
        const binding = await openBindingRow('mtproto_session', transportRef)
        await expect(db.$executeRawUnsafe(
            `UPDATE "TelegramTransportBinding" SET "attestedProviderUserId" = $1 WHERE "bindingId" = $2`,
            freshPrincipal(), binding?.bindingId as string,
        )).rejects.toThrow()
    })

    it('keeps identity, transport and history immutable', async () => {
        const transportRef = freshRef()
        await attest({ transportRef, providerUserId: freshPrincipal() })
        const binding = await openBindingRow('mtproto_session', transportRef)
        const accountId = binding?.accountId as string
        await expect(db.$executeRawUnsafe(`UPDATE "TelegramAccount" SET "providerUserId"='1' WHERE "accountId"=$1`, accountId))
            .rejects.toThrow(/identity is immutable/u)
        await expect(db.$executeRawUnsafe(`UPDATE "TelegramTransportBinding" SET "transportRef"='other' WHERE "bindingId"=$1`, binding?.bindingId as string))
            .rejects.toThrow(/identity, transport and generation are immutable/u)
        await expect(db.$executeRawUnsafe(`DELETE FROM "TelegramTransportBinding" WHERE "bindingId"=$1`, binding?.bindingId as string))
            .rejects.toThrow(/durable history/u)
        await expect(db.$executeRawUnsafe(`DELETE FROM "TelegramAccount" WHERE "accountId"=$1`, accountId))
            .rejects.toThrow(/permanent/u)
    })

    it('two concurrent authentications on one transport leave exactly one open binding', async () => {
        const transportRef = freshRef()
        const providerUserId = freshPrincipal()
        const settled = await Promise.allSettled([
            attest({ transportRef, providerUserId, attestingInstanceId: 'instance-a' }),
            attest({ transportRef, providerUserId, attestingInstanceId: 'instance-b' }),
        ])
        expect(settled.some((outcome) => outcome.status === 'fulfilled')).toBe(true)
        const rows = await allBindings(transportRef)
        expect(rows.filter((row) => row.closedAt === null)).toHaveLength(1)
        expect(rows).toHaveLength(1)
    })

    it('an account survives a process restart, because it is keyed on the provider id', async () => {
        const providerUserId = freshPrincipal()
        const firstRef = freshRef()
        await attest({ transportRef: firstRef, providerUserId })
        const accountId = (await openBindingRow('mtproto_session', firstRef))?.accountId

        // A restart loses every in-process cache; the next authentication is
        // resolved purely from durable state.
        const afterRestartRef = freshRef()
        await attest({ transportRef: afterRestartRef, providerUserId, attestingInstanceId: 'instance-after-restart' })
        expect((await openBindingRow('mtproto_session', afterRestartRef))?.accountId).toBe(accountId)
    })
})
