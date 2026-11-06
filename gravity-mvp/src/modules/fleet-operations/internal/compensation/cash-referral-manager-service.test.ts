import { beforeEach, describe, expect, it } from 'vitest'

import { compensationLineageDigestV1 } from './compensation-pilot-lineage'
import { cashAccessEventHashV1, foldCashAccessLedgerV1, verifyCashAccessChainV1, type CashAccessEventV1 } from './compensation-referral-ledger'
import type { CashReferralInvitationRowV1, CashReferralManagerProfileV1, CashStaffAuthorityV1 } from './cash-referral-manager'
import {
    cashReferralPersonCardV1,
    grantCashAccessV1,
    recordCashReferralInvitationV1,
    revokeCashAccessV1,
    searchCashReferralPeopleV1,
    withdrawCashReferralInvitationV1,
    type CashReferralManagerPortV1,
} from './cash-referral-manager-service'
import type { CashAccessEventDraftV1 } from './legacy-prisma-cash-referral-ledger-adapter'

/**
 * The manager's referral tools end to end over an in-memory store that keeps
 * the database's rules: append-only hash-chained events with unique
 * idempotency keys, one counted invitation per invitee, and a version on each
 * row. Every chain written here must still verify.
 */

const NOW = new Date('2026-11-06T12:00:00.000Z')

const STAFF: CashStaffAuthorityV1 = {
    principalId: 'staff:maria',
    operatorLabel: 'Мария Иванова',
    sessionId: 'session-1',
    authenticatedAt: new Date('2026-11-06T09:00:00.000Z'),
    capabilities: ['cash.referral.qualify', 'cash.access.manage'],
}

let requestCounter = 0
const requestId = () => `00000000-0000-4000-8000-${String((requestCounter += 1)).padStart(12, '0')}`

function profile(driverId: string, contactId: string, fullName: string, over: Partial<CashReferralManagerProfileV1> = {}): CashReferralManagerProfileV1 {
    return {
        driverId,
        fullName,
        phone: null,
        licenseNumber: null,
        externalParkId: 'park-1',
        parkName: 'Парк 1',
        employmentType: 'selfemployed',
        isSelfEmployed: true,
        dismissed: false,
        contactId,
        ...over,
    }
}

class MemoryStore {
    profiles: CashReferralManagerProfileV1[] = []
    lineages = new Map<string, string[]>()
    events: CashAccessEventV1[] = []
    rows: CashReferralInvitationRowV1[] = []
    /** Writes that fail as if another writer got there first, once each. */
    injectConflicts = 0
    injectBusy = 0

    private append(draft: CashAccessEventDraftV1): void {
        if (this.events.some((event) => event.idempotencyKey === draft.idempotencyKey)) throw new Error('duplicate key value')
        const chain = this.events.filter((event) => event.chainContactId === draft.chainContactId)
        const staff = draft.actor.kind === 'signed_staff_session' ? draft.actor : null
        const unhashed: Omit<CashAccessEventV1, 'hash'> = {
            id: `ev-${this.events.length + 1}`,
            chainContactId: draft.chainContactId,
            seq: chain.length + 1,
            kind: draft.kind,
            lineageDigest: draft.lineageDigest,
            codeHash: draft.codeHash,
            attributionId: draft.attributionId,
            payload: draft.payload,
            actorKind: draft.actor.kind,
            actorId: draft.actor.id,
            actorCapability: staff?.capability ?? null,
            actorSessionId: staff?.sessionId ?? null,
            actorAuthenticatedAt: staff?.authenticatedAt ?? null,
            reason: draft.reason,
            idempotencyKey: draft.idempotencyKey,
            occurredAt: new Date(NOW.getTime() + this.events.length * 1000),
            prevHash: chain.length === 0 ? null : chain[chain.length - 1].hash,
        }
        this.events.push({ ...unhashed, hash: cashAccessEventHashV1(unhashed) })
    }

