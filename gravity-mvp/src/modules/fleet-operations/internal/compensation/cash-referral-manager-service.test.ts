import { beforeEach, describe, expect, it } from 'vitest'

import { compensationLineageDigestV1 } from './compensation-pilot-lineage'
import { cashAccessEventHashV1, foldCashAccessLedgerV1, verifyCashAccessChainV1, type CashAccessEventV1 } from './compensation-referral-ledger'
import {
    cashReferralLicenceKeyV1,
    cashStaffAuthorityFromStaffSessionV1,
    cashStaffSessionIdV1,
    type CashReferralInvitationRowV1,
    type CashReferralManagerProfileV1,
    type CashStaffAuthorityV1,
} from './cash-referral-manager'
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
    /** What ContactLookup.v1 searches: live Contacts, their name and their stored phone digits. */
    contacts: Array<{ contactId: string; displayTitle: string; phones: string[] }> = []
    lookups: string[] = []
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
            lookupContacts: async (query, limit) => {
                this.lookups.push(query)
                const phone = /^\d+$/u.test(query)
                const found = this.contacts.filter((c) => (phone
                    ? c.phones.some((stored) => stored.includes(query))
                    : c.displayTitle.toLowerCase().includes(query.toLowerCase())))
                return { contacts: found.slice(0, limit).map(({ contactId, displayTitle }) => ({ contactId, displayTitle })), truncated: found.length > limit }
            },
            searchProfilesByLicence: async (licence) => this.profiles.filter((p) => cashReferralLicenceKeyV1(p.licenseNumber) === licence),
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
                if (replay !== undefined) {
                    // As the adapter: a retry answers with what it wrote; the id put to another pair is a mismatch.
                    const sameRequest = typeof replay.payload.invitationId === 'string' && replay.kind === 'referral_link_recorded'
                        && replay.chainContactId === input.inviterContactId && replay.payload.inviteeContactId === input.inviteeContactId
                    return sameRequest ? { outcome: 'already_recorded', attributionId: replay.payload.invitationId as string } : { outcome: 'request_mismatch' }
                }
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
                const replay = this.events.find((event) => event.idempotencyKey === input.idempotencyKey)
                if (replay !== undefined) {
                    return replay.kind === 'referral_link_withdrawn' && replay.payload.invitationId === input.attributionId ? 'already_withdrawn' : 'request_mismatch'
                }
                const row = this.rows.find((r) => r.attributionId === input.attributionId && r.version === input.expectedVersion && r.source === 'manager' && r.state === 'recorded')
                if (!row) return 'version_conflict'
                row.state = 'withdrawn'
                row.version += 1
                this.append({ chainContactId: row.inviterContactId, kind: 'referral_link_withdrawn', lineageDigest: compensationLineageDigestV1([row.inviterContactId]), codeHash: null, attributionId: null, payload: { ...input.payload, invitationId: row.attributionId }, actor: input.actor, reason: input.reason, idempotencyKey: input.idempotencyKey })
                return 'withdrawn'
            },
            appendManagerAccessEvents: async (drafts) => {
                const replay = this.events.find((event) => event.idempotencyKey === drafts[0].idempotencyKey)
                if (replay !== undefined) {
                    return replay.chainContactId === drafts[0].chainContactId && replay.kind === drafts[0].kind ? 'already_written' : 'request_mismatch'
                }
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
    store.contacts = [
        { contactId: 'contact-A', displayTitle: 'Иванов Иван Иванович', phones: ['79161234567'] },
        { contactId: 'contact-B', displayTitle: 'Сидоров Сергей Петрович', phones: ['79260000001'] },
        { contactId: 'contact-P', displayTitle: 'Петров Алексей', phones: ['79260000002'] },
        { contactId: 'contact-N', displayTitle: 'Иванов Иван Сергеевич', phones: ['79260000003'] },
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

    it('asks Contacts who a name or a phone is, the phone as its last ten digits whatever prefix was typed', async () => {
        const byPhone = await searchCashReferralPeopleV1(port, '8 (916) 123-45-67')
        expect(store.lookups).toEqual(['9161234567'])
        expect(byPhone).toMatchObject({ status: 'ok', candidates: [{ selectable: true, personContactId: 'contact-A', matchedBy: ['phone'] }] })

        store.lookups = []
        await searchCashReferralPeopleV1(port, 'Иванов И.И.')
        expect(store.lookups).toEqual(['Иванов'])
    })

    it('finds a person by the licence Fleet holds, and shows a profile with no contact without letting it be chosen', async () => {
        store.profiles.push(profile('d-loose', 'contact-none', 'Кузьмин Олег', { contactId: null, licenseNumber: '7700 555555' }))
        const byLicence = await searchCashReferralPeopleV1(port, '9912 345678')
        expect(byLicence).toMatchObject({ status: 'ok' })
        if (byLicence.status !== 'ok') return
        // The ten digits are asked of Contacts as a phone too; only the licence matched.
        expect(byLicence.candidates).toEqual([expect.objectContaining({ selectable: true, personContactId: 'contact-A', matchedBy: ['licence'] })])
        expect(byLicence.candidates[0].profiles).toHaveLength(2)

        const loose = await searchCashReferralPeopleV1(port, '7700555555')
        expect(loose).toMatchObject({ status: 'ok', candidates: [{ selectable: false, reason: 'no_contact', displayName: 'Кузьмин Олег', matchedBy: ['licence'] }] })
    })

    it('is one person when Contacts finds the digits as a phone and Fleet as a licence', async () => {
        store.contacts.find((c) => c.contactId === 'contact-B')!.phones.push('79900111111')
        const both = await searchCashReferralPeopleV1(port, '9900 111111')
        expect(both).toMatchObject({ status: 'ok' })
        if (both.status !== 'ok') return
        expect(both.candidates).toHaveLength(1)
        expect(both.candidates[0]).toMatchObject({ selectable: true, personContactId: 'contact-B' })
        expect([...both.candidates[0].matchedBy].sort()).toEqual(['licence', 'phone'])
    })

    it('names a person who has no park profile by the title Contacts shows', async () => {
        store.contacts.push({ contactId: 'contact-T', displayTitle: 'Тарасов Олег', phones: [] })
        store.lineages.set('contact-T', ['contact-T'])
        const found = await searchCashReferralPeopleV1(port, 'Тарасов')
        expect(found).toMatchObject({ status: 'ok', candidates: [{ selectable: true, personContactId: 'contact-T', displayName: 'Тарасов Олег', profiles: [] }] })
    })

    it('passes on that Contacts holds more matches than it returned', async () => {
        store.contacts = Array.from({ length: 25 }, (_, index) => ({ contactId: `contact-I${index}`, displayTitle: `Иванов ${index}`, phones: [] }))
        for (const contact of store.contacts) store.lineages.set(contact.contactId, [contact.contactId])
        const many = await searchCashReferralPeopleV1(port, 'Иванов')
        expect(many).toMatchObject({ status: 'ok', truncated: true })
        if (many.status === 'ok') expect(many.candidates).toHaveLength(20)
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

    it('refuses a request id reused for another person, pair or invitation instead of answering with the old result', async () => {
        const recordId = requestId()
        expect(await record('contact-A', 'contact-B', recordId)).toEqual({ status: 'recorded', attributionId: 'att-1' })
        expect(await record('contact-P', 'contact-N', recordId)).toEqual({ status: 'refused', reason: 'invalid_request' })

        const grantId = requestId()
        const grant = (contactId: string) => grantCashAccessV1(port, { contactId, basis: 'manager_decision', referralAttributionId: null, comment: 'Решение менеджера', requestId: grantId, authority: STAFF })
        expect(await grant('contact-A')).toEqual({ status: 'granted' })
        expect(await grant('contact-P')).toEqual({ status: 'refused', reason: 'invalid_request' })

        const revokeId = requestId()
        await grantCashAccessV1(port, { contactId: 'contact-N', basis: 'manager_decision', referralAttributionId: null, comment: 'Решение менеджера', requestId: requestId(), authority: STAFF })
        expect(await revokeCashAccessV1(port, { contactId: 'contact-A', comment: null, requestId: revokeId, authority: STAFF })).toEqual({ status: 'revoked' })
        expect(await revokeCashAccessV1(port, { contactId: 'contact-N', comment: null, requestId: revokeId, authority: STAFF })).toEqual({ status: 'refused', reason: 'invalid_request' })

        expect(await record('contact-P', 'contact-N')).toMatchObject({ status: 'recorded' })
        const withdrawId = requestId()
        expect(await withdrawCashReferralInvitationV1(port, { attributionId: 'att-1', expectedVersion: 0, comment: null, requestId: withdrawId, authority: STAFF })).toEqual({ status: 'withdrawn' })
        expect(await withdrawCashReferralInvitationV1(port, { attributionId: 'att-2', expectedVersion: 0, comment: null, requestId: withdrawId, authority: STAFF }))
            .toEqual({ status: 'refused', reason: 'invalid_request' })

        // Nothing was written for the reused ids: Петров has no grant, Н. keeps his, att-2 stands.
        expect(store.chainOf('contact-P').filter((event) => event.kind === 'manual_granted')).toHaveLength(0)
        expect(store.chainOf('contact-N').filter((event) => event.kind === 'manual_cleared')).toHaveLength(0)
        expect(store.rows.find((row) => row.attributionId === 'att-2')?.state).toBe('recorded')
    })
})

describe('a Staff Session\'s authority, end to end', () => {
    const SID_ALEXANDER = '4f1c9e2a7b3d5c6e8f0a1b2c3d4e5f60718293a4b5c6d7e8f9012345678abcde'
    const SID_OLGA = '9a8b7c6d5e4f30211203f4e5d6c7b8a99a8b7c6d5e4f30211203f4e5d6c7b8a9'
    const SID_IGOR = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
    const session = (userId: string, sid: string, role = 'Администратор') => ({
        kind: 'staff_session', userId, role, sid,
        issuedAt: new Date('2026-11-06T08:30:00.000Z'), expiresAt: new Date('2026-11-06T20:30:00.000Z'),
    })
    const directory = {
        u2: { id: 'u2', firstName: 'Александр', lastName: 'Сидоров', role: 'Администратор', status: 'Активен' },
        u3: { id: 'u3', firstName: 'Ольга', lastName: 'Петрова', role: 'Администратор', status: 'Активен' },
        u4: { id: 'u4', firstName: 'Игорь', lastName: 'Смирнов', role: 'Менеджер', status: 'Активен' },
    }
    const authorityOf = (userId: keyof typeof directory, sid: string, role?: string) => {
        const binding = cashStaffAuthorityFromStaffSessionV1(session(userId, sid, role ?? directory[userId].role), directory[userId], NOW)
        if (!binding.bound) throw new Error(binding.refusal)
        return binding.authority
    }

    it('attributes every write and every history line to the employee and the session that made it', async () => {
        const alexander = authorityOf('u2', SID_ALEXANDER)
        const olga = authorityOf('u3', SID_OLGA)
        expect(await recordCashReferralInvitationV1(port, { inviterContactId: 'contact-A', inviteeContactId: 'contact-B', comment: null, requestId: requestId(), authority: alexander }))
            .toEqual({ status: 'recorded', attributionId: 'att-1' })
        expect(await grantCashAccessV1(port, { contactId: 'contact-A', basis: 'referral_program', referralAttributionId: 'att-1', comment: null, requestId: requestId(), authority: alexander }))
            .toEqual({ status: 'granted' })
        expect(await revokeCashAccessV1(port, { contactId: 'contact-A', comment: null, requestId: requestId(), authority: olga }))
            .toEqual({ status: 'revoked' })

        const chain = store.chainOf('contact-A')
        expect(verifyCashAccessChainV1(chain).ok).toBe(true)
        expect(chain.map((event) => [event.kind, event.actorKind, event.actorId, event.actorCapability, event.actorSessionId, event.actorAuthenticatedAt?.toISOString()])).toEqual([
            ['referral_link_recorded', 'signed_staff_session', 'staff:u2', 'cash.referral.qualify', cashStaffSessionIdV1(SID_ALEXANDER), '2026-11-06T08:30:00.000Z'],
            ['manual_granted', 'signed_staff_session', 'staff:u2', 'cash.access.manage', cashStaffSessionIdV1(SID_ALEXANDER), '2026-11-06T08:30:00.000Z'],
            ['manual_cleared', 'signed_staff_session', 'staff:u3', 'cash.access.manage', cashStaffSessionIdV1(SID_OLGA), '2026-11-06T08:30:00.000Z'],
        ])
        // No raw session id is kept anywhere in the chain.
        expect(JSON.stringify(chain)).not.toContain(SID_ALEXANDER)

        const card = await cashReferralPersonCardV1(port, 'contact-A')
        if (card.status !== 'ok') throw new Error('no card')
        expect(card.card.invited).toEqual([expect.objectContaining({ recordedBy: 'Александр Сидоров' })])
        expect(card.card.access.history.map((entry) => [entry.kind, entry.operatorLabel])).toEqual([
            ['manual_cleared', 'Ольга Петрова'],
            ['manual_granted', 'Александр Сидоров'],
        ])
    })

    it('writes nothing twice for a repeated request, whoever repeats it', async () => {
        const alexander = authorityOf('u2', SID_ALEXANDER)
        const olga = authorityOf('u3', SID_OLGA)
        const id = requestId()
        const grant = (authority: CashStaffAuthorityV1, rid: string) =>
            grantCashAccessV1(port, { contactId: 'contact-A', basis: 'manager_decision', referralAttributionId: null, comment: 'Решение Owner по пилоту', requestId: rid, authority })
        expect(await grant(alexander, id)).toEqual({ status: 'granted' })
        expect(await grant(alexander, id)).toEqual({ status: 'already_granted' })
        expect(await grant(olga, requestId())).toEqual({ status: 'already_granted' })
        expect(store.chainOf('contact-A').filter((event) => event.kind === 'manual_granted')).toHaveLength(1)
    })

    it('gives a verified Менеджер no authority to write with', async () => {
        const binding = cashStaffAuthorityFromStaffSessionV1(session('u4', SID_IGOR, 'Менеджер'), directory.u4, NOW)
        expect(binding).toEqual({ bound: false, refusal: 'staff_role_not_allowed' })
        expect(store.events).toHaveLength(0)
    })
})
