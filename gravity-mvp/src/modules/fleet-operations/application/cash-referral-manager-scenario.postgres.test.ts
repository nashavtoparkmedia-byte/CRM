/**
 * Isolated-PostgreSQL proof of the manager's referral scenario, end to end
 * through the composition the screens call and the real adapters:
 *
 *   the manager finds Иванов (by name, and by a phone typed with 8),
 *   finds Сидоров (by his licence), records that Иванов invited Сидоров,
 *   then, as a separate decision, grants Иванов perpetual Cash access, and
 *   sees the history on both people.
 *
 * Who a name or a phone belongs to is answered by Contacts' ContactLookup.v1
 * over the Contact rows; the licence and the park profiles by Fleet's Driver
 * rows. The writes are made by the authority Cash binds to a verified
 * integration-admin session (docs/design/cash-staff-authority-v1.md); the
 * facts below stand in for the ones Identity Access will hand over, and the
 * database CHECK admits the events only because they carry that session and
 * the capability each kind needs. No money moves: recording grants nothing,
 * and the grant is the ledger's manual grant only.
 *
 * Gated behind YOKO_COMPENSATION_MONETARY_POSTGRES_PROOF=1 and an isolated
 * DATABASE_URL holding the canonical migration catalog.
 */

import { randomInt, randomUUID } from 'node:crypto'

import { PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { CASH_ADMIN_OPERATOR_LABEL_V1 } from '../internal/compensation/cash-referral-manager'
import { verifyCashAccessChainV1 } from '../internal/compensation/compensation-referral-ledger'
import { legacyPrismaCashReferralLedgerStoreV1 as store } from '../internal/compensation/legacy-prisma-cash-referral-ledger-adapter'
import {
    cashAccessManagerGrantV1,
    cashReferralManagerPersonV1,
    cashReferralManagerRecordInvitationV1,
    cashReferralManagerSearchV1,
    cashStaffAuthorityFromAdminSessionV1,
    type CashReferralManagerCandidateV1,
} from './cash-referral-manager-operations'

const proof = process.env.YOKO_COMPENSATION_MONETARY_POSTGRES_PROOF === '1' ? describe : describe.skip

const tag = `${process.pid}${Date.now()}`
const digits = (length: number) => Array.from({ length }, () => String(randomInt(10))).join('')

let database: PrismaClient
const ledgerSwitch = process.env.YOKO_CASH_ACCESS_LEDGER

/** The facts Identity Access will hand over for one verified integration-admin login. */
const facts = {
    principal: { id: 'identity-access:integration-admin-session', kind: 'integration_admin_session' },
    sessionId: `sid-binding-${tag}`,
    authenticatedAt: new Date(Date.now() - 60_000),
}

const people = {
    ivanov: { contactId: `contact-ivanov-${tag}`, phone: `7916${digits(7)}`, licence: `99${digits(8)}` },
    namesake: { contactId: `contact-namesake-${tag}`, phone: `7925${digits(7)}`, licence: `98${digits(8)}` },
    sidorov: { contactId: `contact-sidorov-${tag}`, phone: `7926${digits(7)}`, licence: `97${digits(8)}` },
}

async function seedPerson(contactId: string, fullName: string, phone: string, profiles: Array<{ park: string; licence: string }>) {
    await database.contact.create({
        data: { id: contactId, displayName: fullName, displayNameSource: 'yandex', masterSource: 'yandex' },
    })
    await database.contactPhone.create({ data: { contactId, phone, isPrimary: true, source: 'yandex' } })
    for (const [index, profile] of profiles.entries()) {
        await database.driver.create({
            data: {
                yandexDriverId: `yd-${contactId}-${index}`,
                fullName,
                phone: `+${phone}`,
                licenseNumber: profile.licence,
                externalParkId: profile.park,
                contactId,
            },
        })
    }
}

function person(candidates: readonly CashReferralManagerCandidateV1[], contactId: string) {
    return candidates.find((candidate) => candidate.selectable && candidate.personContactId === contactId)
}

proof('the manager referral scenario on real PostgreSQL', () => {
    beforeAll(async () => {
        process.env.YOKO_CASH_ACCESS_LEDGER = 'on'
        database = new PrismaClient()
        await database.$connect()
        const licenceIvanov = `${people.ivanov.licence.slice(0, 4)} ${people.ivanov.licence.slice(4)}`
        await seedPerson(people.ivanov.contactId, 'Иванов Иван Иванович', people.ivanov.phone, [
            { park: `park-a-${tag}`, licence: licenceIvanov },
            { park: `park-b-${tag}`, licence: people.ivanov.licence },
        ])
        await seedPerson(people.namesake.contactId, 'Иванов Иван Сергеевич', people.namesake.phone, [
            { park: `park-a-${tag}`, licence: people.namesake.licence },
        ])
        await seedPerson(people.sidorov.contactId, 'Сидоров Сергей Петрович', people.sidorov.phone, [
            { park: `park-a-${tag}`, licence: people.sidorov.licence },
        ])
    })
    afterAll(async () => {
        if (ledgerSwitch === undefined) delete process.env.YOKO_CASH_ACCESS_LEDGER
        else process.env.YOKO_CASH_ACCESS_LEDGER = ledgerSwitch
        await database.$disconnect()
    })

    it('finds Иванов → finds Сидоров → records the invitation → grants Иванов access separately → shows the history', async () => {
        const authority = cashStaffAuthorityFromAdminSessionV1(facts)
        expect(authority).not.toBeNull()
        if (authority === null) return

        // 1. Иванов by name: one person across two parks, apart from his namesake.
        const byName = await cashReferralManagerSearchV1('Иванов Иван')
        if (!('candidates' in byName)) throw new Error(`search refused: ${JSON.stringify(byName)}`)
        const ivanov = person(byName.candidates, people.ivanov.contactId)
        expect(ivanov).toMatchObject({ displayName: 'Иванов Иван Иванович', matchedBy: ['name'] })
        expect(ivanov?.profiles).toHaveLength(2)
        expect(person(byName.candidates, people.namesake.contactId)).toMatchObject({ displayName: 'Иванов Иван Сергеевич' })
        expect(person(byName.candidates, people.sidorov.contactId)).toBeUndefined()

        // …and by his phone as a manager types it, with 8.
        const local = people.ivanov.phone.slice(1)
        const byPhone = await cashReferralManagerSearchV1(`8 (${local.slice(0, 3)}) ${local.slice(3, 6)}-${local.slice(6, 8)}-${local.slice(8)}`)
        if (!('candidates' in byPhone)) throw new Error('phone search refused')
        expect(person(byPhone.candidates, people.ivanov.contactId)).toMatchObject({ matchedBy: ['phone'] })

        // 2. Сидоров by the licence Fleet holds.
        const byLicence = await cashReferralManagerSearchV1(people.sidorov.licence)
        if (!('candidates' in byLicence)) throw new Error('licence search refused')
        expect(person(byLicence.candidates, people.sidorov.contactId)).toMatchObject({ displayName: 'Сидоров Сергей Петрович' })
        expect(person(byLicence.candidates, people.sidorov.contactId)?.matchedBy).toContain('licence')

        // 3. Record «Иванов пригласил Сидорова». It grants nobody anything.
        const recorded = await cashReferralManagerRecordInvitationV1({
            inviterContactId: people.ivanov.contactId,
            inviteeContactId: people.sidorov.contactId,
            comment: 'Сидоров пришёл по приглашению Иванова',
            requestId: randomUUID(),
            authority,
        })
        expect(recorded).toMatchObject({ status: 'recorded' })
        if (recorded.status !== 'recorded') return
        const afterRecord = await cashReferralManagerPersonV1(people.ivanov.contactId)
        if (!('card' in afterRecord)) throw new Error('no card')
        expect(afterRecord.card.access.state).toBe('none')

        // A second inviter for Сидоров is refused, and so is Иванов as his own invitee.
        expect(await cashReferralManagerRecordInvitationV1({
            inviterContactId: people.namesake.contactId,
            inviteeContactId: people.sidorov.contactId,
            comment: null,
            requestId: randomUUID(),
            authority,
        })).toMatchObject({ status: 'refused', reason: 'invitee_already_attributed', inviterContactId: people.ivanov.contactId })
        expect(await cashReferralManagerRecordInvitationV1({
            inviterContactId: people.ivanov.contactId,
            inviteeContactId: people.ivanov.contactId,
            comment: null,
            requestId: randomUUID(),
            authority,
        })).toEqual({ status: 'refused', reason: 'self_invitation' })

        // 4. Separately, grant Иванов perpetual access on the referral programme, naming the invitation.
        const grantRequest = randomUUID()
        const grant = {
            contactId: people.ivanov.contactId,
            basis: 'referral_program',
            referralAttributionId: recorded.attributionId,
            comment: 'Пригласил Сидорова: бессрочный доступ по реферальной программе',
            requestId: grantRequest,
            authority,
        }
        expect(await cashAccessManagerGrantV1(grant)).toEqual({ status: 'granted' })
        // Pressing again writes nothing twice.
        expect(await cashAccessManagerGrantV1(grant)).toEqual({ status: 'already_granted' })

        // 5. The history on both people.
        const ivanovCard = await cashReferralManagerPersonV1(people.ivanov.contactId)
        if (!('card' in ivanovCard)) throw new Error('no card')
        expect(ivanovCard.card.invited).toEqual([expect.objectContaining({
            source: 'manager',
            state: 'recorded',
            otherContactId: people.sidorov.contactId,
            otherName: 'Сидоров Сергей Петрович',
            recordedBy: CASH_ADMIN_OPERATOR_LABEL_V1,
            // The ledger reason names the decision, then the manager's own words.
            reason: 'Приглашение закреплено менеджером: Сидоров пришёл по приглашению Иванова',
        })])
        expect(ivanovCard.card.access).toMatchObject({
            state: 'granted',
            manualGrant: { basis: 'referral_program', referralAttributionId: recorded.attributionId, operatorLabel: CASH_ADMIN_OPERATOR_LABEL_V1 },
        })
        expect(ivanovCard.card.access.history).toEqual([expect.objectContaining({
            kind: 'manual_granted',
            actorKind: 'signed_staff_session',
            operatorLabel: CASH_ADMIN_OPERATOR_LABEL_V1,
            basis: 'referral_program',
            referralAttributionId: recorded.attributionId,
            stale: false,
        })])

        const sidorovCard = await cashReferralManagerPersonV1(people.sidorov.contactId)
        if (!('card' in sidorovCard)) throw new Error('no card')
        expect(sidorovCard.card.invitedBy).toEqual([expect.objectContaining({ otherContactId: people.ivanov.contactId, otherName: 'Иванов Иван Иванович' })])
        expect(sidorovCard.card.access.state).toBe('none')

        // What the database holds: two events on Иванов's chain, each from the
        // verified session with the capability its kind needs, and a chain that verifies.
        const rows = await database.$queryRawUnsafe<Array<{ kind: string; actorKind: string; actorId: string; actorCapability: string; actorSessionId: string }>>(
            `SELECT "kind", "actorKind", "actorId", "actorCapability", "actorSessionId" FROM "CashAccessEvent" WHERE "chainContactId" = $1 ORDER BY "seq"`,
            people.ivanov.contactId,
        )
        expect(rows).toEqual([
            { kind: 'referral_link_recorded', actorKind: 'signed_staff_session', actorId: facts.principal.id, actorCapability: 'cash.referral.qualify', actorSessionId: facts.sessionId },
            { kind: 'manual_granted', actorKind: 'signed_staff_session', actorId: facts.principal.id, actorCapability: 'cash.access.manage', actorSessionId: facts.sessionId },
        ])
        expect(verifyCashAccessChainV1(await store.readChain(people.ivanov.contactId))).toEqual({ ok: true, length: 2 })
        expect(await database.$queryRawUnsafe<Array<{ n: number }>>(
            `SELECT count(*)::int AS n FROM "CashAccessEvent" WHERE "chainContactId" = $1`,
            people.sidorov.contactId,
        )).toEqual([{ n: 0 }])
    })

    it('writes nothing for a session that binds no Cash capability', async () => {
        expect(cashStaffAuthorityFromAdminSessionV1(null)).toBeNull()
        const withoutCapability = { ...cashStaffAuthorityFromAdminSessionV1(facts)!, capabilities: [] }
        const before = await database.$queryRawUnsafe<Array<{ n: number }>>(`SELECT count(*)::int AS n FROM "CashAccessEvent"`)
        expect(await cashAccessManagerGrantV1({
            contactId: people.namesake.contactId,
            basis: 'manager_decision',
            referralAttributionId: null,
            comment: 'Решение менеджера без права на запись',
            requestId: randomUUID(),
            authority: withoutCapability,
        })).toEqual({ status: 'refused', reason: 'capability_missing' })
        expect(await database.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "CashAccessEvent"`)).toEqual(before)
    })
})