    port(): CashReferralManagerPortV1 {
        return {
            now: () => NOW,
            parkNames: async () => new Map([['park-1', 'Парк 1'], ['park-2', 'Парк 2']]),
            searchProfiles: async (query) => this.profiles
                .filter((p) => query.nameTokens.length > 0 && query.nameTokens.every((token) => p.fullName.toLowerCase().includes(token)))
                .map((p) => ({ profile: p, matchedBy: ['name' as const] })),
            profilesOfContacts: async (ids) => this.profiles.filter((p) => p.contactId !== null && ids.includes(p.contactId)),
            resolveLineage: async (contactId) => {
                for (const [canonical, lineage] of this.lineages) {
                    if (lineage.includes(contactId)) return { status: 'resolved', canonicalContactId: canonical, contactIds: lineage }
                }
                return { status: 'missing' }
            },
            confirmedMainDriver: async (_contactId, driverIds) => (driverIds.length > 0 ? { status: 'confirmed', driverId: driverIds[0] } : { status: 'not_confirmed' }),
            readChain: async (id) => this.events.filter((event) => event.chainContactId === id),
            listInvitationsOfContacts: async (ids) => this.rows.filter((row) => ids.includes(row.inviterContactId) || (row.inviteeContactId !== null && ids.includes(row.inviteeContactId))),
            findInvitation: async (id) => this.rows.find((row) => row.attributionId === id) ?? null,
            readInvitationLinkEvents: async (ids) => this.events.filter((event) => typeof event.payload.invitationId === 'string' && ids.includes(event.payload.invitationId)
                && (event.kind === 'referral_link_recorded' || event.kind === 'referral_link_withdrawn')),
            recordManagerInvitation: async (input) => {
                const replay = this.events.find((event) => event.idempotencyKey === input.idempotencyKey)
                if (typeof replay?.payload.invitationId === 'string') return { outcome: 'already_recorded', attributionId: replay.payload.invitationId }
                if (this.injectBusy > 0) { this.injectBusy -= 1; return { outcome: 'busy' } }
                if (this.injectConflicts > 0) {
                    this.injectConflicts -= 1
                    // Another manager records the same invitee for someone else meanwhile.
                    this.rows.push({ attributionId: 'att-rival', source: 'manager', state: 'recorded', inviterContactId: 'contact-C', inviteeContactId: input.inviteeContactId, capturedAt: NOW, decidedAt: NOW, version: 0 })
                    return { outcome: 'conflict' }
                }
                if (this.rows.some((row) => row.inviteeContactId !== null
                    && [input.inviteeContactId, ...input.inviteeLineage].includes(row.inviteeContactId)
                    && (row.state === 'recorded' || row.state === 'qualified'))) {
                    return { outcome: 'conflict' }
                }
                const attributionId = `att-${this.rows.length + 1}`
                this.rows.push({ attributionId, source: 'manager', state: 'recorded', inviterContactId: input.inviterContactId, inviteeContactId: input.inviteeContactId, capturedAt: NOW, decidedAt: NOW, version: 0 })
                this.append({ chainContactId: input.inviterContactId, kind: 'referral_link_recorded', lineageDigest: input.inviterLineageDigest, codeHash: null, attributionId: null, payload: { ...input.payload, invitationId: attributionId, inviteeContactId: input.inviteeContactId }, actor: input.actor, reason: input.reason, idempotencyKey: input.idempotencyKey })
                return { outcome: 'recorded', attributionId }
            },
            withdrawManagerInvitation: async (input) => {
                if (this.events.some((event) => event.idempotencyKey === input.idempotencyKey)) return 'already_withdrawn'
                const row = this.rows.find((r) => r.attributionId === input.attributionId && r.version === input.expectedVersion && r.source === 'manager' && r.state === 'recorded')
                if (!row) return 'version_conflict'
                row.state = 'withdrawn'
                row.version += 1
                this.append({ chainContactId: row.inviterContactId, kind: 'referral_link_withdrawn', lineageDigest: compensationLineageDigestV1([row.inviterContactId]), codeHash: null, attributionId: null, payload: { ...input.payload, invitationId: row.attributionId }, actor: input.actor, reason: input.reason, idempotencyKey: input.idempotencyKey })
                return 'withdrawn'
            },
            appendManagerAccessEvents: async (drafts) => {
                if (this.events.some((event) => event.idempotencyKey === drafts[0].idempotencyKey)) return 'already_written'
                if (this.injectBusy > 0) { this.injectBusy -= 1; return 'busy' }
                for (const draft of drafts) this.append(draft)
                return 'written'
            },
        }
    }

    chainOf(contactId: string) {
        return this.events.filter((event) => event.chainContactId === contactId)
    }
}

let store: MemoryStore
let port: CashReferralManagerPortV1

