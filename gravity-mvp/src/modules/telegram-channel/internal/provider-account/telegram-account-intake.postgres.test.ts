/**
 * Isolated-PostgreSQL proof for the M2A2-TG2A intake: the two orchestration
 * modes against the real TG1 constraints. Gated behind
 * YOKO_TELEGRAM_PROVIDER_ACCOUNT_POSTGRES_PROOF=1 and an isolated DATABASE_URL.
 * It never touches a production database.
 */
import { randomInt, randomUUID } from 'node:crypto'

import { PrismaClient } from '@prisma/client'
import { afterAll, describe, expect, it } from 'vitest'

import { createTelegramAccountIntakeV1 } from './telegram-account-intake'
import {
    admitTelegramAccountV1,
    readProviderAccountProjectionV1,
    recordTelegramTransportAttestationV1,
} from './telegram-account-writer'

const proof = process.env.YOKO_TELEGRAM_PROVIDER_ACCOUNT_POSTGRES_PROOF === '1' ? describe : describe.skip
const db = new PrismaClient()
const PRINCIPAL = 'identity-access:integration-admin-session'

const intake = createTelegramAccountIntakeV1({
    record: recordTelegramTransportAttestationV1,
    project: readProviderAccountProjectionV1,
    admit: admitTelegramAccountV1,
    emit: () => undefined,
    now: () => Date.now(),
})

function freshPrincipal() {
    return String(randomInt(1_000_000_000, 2_000_000_000))
}
const freshRef = () => `conn-${randomUUID()}`

function observation(transportRef: string, providerUserId: string) {
    return {
        transportKind: 'mtproto_session' as const,
        transportRef,
        accountKind: 'mtproto_user' as const,
        providerUserId,
        attestingInstanceId: `instance:${transportRef}`,
    }
}

async function bindings(transportRef: string) {
    return await db.$queryRawUnsafe<Array<Record<string, unknown>>>(
        'SELECT * FROM "TelegramTransportBinding" WHERE "transportRef" = $1 ORDER BY "transportGeneration"', transportRef,
    )
}

async function account(accountId: string) {
    const rows = await db.$queryRawUnsafe<Array<Record<string, unknown>>>(
        'SELECT * FROM "TelegramAccount" WHERE "accountId" = $1', accountId,
    )
    return rows[0] ?? null
}

afterAll(async () => {
    await db.$disconnect()
})

proof('the admission ceremony against the real foundation', () => {
    it('attests, reads back and admits in one sequence', async () => {
        const transportRef = freshRef()
        const providerUserId = freshPrincipal()

        const result = await intake.admit(observation(transportRef, providerUserId), PRINCIPAL)
        expect(result).toEqual({ status: 'admitted', reason: 'admitted' })

        const rows = await bindings(transportRef)
        expect(rows).toHaveLength(1)
        expect(rows[0].trustState).toBe('verified')
        expect(rows[0].attestedProviderUserId).toBe(providerUserId)
        expect(String(rows[0].transportGeneration)).toBe('1')
        // The locator is stored exactly as the transport record supplied it.
        expect(rows[0].transportRef).toBe(transportRef)
        expect(rows[0].transportRef).not.toBe(providerUserId)

        const projection = await readProviderAccountProjectionV1('mtproto_session', transportRef)
        expect(projection.lifecycle).toBe('active')
        expect(projection.readiness).toBe('ready')
        const admitted = await account(projection.providerAccountId as string)
        expect(admitted?.lifecycleChangedBy).toBe(PRINCIPAL)
    })

    it('is idempotent for the same principal and opens no second generation', async () => {
        const transportRef = freshRef()
        const providerUserId = freshPrincipal()

        await intake.admit(observation(transportRef, providerUserId), PRINCIPAL)
        const again = await intake.admit(observation(transportRef, providerUserId), PRINCIPAL)

        expect(again).toEqual({ status: 'admitted', reason: 'already_active' })
        expect(await bindings(transportRef)).toHaveLength(1)
    })

    it('replaces the generation when the principal changed and never rewrites the old one', async () => {
        const transportRef = freshRef()
        const first = freshPrincipal()
        const second = freshPrincipal()

        await intake.admit(observation(transportRef, first), PRINCIPAL)
        const firstAccount = (await readProviderAccountProjectionV1('mtproto_session', transportRef)).providerAccountId as string

        const replaced = await intake.admit(observation(transportRef, second), PRINCIPAL)
        expect(replaced).toEqual({ status: 'admitted', reason: 'admitted' })

        const rows = await bindings(transportRef)
        expect(rows).toHaveLength(2)
        expect(rows[0].trustState).toBe('mismatched')
        expect(rows[0].closeReason).toBe('principal_changed')
        expect(rows[0].attestedProviderUserId).toBe(first)
        expect(rows[1].trustState).toBe('verified')
        expect(rows[1].attestedProviderUserId).toBe(second)

        const projection = await readProviderAccountProjectionV1('mtproto_session', transportRef)
        expect(projection.providerAccountId).not.toBe(firstAccount)
        expect((await account(firstAccount))?.lifecycle).toBe('active')
    })

    it('fails closed and creates nothing when the transport kind cannot carry the principal', async () => {
        const transportRef = freshRef()
        const providerUserId = freshPrincipal()

        const result = await intake.admit(
            { ...observation(transportRef, providerUserId), accountKind: 'bot_api' as const },
            PRINCIPAL,
        )
        expect(result).toEqual({ status: 'unavailable', reason: 'attestation_refused' })
        expect(await bindings(transportRef)).toHaveLength(0)
    })

    it('refuses a principal that is not in exact provider form', async () => {
        const transportRef = freshRef()
        const result = await intake.admit(observation(transportRef, '+7000'), PRINCIPAL)
        expect(result.status).toBe('unavailable')
        expect(await bindings(transportRef)).toHaveLength(0)
    })
})

