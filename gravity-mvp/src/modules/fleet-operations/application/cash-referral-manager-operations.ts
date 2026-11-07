/**
 * Composition root for the Cash referral manager screens: finding people, a
 * person's card, recorded invitations, and Cash access granted and revoked by
 * a manager.
 *
 * Nothing here runs, and nothing reads the referral tables, unless
 * YOKO_CASH_ACCESS_LEDGER=on, which is set only after both referral
 * migrations are applied. The Telegram referral path has its own switch and
 * is not turned on by this one.
 *
 * Reads answer any caller the screen admits. Every write takes a signed staff
 * session from Identity Access; nothing here accepts a principal, a role or
 * the CRM's unsigned user cookie in its place.
 */

import {
    cashAccessGrantBasisV1,
    cashReferralCommentV1,
    cashStaffAuthorityFromAdminSessionV1 as bindAdminSessionV1,
    type CashAdminSessionFactsV1,
    type CashStaffAuthorityV1,
} from '../internal/compensation/cash-referral-manager'
import {
    cashReferralPersonCardV1,
    grantCashAccessV1,
    recordCashReferralInvitationV1,
    revokeCashAccessV1,
    searchCashReferralPeopleV1,
    withdrawCashReferralInvitationV1,
    type CashAccessGrantResultV1,
    type CashAccessRevokeResultV1,
    type CashReferralManagerPortV1,
    type CashReferralManagerSearchV1,
    type CashReferralPersonCardV1,
    type CashReferralRecordResultV1,
    type CashReferralWithdrawResultV1,
} from '../internal/compensation/cash-referral-manager-service'
import { legacyPrismaCashReferralLedgerStoreV1 } from '../internal/compensation/legacy-prisma-cash-referral-ledger-adapter'
import { legacyPrismaCashReferralManagerReadsV1 } from '../internal/compensation/legacy-prisma-cash-referral-manager-adapter'
import { listYandexConnectionMetadataV1 } from '../public/v1/yandex-connection-capability'

export type {
    CashAdminSessionFactsV1,
    CashAccessGrantBasisV1,
    CashAccessHistoryEntryV1,
    CashAccessManagerViewV1,
    CashReferralManagerCandidateV1,
    CashReferralManagerProfileV1,
    CashReferralMatchV1,
    CashStaffAuthorityV1,
} from '../internal/compensation/cash-referral-manager'
export type {
    CashAccessGrantResultV1,
    CashAccessRevokeResultV1,
    CashReferralInvitationEntryV1,
    CashReferralManagerSearchV1,
    CashReferralPersonCardV1,
    CashReferralRecordResultV1,
    CashReferralWithdrawResultV1,
} from '../internal/compensation/cash-referral-manager-service'

/**
 * The Cash capabilities of a verified integration-admin session's facts, as
 * Identity Access will hand them over (docs/design/cash-staff-authority-v1.md,
 * part 3): the authority holding cash.referral.qualify and cash.access.manage,
 * or null for anything else.
 */
export function cashStaffAuthorityFromAdminSessionV1(facts: CashAdminSessionFactsV1 | null | undefined): CashStaffAuthorityV1 | null {
    return bindAdminSessionV1(facts)
}

/** The manager screens open only once the manager-links migration is applied. */
export function cashReferralManagerEnabledV1(): boolean {
    return process.env.YOKO_CASH_ACCESS_LEDGER === 'on'
}

const store = legacyPrismaCashReferralLedgerStoreV1
const reads = legacyPrismaCashReferralManagerReadsV1

