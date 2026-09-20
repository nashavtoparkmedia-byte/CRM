/**
 * Writer tests against an in-memory double of the foundation.
 *
 * The double emulates the guard behaviours this writer depends on: one open
 * binding per slot, a unique bindingSeq per slot, write-once operator
 * confirmation, and transaction rollback. The guards themselves are proven by
 * the real-Postgres test; these tests prove the writer is a correct client of
 * them and that it fails closed when the truth is not known.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = {
    accounts: [] as Array<{ accountId: string; lifecycle: string; lifecycleVersion: number; lifecycleChangedBy: string; lifecycleReason: string }>,
    keys: [] as Array<{ keyKind: string; keyValue: string; accountId: string }>,
    bindings: [] as Array<Record<string, unknown>>,
    now: new Date('2026-09-20T12:00:00.000Z'),
    failNextCreateWith: null as unknown,
}

const WINDOW_MS = 45 * 60 * 1000

function openBindings() {
    return store.bindings.filter((row) => row.closedAt === null)
}

const tx = {
    $queryRaw: async () => [{ now: store.now }],
    whatsAppAccount: {
        create: async ({ data }: any) => {
            store.accounts.push({ ...data })
            return data
        },
        findUnique: async ({ where }: any) => store.accounts.find((a) => a.accountId === where.accountId) ?? null,
        updateMany: async ({ where, data }: any) => {
            const rows = store.accounts.filter((a) => a.accountId === where.accountId
                && (where.lifecycle === undefined || a.lifecycle === where.lifecycle)
                && (where.lifecycleVersion === undefined || a.lifecycleVersion === where.lifecycleVersion))
            rows.forEach((row) => Object.assign(row, data))
            return { count: rows.length }
        },
    },
    whatsAppAccountKey: {
        findMany: async ({ where }: any) => store.keys.filter((k) => where.OR.some((c: any) => c.keyKind === k.keyKind && c.keyValue === k.keyValue)),
        create: async ({ data }: any) => {
            store.keys.push({ ...data })
            return data
        },
    },
    whatsAppTransportBinding: {
        findFirst: async ({ where }: any) => openBindings().find((b) => b.transportRef === where.transportRef) ?? null,
        findUnique: async ({ where }: any) => store.bindings.find((b) => b.bindingId === where.bindingId) ?? null,
        aggregate: async ({ where }: any) => {
            const rows = store.bindings.filter((b) => b.transportRef === where.transportRef)
            return {
                _max: {
                    transportGeneration: rows.length ? rows.reduce((m, r) => (r.transportGeneration as bigint) > m ? r.transportGeneration as bigint : m, BigInt(0)) : null,
                    bindingSeq: rows.length ? Math.max(...rows.map((r) => r.bindingSeq as number)) : null,
                },
            }
        },
        create: async ({ data }: any) => {
            if (store.failNextCreateWith) {
                const error = store.failNextCreateWith
                store.failNextCreateWith = null
                throw error
            }
            // Guard: one open binding per transport.
            if (openBindings().some((b) => b.transportRef === data.transportRef)) {
                throw new Error('WhatsAppTransportBinding cannot open while another binding on the transport is open')
            }
            // Unique (transportKind, transportRef, bindingSeq).
            if (store.bindings.some((b) => b.transportRef === data.transportRef && b.bindingSeq === data.bindingSeq)) {
                throw Object.assign(new Error('unique'), { code: 'P2002' })
            }
            store.bindings.push({ ...data, closedAt: null, closeReason: null, operatorConfirmedAt: null, operatorConfirmedBy: null, lastAttestedAt: store.now })
            return data
        },
        updateMany: async ({ where, data }: any) => {
            const rows = store.bindings.filter((b) => b.bindingId === where.bindingId
                && (where.closedAt === undefined || b.closedAt === where.closedAt)
                && (where.trustState === undefined || b.trustState === where.trustState)
                && (where.operatorConfirmedAt === undefined || b.operatorConfirmedAt === where.operatorConfirmedAt))
            for (const row of rows) {
                Object.assign(row, data)
                // Guard: closing states stamp closedAt from the database clock.
                if (['mismatched', 'revoked', 'closed'].includes(data.trustState)) row.closedAt = store.now
                if (data.attestedUntil !== undefined) row.lastAttestedAt = store.now
            }
            return { count: rows.length }
        },
    },
}

vi.mock('@/lib/prisma', () => ({
    prisma: {
        $transaction: async (fn: (client: unknown) => Promise<unknown>) => {
            // Rows are flat, so a shallow clone per row is a faithful snapshot
            // and, unlike JSON, it preserves BigInt and Date.
            const clone = <T extends Record<string, unknown>>(rows: T[]) => rows.map((row) => ({ ...row }))
            const snapshot = { a: clone(store.accounts), k: clone(store.keys), b: clone(store.bindings) }
            try {
                return await fn(tx)
            } catch (error) {
                // Rollback, so an aborted transaction leaves nothing behind.
                store.accounts = snapshot.a
                store.keys = snapshot.k
                store.bindings = snapshot.b
                throw error
            }
        },
    },
}))

const {
    confirmWhatsAppAccountBindingV1,
    isLostSlotRaceV1,
    readSlotConfirmationProjectionV1,
    recordWhatsAppAccountAttestationV1,
    WhatsAppAccountRefusalV1,
} = await import('./whatsapp-account-writer')

const PN = '79995551122'
const LID = '128773311223344'
const OTHER_PN = '79995559988'
const OTHER_LID = '128773399887766'
const SLOT = 'connection-1'
const INSTANCE = 'instance-1'
const PRINCIPAL = 'identity-access:integration-admin-session'

function observe(overrides: Partial<{ connectionId: string; instanceId: string; pnUser: string; lidUser: string; unchanged: boolean | null }> = {}) {
    return recordWhatsAppAccountAttestationV1({
        connectionId: SLOT, instanceId: INSTANCE, pnUser: PN, lidUser: LID, unchanged: null, ...overrides,
    })
}

function advance(ms: number) {
    store.now = new Date(store.now.getTime() + ms)
}

beforeEach(() => {
    store.accounts = []
    store.keys = []
    store.bindings = []
    store.now = new Date('2026-09-20T12:00:00.000Z')
    store.failNextCreateWith = null
})

describe('observation', () => {
    it('first coherent READY creates a pending_approval account with a complete key set and a pending generation', async () => {
        const result = await observe()
        expect(result).toMatchObject({ action: 'open_first_generation', trustStateAfter: 'pending', accountLifecycle: 'pending_approval', generation: 1 })
        expect(store.accounts).toHaveLength(1)
        expect(store.accounts[0].lifecycle).toBe('pending_approval')
        expect(store.accounts[0].lifecycleVersion).toBe(1)
        expect(store.keys.map((k) => k.keyKind).sort()).toEqual(['whatsapp_lid_user', 'whatsapp_pn_user'])
        expect(store.keys.every((k) => k.accountId === store.accounts[0].accountId)).toBe(true)
        const binding = store.bindings[0]
        expect(binding).toMatchObject({ trustState: 'pending', attestationOrigin: 'transport_asserted', bindingSeq: 1, attestedPnValue: PN, claimedPnValue: PN })
        expect(binding.operatorConfirmedAt).toBeNull()
    })

    it('stores the exact provider form, never a normalized one', async () => {
        await observe()
        expect(store.keys.find((k) => k.keyKind === 'whatsapp_pn_user')?.keyValue).toBe(PN)
        expect(store.bindings[0].attestedPnValue).toBe(PN)
    })

    it('duplicate READY inside a live window writes nothing', async () => {
        await observe()
        const before = store.bindings.map((row) => ({ ...row }))
        const result = await observe({ unchanged: true })
        expect(result.outcome).toBe('attestation_still_fresh')
        expect(store.bindings).toEqual(before)
        expect(store.bindings).toHaveLength(1)
    })

    it('re-attests the same pair after a process restart without opening a generation', async () => {
        await observe()
        advance(WINDOW_MS - 60_000)
        const result = await observe({ unchanged: null, instanceId: 'instance-2' })
        expect(result).toMatchObject({ action: 'reattest_open_generation', outcome: 'reattested' })
        expect(store.bindings).toHaveLength(1)
        expect(store.bindings[0].attestingInstanceId).toBe('instance-2')
        expect(store.bindings[0].transportGeneration).toBe(BigInt(1))
    })

    it('re-attests a verified binding whose window lapsed', async () => {
        await observe()
        store.bindings[0].trustState = 'verified'
        store.bindings[0].operatorConfirmedAt = store.now
        advance(WINDOW_MS + 60_000)
        const result = await observe({ unchanged: null })
        expect(result.outcome).toBe('reattested')
        expect(store.bindings).toHaveLength(1)
        expect(store.bindings[0].trustState).toBe('verified')
    })

    it('supersedes an expired pending generation and opens the next one', async () => {
        await observe()
        advance(WINDOW_MS + 60_000)
        const result = await observe({ unchanged: true })
        expect(result).toMatchObject({ action: 'supersede_expired_generation', generation: 2 })
        expect(store.bindings).toHaveLength(2)
        expect(store.bindings[0]).toMatchObject({ trustState: 'closed', closeReason: 'superseded' })
        expect(store.bindings[0].closedAt).not.toBeNull()
        expect(store.bindings[1]).toMatchObject({ trustState: 'pending', bindingSeq: 2, transportGeneration: BigInt(2) })
    })

    it('a re-pair mismatches the previous generation and opens the next for the new account', async () => {
        await observe()
        advance(60_000)
        const result = await observe({ pnUser: OTHER_PN, lidUser: OTHER_LID, unchanged: false })
        expect(result).toMatchObject({ action: 'replace_mismatched_generation', generation: 2 })
        expect(store.bindings[0]).toMatchObject({ trustState: 'mismatched', closeReason: 'account_changed' })
        expect(store.accounts).toHaveLength(2)
        expect(store.bindings[1].accountId).not.toBe(store.bindings[0].accountId)
    })

    it('refuses a split key set and leaves the foundation untouched', async () => {
        await observe()
        const accounts = store.accounts.length
        const bindings = store.bindings.length
        // The observed LID now belongs to a second account.
        store.keys.push({ keyKind: 'whatsapp_lid_user', keyValue: OTHER_LID, accountId: 'account-other' })
        advance(60_000)
        await expect(observe({ lidUser: OTHER_LID, unchanged: false })).rejects.toBeInstanceOf(WhatsAppAccountRefusalV1)
        expect(store.accounts).toHaveLength(accounts)
        expect(store.bindings).toHaveLength(bindings)
        expect(store.bindings[0].closedAt).toBeNull()
    })

    it('refuses a half set, where only one half is already owned', async () => {
        store.accounts.push({ accountId: 'account-x', lifecycle: 'active', lifecycleVersion: 2, lifecycleChangedBy: 'x', lifecycleReason: 'x' })
        store.keys.push({ keyKind: 'whatsapp_pn_user', keyValue: PN, accountId: 'account-x' })
        await expect(observe()).rejects.toBeInstanceOf(WhatsAppAccountRefusalV1)
        expect(store.bindings).toHaveLength(0)
    })

    it('writes nothing for an observation that is not a usable pair', async () => {
        const result = await observe({ lidUser: PN })
        expect(result.outcome).toBe('pair_not_usable')
        expect(store.bindings).toHaveLength(0)
        expect(store.accounts).toHaveLength(0)
    })

    it('refuses rather than rewriting identity when the runtime signal contradicts the database', async () => {
        await observe()
        advance(60_000)
        const claimsUnchanged = await observe({ pnUser: OTHER_PN, lidUser: OTHER_LID, unchanged: true })
        expect(claimsUnchanged.outcome).toBe('contradiction_unchanged_true_pair_differs')
        const claimsChanged = await observe({ unchanged: false })
        expect(claimsChanged.outcome).toBe('contradiction_unchanged_false_pair_equal')
        expect(store.bindings).toHaveLength(1)
        expect(store.bindings[0].trustState).toBe('pending')
        expect(store.accounts).toHaveLength(1)
    })
})

describe('concurrency', () => {
    it('recognises the refusals that mean another writer reached the slot first', () => {
        expect(isLostSlotRaceV1(Object.assign(new Error('x'), { code: 'P2002' }))).toBe(true)
        expect(isLostSlotRaceV1(new Error('WhatsAppTransportBinding cannot open while another binding on the transport is open'))).toBe(true)
        expect(isLostSlotRaceV1(new Error('WhatsAppTransportBinding history must advance: bindingSeq and transportGeneration both strictly increase'))).toBe(true)
        expect(isLostSlotRaceV1(new Error('something else'))).toBe(false)
    })

    it('a lost first-READY race re-reads once and converges on the winner', async () => {
        // The winner commits between this writer's read and its insert.
        store.failNextCreateWith = (() => {
            const error = Object.assign(new Error('unique'), { code: 'P2002' })
            return error
        })()
        const winnerAccount = 'account-winner'
        store.accounts.push({ accountId: winnerAccount, lifecycle: 'pending_approval', lifecycleVersion: 1, lifecycleChangedBy: 'w', lifecycleReason: 'w' })
        store.keys.push({ keyKind: 'whatsapp_pn_user', keyValue: PN, accountId: winnerAccount })
        store.keys.push({ keyKind: 'whatsapp_lid_user', keyValue: LID, accountId: winnerAccount })
        store.bindings.push({
            bindingId: 'winner', transportKind: 'whatsapp_web_slot', transportRef: SLOT, transportGeneration: BigInt(1), accountId: winnerAccount,
            bindingSeq: 1, trustState: 'pending', attestationOrigin: 'transport_asserted',
            attestedPnValue: PN, attestedLidValue: LID, claimedPnValue: PN, claimedLidValue: LID,
            attestingInstanceId: 'winner', attestedUntil: new Date(store.now.getTime() + WINDOW_MS),
            closedAt: null, closeReason: null, operatorConfirmedAt: null, operatorConfirmedBy: null, lastAttestedAt: store.now,
        })

        const result = await observe({ unchanged: null })
        expect(result.outcome).toBe('attestation_still_fresh')
        expect(store.bindings).toHaveLength(1)
        expect(store.bindings[0].bindingId).toBe('winner')
    })

    it('a lost different-pair race converges on replacing the winner generation, never on two open bindings', async () => {
        await observe()
        advance(60_000)
        store.failNextCreateWith = new Error('WhatsAppTransportBinding cannot open while another binding on the transport is open')
        const result = await observe({ pnUser: OTHER_PN, lidUser: OTHER_LID, unchanged: null })
        expect(result.action).toBe('replace_mismatched_generation')
        expect(openBindings()).toHaveLength(1)
        expect(store.bindings.filter((b) => b.closedAt === null)[0].attestedPnValue).toBe(OTHER_PN)
    })
})

describe('confirmation', () => {
    async function pendingBinding() {
        await observe()
        return store.bindings[0].bindingId as string
    }

    it('promotes the account and the binding together', async () => {
        const bindingId = await pendingBinding()
        const result = await confirmWhatsAppAccountBindingV1({ connectionId: SLOT, bindingId, principalId: PRINCIPAL })
        expect(result).toMatchObject({ outcome: 'confirmed', trustStateAfter: 'verified', accountLifecycle: 'active' })
        expect(store.accounts[0]).toMatchObject({ lifecycle: 'active', lifecycleVersion: 2, lifecycleChangedBy: PRINCIPAL })
        expect(store.bindings[0]).toMatchObject({ trustState: 'verified', operatorConfirmedBy: PRINCIPAL })
        expect(store.bindings[0].operatorConfirmedAt).not.toBeNull()
    })

    it('records the authenticated shared principal, never an unsigned selector', async () => {
        const bindingId = await pendingBinding()
        await confirmWhatsAppAccountBindingV1({ connectionId: SLOT, bindingId, principalId: PRINCIPAL })
        expect(store.bindings[0].operatorConfirmedBy).toBe('identity-access:integration-admin-session')
        expect(String(store.bindings[0].operatorConfirmedBy)).not.toMatch(/^u\d+$/u)
    })

    it('is idempotent: a duplicate confirmation changes nothing', async () => {
        const bindingId = await pendingBinding()
        await confirmWhatsAppAccountBindingV1({ connectionId: SLOT, bindingId, principalId: PRINCIPAL })
        const stamped = store.bindings[0].operatorConfirmedAt
        const again = await confirmWhatsAppAccountBindingV1({ connectionId: SLOT, bindingId, principalId: 'identity-access:someone-else' })
        expect(again.outcome).toBe('already_confirmed')
        expect(store.bindings[0].operatorConfirmedAt).toBe(stamped)
        expect(store.bindings[0].operatorConfirmedBy).toBe(PRINCIPAL)
        expect(store.accounts[0].lifecycleVersion).toBe(2)
    })

    it('refuses a stale attestation by database time and writes nothing', async () => {
        const bindingId = await pendingBinding()
        advance(WINDOW_MS + 1000)
        const result = await confirmWhatsAppAccountBindingV1({ connectionId: SLOT, bindingId, principalId: PRINCIPAL })
        expect(result.outcome).toBe('attestation_stale')
        expect(store.bindings[0].trustState).toBe('pending')
        expect(store.accounts[0].lifecycle).toBe('pending_approval')
    })

    it('refuses a binding that belongs to another slot, so a tampered request cannot confirm it', async () => {
        const bindingId = await pendingBinding()
        const result = await confirmWhatsAppAccountBindingV1({ connectionId: 'connection-other', bindingId, principalId: PRINCIPAL })
        expect(result.outcome).toBe('transport_mismatch')
        expect(store.bindings[0].trustState).toBe('pending')
        expect(store.accounts[0].lifecycle).toBe('pending_approval')
    })

    it('refuses an unknown binding id', async () => {
        await pendingBinding()
        const result = await confirmWhatsAppAccountBindingV1({ connectionId: SLOT, bindingId: 'does-not-exist', principalId: PRINCIPAL })
        expect(result.outcome).toBe('binding_not_found')
    })

    it('refuses an absent or malformed principal before touching the database', async () => {
        const bindingId = await pendingBinding()
        for (const principalId of ['', '   ', 'bad principal', 'x'.repeat(129)]) {
            const result = await confirmWhatsAppAccountBindingV1({ connectionId: SLOT, bindingId, principalId })
            expect(result.outcome).toBe('unauthenticated')
        }
        expect(store.bindings[0].operatorConfirmedAt).toBeNull()
        expect(store.accounts[0].lifecycle).toBe('pending_approval')
    })

    it('refuses to confirm a closed generation', async () => {
        const bindingId = await pendingBinding()
        advance(WINDOW_MS + 60_000)
        await observe({ unchanged: true })
        const result = await confirmWhatsAppAccountBindingV1({ connectionId: SLOT, bindingId, principalId: PRINCIPAL })
        expect(result.outcome).toBe('binding_not_open')
    })
})

describe('confirmation projection', () => {
    it('carries a display PN and the connection context, and never a LID', async () => {
        await observe()
        const projection = await readSlotConfirmationProjectionV1(SLOT)
        expect(projection).toMatchObject({ connectionId: SLOT, generation: 1, trustState: 'pending', accountLifecycle: 'pending_approval', confirmable: true })
        expect(projection.pnDisplay).toBe('+7 999 555-11-22')
        const serialized = JSON.stringify(projection)
        expect(serialized).not.toContain(LID)
        expect(serialized).not.toContain(PN)
    })

    it('is not confirmable once the attestation is stale', async () => {
        await observe()
        advance(WINDOW_MS + 1000)
        const projection = await readSlotConfirmationProjectionV1(SLOT)
        expect(projection).toMatchObject({ attestationFresh: false, confirmable: false })
    })

    it('reports an empty slot without inventing one', async () => {
        const projection = await readSlotConfirmationProjectionV1('connection-empty')
        expect(projection).toMatchObject({ bindingId: null, trustState: 'absent', accountLifecycle: 'absent', confirmable: false, pnDisplay: null })
    })
})