proof('runtime observation against the real foundation', () => {
    it('opens a pending account that the ceremony can later admit without a new generation', async () => {
        const transportRef = freshRef()
        const providerUserId = freshPrincipal()

        await intake.observe(observation(transportRef, providerUserId))
        const observedProjection = await readProviderAccountProjectionV1('mtproto_session', transportRef)
        expect(observedProjection.lifecycle).toBe('pending_approval')
        expect(observedProjection.readiness).toBe('not_admitted')

        const admitted = await intake.admit(observation(transportRef, providerUserId), PRINCIPAL)
        expect(admitted).toEqual({ status: 'admitted', reason: 'admitted' })
        expect(await bindings(transportRef)).toHaveLength(1)
    })

    it('keeps one open binding under concurrent observations of the same transport', async () => {
        const transportRef = freshRef()
        const providerUserId = freshPrincipal()

        await Promise.all([
            intake.observe(observation(transportRef, providerUserId)),
            intake.observe(observation(transportRef, providerUserId)),
            intake.observe(observation(transportRef, providerUserId)),
        ])

        const rows = await bindings(transportRef)
        expect(rows.filter(row => row.closedAt === null)).toHaveLength(1)
        expect(rows).toHaveLength(1)
    })

    it('re-observing a fresh attestation changes nothing', async () => {
        const transportRef = freshRef()
        const providerUserId = freshPrincipal()

        await intake.observe(observation(transportRef, providerUserId))
        const before = (await bindings(transportRef))[0]
        await intake.observe(observation(transportRef, providerUserId))
        const after = (await bindings(transportRef))[0]

        expect(after.attestedUntil).toEqual(before.attestedUntil)
        expect(String(after.transportGeneration)).toBe(String(before.transportGeneration))
    })

    it('never throws when the principal is unusable', async () => {
        const transportRef = freshRef()
        await expect(intake.observe(observation(transportRef, 'not-a-principal'))).resolves.toBeUndefined()
        expect(await bindings(transportRef)).toHaveLength(0)
    })
})

proof('the display read is inert', () => {
    it('cannot admit and cannot create anything', async () => {
        const transportRef = freshRef()

        const empty = await intake.describe('mtproto_session', transportRef)
        expect(empty).toMatchObject({ available: true, providerAccountId: null, readiness: 'no_open_transport' })
        expect(await bindings(transportRef)).toHaveLength(0)

        const providerUserId = freshPrincipal()
        await intake.observe(observation(transportRef, providerUserId))
        const pending = await intake.describe('mtproto_session', transportRef)
        expect(pending.lifecycle).toBe('pending_approval')

        const stillPending = await readProviderAccountProjectionV1('mtproto_session', transportRef)
        expect(stillPending.lifecycle).toBe('pending_approval')
    })
})