beforeEach(() => {
    store = new MemoryStore()
    // Иванов: two parks, one person. Сидоров and Петров: one park each.
    store.profiles = [
        profile('d-ivanov-1', 'contact-A', 'Иванов Иван Иванович', { licenseNumber: '9912 345678' }),
        profile('d-ivanov-2', 'contact-A', 'Иванов Иван Иванович', { parkName: 'Парк 2', externalParkId: 'park-2', licenseNumber: '9912345678' }),
        profile('d-sidorov', 'contact-B', 'Сидоров Сергей Петрович', { licenseNumber: '9900 111111' }),
        profile('d-petrov', 'contact-P', 'Петров Алексей', { licenseNumber: '9900 222222' }),
        profile('d-ivanov-namesake', 'contact-N', 'Иванов Иван Сергеевич', { licenseNumber: '9900 333333' }),
    ]
    store.lineages = new Map([
        ['contact-A', ['contact-A']],
        ['contact-B', ['contact-B']],
        ['contact-P', ['contact-P']],
        ['contact-N', ['contact-N']],
        ['contact-C', ['contact-C']],
        ['contact-M', ['contact-M', 'contact-M2']],
    ])
    port = store.port()
})

const record = (inviterContactId: string, inviteeContactId: string, id = requestId()) =>
    recordCashReferralInvitationV1(port, { inviterContactId, inviteeContactId, comment: null, requestId: id, authority: STAFF })

describe('scenario A: recording an invitation', () => {
    it('finds Иванов as one person across two parks, apart from his namesake', async () => {
        const result = await searchCashReferralPeopleV1(port, 'Иванов Иван')
        expect(result.status).toBe('ok')
        if (result.status !== 'ok') return
        const people = result.candidates.filter((c) => c.selectable)
        expect(people).toHaveLength(2)
        const ivanov = people.find((c) => c.selectable && c.personContactId === 'contact-A')
        expect(ivanov?.profiles.map((p) => p.parkName)).toEqual(['Парк 1', 'Парк 2'])
        expect(await searchCashReferralPeopleV1(port, 'Кузьмин')).toEqual({ status: 'ok', candidates: [], truncated: false })
    })

    it('records Иванов → Сидоров, shows it in Иванов\'s history, and leaves both people\'s access as it was', async () => {
        const result = await record('contact-A', 'contact-B')
        expect(result).toEqual({ status: 'recorded', attributionId: 'att-1' })

        const card = await cashReferralPersonCardV1(port, 'contact-A')
        expect(card.status).toBe('ok')
        if (card.status !== 'ok') return
        expect(card.card.invited).toEqual([expect.objectContaining({
            source: 'manager', state: 'recorded', otherContactId: 'contact-B', otherName: 'Сидоров Сергей Петрович',
            recordedBy: 'Мария Иванова', withdrawable: true,
        })])
        expect(card.card.access.state).toBe('none')

        const sidorov = await cashReferralPersonCardV1(port, 'contact-B')
        if (sidorov.status !== 'ok') throw new Error('no card')
        expect(sidorov.card.invitedBy).toEqual([expect.objectContaining({ otherContactId: 'contact-A', otherName: 'Иванов Иван Иванович' })])
        expect(sidorov.card.access.state).toBe('none')

        // The record lives on the inviter's chain, verifies, and folds into no access at all.
        const chain = store.chainOf('contact-A')
        expect(verifyCashAccessChainV1(chain)).toEqual({ ok: true, length: 1 })
        expect(foldCashAccessLedgerV1(chain, compensationLineageDigestV1(['contact-A']))).toEqual({ referral: null, manual: null, staleLineage: false })
    })

    it('writes nothing twice: a retried request and a second press both answer with the record that stands', async () => {
        const id = requestId()
        await record('contact-A', 'contact-B', id)
        expect(await record('contact-A', 'contact-B', id)).toEqual({ status: 'already_recorded', attributionId: 'att-1' })
        expect(await record('contact-A', 'contact-B')).toEqual({ status: 'already_recorded', attributionId: 'att-1' })
        expect(store.rows).toHaveLength(1)
        expect(store.events).toHaveLength(1)
    })

    it('refuses a self-invitation and a second inviter for the same invitee', async () => {
        expect(await record('contact-A', 'contact-A')).toEqual({ status: 'refused', reason: 'self_invitation' })
        await record('contact-A', 'contact-B')
        expect(await record('contact-P', 'contact-B')).toEqual({
            status: 'refused', reason: 'invitee_already_attributed', inviterContactId: 'contact-A', inviterName: 'Иванов Иван Иванович',
        })
    })

    it('refuses the same licence under two contacts as one person', async () => {
        store.profiles.push(profile('d-dup', 'contact-C', 'Иванов И.', { licenseNumber: '99-12-345678' }))
        expect(await record('contact-A', 'contact-C')).toEqual({ status: 'refused', reason: 'self_invitation' })
    })

    it('reads again when another manager records the same invitee meanwhile, and says who has them', async () => {
        store.injectConflicts = 1
        expect(await record('contact-A', 'contact-B')).toMatchObject({ status: 'refused', reason: 'invitee_already_attributed', inviterContactId: 'contact-C' })
    })

    it('reports a chain that stays busy instead of guessing', async () => {
        store.injectBusy = 2
        expect(await record('contact-A', 'contact-B')).toEqual({ status: 'refused', reason: 'busy' })
        expect(store.rows).toHaveLength(0)
    })

    it('refuses a screen that names a contact merged away since', async () => {
        expect(await record('contact-M2', 'contact-B')).toEqual({ status: 'refused', reason: 'person_changed' })
        expect(await record('contact-unknown', 'contact-B')).toEqual({ status: 'refused', reason: 'person_changed' })
    })

    it('lets a manager withdraw a record, after which the invitee may be recorded for someone else', async () => {
        await record('contact-A', 'contact-B')
        const withdrawn = await withdrawCashReferralInvitationV1(port, { attributionId: 'att-1', expectedVersion: 0, comment: 'ошибся водителем', requestId: requestId(), authority: STAFF })
        expect(withdrawn).toEqual({ status: 'withdrawn' })
        expect(await withdrawCashReferralInvitationV1(port, { attributionId: 'att-1', expectedVersion: 0, comment: null, requestId: requestId(), authority: STAFF }))
            .toEqual({ status: 'refused', reason: 'not_withdrawable' })
        expect(await record('contact-P', 'contact-B')).toEqual({ status: 'recorded', attributionId: 'att-2' })
        const card = await cashReferralPersonCardV1(port, 'contact-A')
        if (card.status !== 'ok') throw new Error('no card')
        expect(card.card.invited[0]).toMatchObject({ state: 'withdrawn', withdrawnBy: 'Мария Иванова', withdrawable: false })
        expect(verifyCashAccessChainV1(store.chainOf('contact-A')).ok).toBe(true)
    })
})

