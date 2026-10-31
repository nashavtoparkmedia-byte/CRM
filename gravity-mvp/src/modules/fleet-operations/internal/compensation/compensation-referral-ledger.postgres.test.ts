/**
 * Isolated-PostgreSQL proof for the Cash referral ledger and its store.
 *
 * Runs against a disposable database that holds only the referral
 * migration: the two tables refer to nothing else. What has to be
 * established is that the ledger is append-only, that only the writer each
 * kind admits can write it, that the first Telegram account owns an
 * invitation and one person holds one qualified invitation, that two
 * writers on one chain cannot both commit, that a repeated idempotency key
 * writes nothing new, and that the verifier finds a row changed behind the
 * trigger.
 *
 * Gated behind YOKO_COMPENSATION_MONETARY_POSTGRES_PROOF=1 and an isolated
 * DATABASE_URL.
 */

import { createHash } from 'node:crypto'

import { PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { cashReferralPersonKeyDigestV1, verifyCashAccessChainV1 } from './compensation-referral-ledger'
import { CashAccessVersionConflictV1, legacyPrismaCashReferralLedgerStoreV1 as store } from './legacy-prisma-cash-referral-ledger-adapter'

const proof = process.env.YOKO_COMPENSATION_MONETARY_POSTGRES_PROOF === '1' ? describe : describe.skip

let database: PrismaClient
let n = 0
const unique = (prefix: string) => `${prefix}-${process.pid}-${Date.now()}-${(n += 1)}`

const systemDraft = (chainContactId: string, idempotencyKey: string) => ({
    chainContactId,
    kind: 'referral_code_issued' as const,
    lineageDigest: 'lineage:1',
    codeHash: createHash('sha256').update(idempotencyKey).digest('hex'),
    attributionId: null,
    payload: {},
    actor: { kind: 'system' as const, id: 'system:test' },
    reason: null,
    idempotencyKey,
})

proof('Cash referral ledger on real PostgreSQL', () => {
    beforeAll(async () => {
        database = new PrismaClient()
        await database.$connect()
    })
    afterAll(async () => {
        await database.$disconnect()
    })

    it('refuses every update, delete and truncate of a ledger row', async () => {
        const contact = unique('contact')
        await store.issueCode({ inviterContactId: contact, lineageDigest: 'lineage:1' })
        await expect(database.$executeRawUnsafe(`UPDATE "CashAccessEvent" SET "payload" = '{"x":1}'::jsonb WHERE "chainContactId" = $1`, contact))
            .rejects.toThrow(/append-only/)
        await expect(database.$executeRawUnsafe(`DELETE FROM "CashAccessEvent" WHERE "chainContactId" = $1`, contact))
            .rejects.toThrow(/append-only/)
        await expect(database.$executeRawUnsafe(`TRUNCATE "CashAccessEvent" CASCADE`)).rejects.toThrow(/append-only/)
    })

    it('admits each kind only from its one writer', async () => {
        const insert = (kind: string, actorKind: string, capability: string | null, reason: string | null, session: string | null) =>
            database.$executeRawUnsafe(
                `INSERT INTO "CashAccessEvent" ("id","chainContactId","seq","kind","lineageDigest","payload","actorKind","actorId","actorCapability","actorSessionId","actorAuthenticatedAt","reason","idempotencyKey","occurredAt","prevHash","hash")
                 VALUES ($1,$2,1,$3,'l','{}'::jsonb,$4,'actor',$5,$6,$10::timestamptz,$7,$8,now(),NULL,$9)`,
                unique('id'), unique('contact'), kind, actorKind, capability, session, reason, unique('key'), 'c'.repeat(64), session === null ? null : new Date(),
            )
        // A manager kind written by the system, or without its capability, session or reason.
        await expect(insert('manual_granted', 'system', null, null, null)).rejects.toThrow(/writer_check/)
        await expect(insert('manual_granted', 'signed_staff_session', 'cash.access.view', 'checked the documents', 'session-1')).rejects.toThrow(/writer_check/)
        await expect(insert('manual_granted', 'signed_staff_session', 'cash.access.manage', 'short', 'session-1')).rejects.toThrow(/writer_check/)
        await expect(insert('manual_granted', 'signed_staff_session', 'cash.access.manage', 'checked the documents', null)).rejects.toThrow(/writer_check/)
        await expect(insert('referral_sanctioned', 'signed_staff_session', 'cash.access.manage', 'checked the documents', 'session-1')).rejects.toThrow(/writer_check|attribution_check/)
        // A system kind written by a staff session.
        await expect(insert('referral_entitlement_granted', 'signed_staff_session', 'cash.access.manage', 'checked the documents', 'session-1')).rejects.toThrow(/writer_check|attribution_check/)
        // The admitted form is accepted.
        await expect(insert('manual_granted', 'signed_staff_session', 'cash.access.manage', 'checked the documents', 'session-1')).resolves.toBe(1)
    })

    it('lets the first Telegram account own an invitation and says nothing different to the others', async () => {
        const inviter = unique('inviter')
        const { token } = await store.issueCode({ inviterContactId: inviter, lineageDigest: 'lineage:1' })
        const invitee = unique('tg')
        expect(await store.capture({ token, inviteeTelegramUserId: invitee })).toBe('captured')
        expect(await store.capture({ token, inviteeTelegramUserId: invitee })).toBe('already_attributed')
        const second = await store.issueCode({ inviterContactId: unique('other-inviter'), lineageDigest: 'lineage:1' })
        expect(await store.capture({ token: second.token, inviteeTelegramUserId: invitee })).toBe('already_attributed')
        expect(await store.capture({ token: 'r_unknown', inviteeTelegramUserId: unique('tg') })).toBe('unknown_code')

        const chain = await store.readChain(inviter)
        expect(chain.map((event) => event.kind)).toEqual(['referral_code_issued', 'referral_captured'])
        expect(verifyCashAccessChainV1(chain)).toEqual({ ok: true, length: 2 })
        // Only the hash of the token is kept.
        const kept = await database.$queryRawUnsafe<Array<{ count: bigint }>>(
            `SELECT count(*) AS "count" FROM "CashAccessEvent" WHERE "payload"::text LIKE $1 OR "codeHash" = $2`, `%${token}%`, token)
        expect(Number(kept[0].count)).toBe(0)
    })

    it('stamps every row with the database clock, never a client time', async () => {
        const contact = unique('contact')
        const before = await database.$queryRawUnsafe<Array<{ now: Date }>>(`SELECT now() AS "now"`)
        const row = await store.append(systemDraft(contact, unique('key')))
        const after = await database.$queryRawUnsafe<Array<{ now: Date }>>(`SELECT now() AS "now"`)
        expect(row.occurredAt.getTime()).toBeGreaterThanOrEqual(new Date(before[0].now).getTime() - 1)
        expect(row.occurredAt.getTime()).toBeLessThanOrEqual(new Date(after[0].now).getTime())
        expect(verifyCashAccessChainV1(await store.readChain(contact)).ok).toBe(true)
    })

    it('writes a repeated idempotency key once', async () => {
        const contact = unique('contact')
        const key = unique('key')
        const first = await store.append(systemDraft(contact, key))
        const again = await store.append(systemDraft(contact, key))
        expect(again.hash).toBe(first.hash)
        expect((await store.readChain(contact)).length).toBe(1)
    })

    it('never lets two writers commit the same place in a chain', async () => {
        const contact = unique('contact')
        const outcomes = await Promise.allSettled(Array.from({ length: 8 }, () => store.append(systemDraft(contact, unique('key')))))
        const won = outcomes.filter((outcome) => outcome.status === 'fulfilled').length
        const lost = outcomes.filter((outcome) => outcome.status === 'rejected')
        expect(won).toBeGreaterThanOrEqual(1)
        for (const outcome of lost) expect((outcome as PromiseRejectedResult).reason).toBeInstanceOf(CashAccessVersionConflictV1)
        const chain = await store.readChain(contact)
        expect(chain.length).toBe(won)
        expect(verifyCashAccessChainV1(chain)).toEqual({ ok: true, length: won })
    })

    it('records a decision once per version, grants in the same unit, and admits one qualified invitation per person', async () => {
        const inviter = unique('inviter')
        const { token } = await store.issueCode({ inviterContactId: inviter, lineageDigest: 'lineage:1' })
        expect(await store.capture({ token, inviteeTelegramUserId: unique('tg') })).toBe('captured')
        const [attribution] = (await store.findUndecided(1000)).filter((row) => row.inviterContactId === inviter)
        const personKey = cashReferralPersonKeyDigestV1(unique('vu'))
        const write = {
            attributionId: attribution.id,
            expectedVersion: attribution.version,
            state: 'qualified' as const,
            reason: null,
            inviteeContactId: unique('invitee-contact'),
            inviteePersonKey: personKey,
            targetParkId: 'park-1',
            factsSnapshot: { targetParkId: 'park-1', isSelfEmployed: true },
            decision: { outcome: 'qualified', via: 'returned_park_smz' },
            grant: true,
            observedDismissals: [{ profileKey: 'park-1:profile-old', dismissedAt: new Date('2026-07-11T12:00:00.000Z'), readAt: new Date('2026-11-05T19:00:00.000Z') }],
            idempotencyKey: `decision:${attribution.id}:${attribution.version}`,
        }
        expect(await store.writeDecision(write)).toBe('written')
        expect(await store.writeDecision(write)).toBe('version_conflict')
        expect(await store.findAttribution(attribution.id)).toMatchObject({ state: 'qualified', inviteePersonKey: personKey, version: attribution.version + 1 })
        const chain = await store.readChain(inviter)
        expect(chain.map((event) => event.kind)).toEqual([
            'referral_code_issued', 'referral_captured', 'invitee_dismissal_observed', 'referral_decided', 'referral_entitlement_granted',
        ])
        expect(verifyCashAccessChainV1(chain).ok).toBe(true)

        // A second invitation of the same person cannot also qualify.
        const other = unique('inviter')
        const code = await store.issueCode({ inviterContactId: other, lineageDigest: 'lineage:1' })
        expect(await store.capture({ token: code.token, inviteeTelegramUserId: unique('tg') })).toBe('captured')
        const [second] = (await store.findUndecided(1000)).filter((row) => row.inviterContactId === other)
        expect(await store.personAlreadyQualified(personKey, second.id)).toBe(true)
        expect(await store.writeDecision({ ...write, attributionId: second.id, expectedVersion: second.version, idempotencyKey: `decision:${second.id}:0`, observedDismissals: [] }))
            .toBe('person_already_qualified')
        expect(await store.findAttribution(second.id)).toMatchObject({ state: 'captured', version: second.version })
        expect((await store.readChain(other)).map((event) => event.kind)).toEqual(['referral_code_issued', 'referral_captured'])
        expect(await store.countByInviter(inviter)).toEqual({ qualified: 1 })
    })

    it('finds a row changed behind the append-only trigger', async () => {
        const contact = unique('contact')
        await store.append(systemDraft(contact, unique('key')))
        await store.append(systemDraft(contact, unique('key')))
        await database.$executeRawUnsafe(`ALTER TABLE "CashAccessEvent" DISABLE TRIGGER "CashAccessEvent_append_only_row"`)
        try {
            await database.$executeRawUnsafe(`UPDATE "CashAccessEvent" SET "payload" = '{"forged":true}'::jsonb WHERE "chainContactId" = $1 AND "seq" = 1`, contact)
        } finally {
            await database.$executeRawUnsafe(`ALTER TABLE "CashAccessEvent" ENABLE TRIGGER "CashAccessEvent_append_only_row"`)
        }
        expect(verifyCashAccessChainV1(await store.readChain(contact))).toEqual({ ok: false, problem: 'hash_mismatch', seq: 1 })
    })
})