const portV1: CashReferralManagerPortV1 = {
    now: () => new Date(),
    async parkNames() {
        const names = new Map<string, string>()
        for (const park of await listYandexConnectionMetadataV1()) {
            if (park.name !== null && park.name.trim() !== '' && !names.has(park.parkId)) names.set(park.parkId, park.name)
        }
        return names
    },
    lookupContacts: (query, limit) => reads.lookupContacts(query, limit),
    searchProfilesByLicence: (licence, limit) => reads.searchProfilesByLicence(licence, limit),
    profilesOfContacts: (contactIds) => reads.profilesOfContacts(contactIds),
    resolveLineage: (contactId) => reads.resolveLineage(contactId),
    confirmedMainDriver: (contactId, driverIds) => reads.confirmedMainDriver(contactId, driverIds),
    readChain: (contactId) => store.readChain(contactId),
    listInvitationsOfContacts: (contactIds) => store.listInvitationsOfContacts(contactIds),
    findInvitation: (attributionId) => store.findInvitation(attributionId),
    readInvitationLinkEvents: (attributionIds) => store.readInvitationLinkEvents(attributionIds),
    recordManagerInvitation: (input) => store.recordManagerInvitation(input),
    withdrawManagerInvitation: (input) => store.withdrawManagerInvitation(input),
    appendManagerAccessEvents: (drafts) => store.appendManagerAccessEvents(drafts),
}

type DisabledV1 = { status: 'disabled' }
const DISABLED_V1: DisabledV1 = { status: 'disabled' }

export async function cashReferralManagerSearchV1(query: unknown): Promise<CashReferralManagerSearchV1 | DisabledV1> {
    if (!cashReferralManagerEnabledV1()) return DISABLED_V1
    return searchCashReferralPeopleV1(portV1, query)
}

export async function cashReferralManagerPersonV1(
    contactId: unknown,
): Promise<{ status: 'ok'; card: CashReferralPersonCardV1 } | { status: 'person_unresolved' } | DisabledV1> {
    if (!cashReferralManagerEnabledV1()) return DISABLED_V1
    if (typeof contactId !== 'string') return { status: 'person_unresolved' }
    return cashReferralPersonCardV1(portV1, contactId)
}

export async function cashReferralManagerRecordInvitationV1(input: {
    inviterContactId: unknown
    inviteeContactId: unknown
    comment: unknown
    requestId: unknown
    authority: CashStaffAuthorityV1
}): Promise<CashReferralRecordResultV1 | DisabledV1> {
    if (!cashReferralManagerEnabledV1()) return DISABLED_V1
    return recordCashReferralInvitationV1(portV1, { ...input, comment: cashReferralCommentV1(input.comment) })
}

export async function cashReferralManagerWithdrawInvitationV1(input: {
    attributionId: unknown
    expectedVersion: unknown
    comment: unknown
    requestId: unknown
    authority: CashStaffAuthorityV1
}): Promise<CashReferralWithdrawResultV1 | DisabledV1> {
    if (!cashReferralManagerEnabledV1()) return DISABLED_V1
    return withdrawCashReferralInvitationV1(portV1, { ...input, comment: cashReferralCommentV1(input.comment) })
}

export async function cashAccessManagerGrantV1(input: {
    contactId: unknown
    basis: unknown
    referralAttributionId: unknown
    comment: unknown
    requestId: unknown
    authority: CashStaffAuthorityV1
}): Promise<CashAccessGrantResultV1 | DisabledV1> {
    if (!cashReferralManagerEnabledV1()) return DISABLED_V1
    const basis = cashAccessGrantBasisV1(input.basis)
    if (basis === null) return { status: 'refused', reason: 'invalid_request' }
    const referralAttributionId = typeof input.referralAttributionId === 'string' && input.referralAttributionId.trim() !== ''
        ? input.referralAttributionId
        : null
    return grantCashAccessV1(portV1, {
        contactId: input.contactId,
        basis,
        referralAttributionId,
        comment: cashReferralCommentV1(input.comment),
        requestId: input.requestId,
        authority: input.authority,
    })
}

export async function cashAccessManagerRevokeV1(input: {
    contactId: unknown
    comment: unknown
    requestId: unknown
    authority: CashStaffAuthorityV1
}): Promise<CashAccessRevokeResultV1 | DisabledV1> {
    if (!cashReferralManagerEnabledV1()) return DISABLED_V1
    return revokeCashAccessV1(portV1, { ...input, comment: cashReferralCommentV1(input.comment) })
}