describe('scenario B: granting access', () => {
    it('grants Иванов perpetual access for the referral programme, naming the invitation, and shows why', async () => {
        await record('contact-A', 'contact-B')
        expect(await grantCashAccessV1(port, { contactId: 'contact-A', basis: 'referral_program', referralAttributionId: 'att-1', comment: null, requestId: requestId(), authority: STAFF }))
            .toEqual({ status: 'granted' })
        const card = await cashReferralPersonCardV1(port, 'contact-A')
        if (card.status !== 'ok') throw new Error('no card')
        expect(card.card.access).toMatchObject({
            state: 'granted',
            manualGrant: { basis: 'referral_program', referralAttributionId: 'att-1', operatorLabel: 'Мария Иванова' },
        })
        // Cash reads the same chain as a manual grant with no end.
        const fold = foldCashAccessLedgerV1(store.chainOf('contact-A'), compensationLineageDigestV1(['contact-A']))
        expect(fold.manual).toMatchObject({ decision: 'grant', actor: { kind: 'signed_staff_session', capabilities: ['cash.access.manage'] } })
        expect(verifyCashAccessChainV1(store.chainOf('contact-A')).ok).toBe(true)
    })

    it('does not write a second grant, for a retry or a second press', async () => {
        const id = requestId()
        const grant = (rid: string) => grantCashAccessV1(port, { contactId: 'contact-A', basis: 'referral_program', referralAttributionId: null, comment: null, requestId: rid, authority: STAFF })
        expect(await grant(id)).toEqual({ status: 'granted' })
        expect(await grant(id)).toEqual({ status: 'already_granted' })
        expect(await grant(requestId())).toEqual({ status: 'already_granted' })
        expect(store.chainOf('contact-A').filter((event) => event.kind === 'manual_granted')).toHaveLength(1)
    })

    it('revokes access and leaves the recorded invitations in place', async () => {
        await record('contact-A', 'contact-B')
        await grantCashAccessV1(port, { contactId: 'contact-A', basis: 'referral_program', referralAttributionId: 'att-1', comment: null, requestId: requestId(), authority: STAFF })
        const id = requestId()
        expect(await revokeCashAccessV1(port, { contactId: 'contact-A', comment: null, requestId: id, authority: STAFF })).toEqual({ status: 'revoked' })
        expect(await revokeCashAccessV1(port, { contactId: 'contact-A', comment: null, requestId: id, authority: STAFF })).toEqual({ status: 'revoked' })
        expect(await revokeCashAccessV1(port, { contactId: 'contact-A', comment: null, requestId: requestId(), authority: STAFF })).toEqual({ status: 'nothing_to_revoke' })
        const card = await cashReferralPersonCardV1(port, 'contact-A')
        if (card.status !== 'ok') throw new Error('no card')
        expect(card.card.access.state).toBe('none')
        expect(card.card.access.history.map((entry) => entry.kind)).toEqual(['manual_cleared', 'manual_granted'])
        expect(card.card.invited).toHaveLength(1)
        expect(store.chainOf('contact-A').filter((event) => event.kind === 'manual_cleared')).toHaveLength(1)
    })

    it('refuses a grant for a person whose contacts were merged, since Cash would never apply it', async () => {
        expect(await grantCashAccessV1(port, { contactId: 'contact-M', basis: 'referral_program', referralAttributionId: null, comment: null, requestId: requestId(), authority: STAFF }))
            .toEqual({ status: 'refused', reason: 'person_merged' })
        expect(store.events).toHaveLength(0)
    })
})

describe('scenario C: the two actions are independent', () => {
    it('grants for another reason with no invitation at all', async () => {
        expect(await grantCashAccessV1(port, { contactId: 'contact-P', basis: 'manager_decision', referralAttributionId: null, comment: 'Наставник новых водителей', requestId: requestId(), authority: STAFF }))
            .toEqual({ status: 'granted' })
        const card = await cashReferralPersonCardV1(port, 'contact-P')
        if (card.status !== 'ok') throw new Error('no card')
        expect(card.card.invited).toHaveLength(0)
        expect(card.card.access.manualGrant).toMatchObject({ basis: 'manager_decision', referralAttributionId: null })
        expect(store.rows).toHaveLength(0)
    })

    it('withdrawing the invitation a grant names leaves the grant standing', async () => {
        await record('contact-A', 'contact-B')
        await grantCashAccessV1(port, { contactId: 'contact-A', basis: 'referral_program', referralAttributionId: 'att-1', comment: null, requestId: requestId(), authority: STAFF })
        await withdrawCashReferralInvitationV1(port, { attributionId: 'att-1', expectedVersion: 0, comment: null, requestId: requestId(), authority: STAFF })
        const card = await cashReferralPersonCardV1(port, 'contact-A')
        if (card.status !== 'ok') throw new Error('no card')
        expect(card.card.access.state).toBe('granted')
    })
})

describe('authority', () => {
    it('writes nothing for a session without the capability, an invalid session or a malformed request', async () => {
        const accessOnly = { ...STAFF, capabilities: ['cash.access.manage'] }
        expect(await recordCashReferralInvitationV1(port, { inviterContactId: 'contact-A', inviteeContactId: 'contact-B', comment: null, requestId: requestId(), authority: accessOnly }))
            .toEqual({ status: 'refused', reason: 'capability_missing' })
        const referralOnly = { ...STAFF, capabilities: ['cash.referral.qualify'] }
        expect(await grantCashAccessV1(port, { contactId: 'contact-A', basis: 'referral_program', referralAttributionId: null, comment: null, requestId: requestId(), authority: referralOnly }))
            .toEqual({ status: 'refused', reason: 'capability_missing' })
        expect(await revokeCashAccessV1(port, { contactId: 'contact-A', comment: null, requestId: requestId(), authority: { ...STAFF, sessionId: '' } }))
            .toEqual({ status: 'refused', reason: 'staff_session_invalid' })
        expect(await grantCashAccessV1(port, { contactId: 'contact-A', basis: 'referral_program', referralAttributionId: null, comment: null, requestId: 'again', authority: STAFF }))
            .toEqual({ status: 'refused', reason: 'invalid_request' })
        expect(store.events).toHaveLength(0)
        expect(store.rows).toHaveLength(0)
    })
})
