import 'server-only'

import type {
    CashAccessManagerViewV1,
    CashReferralInvitationEntryV1,
    CashReferralManagerCandidateV1,
    CashReferralManagerProfileV1,
    CashReferralPersonCardV1,
    CashStaffAuthorityResolutionV1,
    CashStaffAuthorityV1,
} from '@/modules/fleet-operations/public/v1'
import { resolveCashStaffAuthorityFromSessionV1 } from '@/modules/fleet-operations/public/v1'
import { getStaffSessionPrincipalV1 } from '@/modules/identity-access/public/v1'
import { listUserIdentitiesV1 } from '@/modules/identity-access/public/v1/user-directory'

import type {
    ReferralAccessView,
    ReferralCandidateView,
    ReferralInvitationView,
    ReferralPersonView,
    ReferralProfileView,
} from './view'

/**
 * The signed staff session a referral or access write is made by.
 *
 * The contract is docs/design/cash-staff-authority-v2.md: Identity Access
 * proves the employee (Staff Session v1.3, getStaffSessionPrincipalV1) and
 * names them in its published directory (UserIdentity.v1); Cash binds the
 * two Cash capabilities to a confirmed Администратор only. Nothing here reads
 * the crm_user_id cookie, a header or a form field, and managerSession()
 * stays in front only as a gate that narrows. No session, or one Identity
 * Access cannot verify, writes nothing; the screens stay readable.
 */
export async function resolveCashStaffAuthorityV1(): Promise<
    | { ok: true; authority: CashStaffAuthorityV1 }
    | { ok: false; refusal: CashStaffAuthorityRefusalV1 }
> {
    return resolveCashStaffAuthorityFromSessionV1({
        principal: getStaffSessionPrincipalV1,
        directory: listUserIdentitiesV1,
        now: () => new Date(),
    })
}

type CashStaffAuthorityRefusalV1 = Extract<CashStaffAuthorityResolutionV1, { ok: false }>['refusal']

function employmentOf(profile: CashReferralManagerProfileV1): string {
    if (profile.isSelfEmployed === true) return 'СМЗ'
    if (profile.employmentType === 'individual_entrepreneur') return 'ИП'
    if (profile.employmentType === 'selfemployed') return 'СМЗ'
    if (profile.employmentType === 'park_employee') return 'штатный'
    return 'тип не указан'
}

function profileView(profile: CashReferralManagerProfileV1): ReferralProfileView {
    return {
        driverId: profile.driverId,
        fullName: profile.fullName,
        phone: profile.phone,
        licenseNumber: profile.licenseNumber,
        parkName: profile.parkName ?? profile.externalParkId,
        employment: employmentOf(profile),
        dismissed: profile.dismissed,
    }
}

export function candidateView(candidate: CashReferralManagerCandidateV1): ReferralCandidateView {
    return {
        selectable: candidate.selectable,
        personContactId: candidate.selectable ? candidate.personContactId : null,
        displayName: candidate.displayName,
        matchedBy: [...candidate.matchedBy],
        merged: candidate.selectable ? candidate.lineage.length > 1 : false,
        unselectableReason: candidate.selectable ? null : candidate.reason,
        profiles: candidate.profiles.map(profileView),
    }
}

function iso(date: Date | null): string | null {
    return date === null ? null : date.toISOString()
}

function invitationView(entry: CashReferralInvitationEntryV1): ReferralInvitationView {
    return {
        attributionId: entry.attributionId,
        source: entry.source,
        state: entry.state,
        otherContactId: entry.otherContactId,
        otherName: entry.otherName,
        at: entry.at.toISOString(),
        recordedBy: entry.recordedBy,
        reason: entry.reason,
        withdrawnAt: iso(entry.withdrawnAt),
        withdrawnBy: entry.withdrawnBy,
        withdrawable: entry.withdrawable,
        version: entry.version,
    }
}

function accessView(access: CashAccessManagerViewV1): ReferralAccessView {
    return {
        state: access.state,
        manualGrant: access.manualGrant === null ? null : {
            since: access.manualGrant.since.toISOString(),
            basis: access.manualGrant.basis,
            referralAttributionId: access.manualGrant.referralAttributionId,
            operatorLabel: access.manualGrant.operatorLabel,
        },
        referralEntitlement: access.referralEntitlement === null ? null : {
            since: access.referralEntitlement.since.toISOString(),
            attributionId: access.referralEntitlement.attributionId,
        },
        history: access.history.map((entry) => ({
            kind: entry.kind,
            occurredAt: entry.occurredAt.toISOString(),
            operatorLabel: entry.operatorLabel,
            system: entry.actorKind === 'system',
            reason: entry.reason,
            basis: entry.basis,
            referralAttributionId: entry.referralAttributionId,
            stale: entry.stale,
        })),
    }
}

export function personView(card: CashReferralPersonCardV1): ReferralPersonView {
    return {
        personContactId: card.personContactId,
        displayName: card.displayName,
        merged: card.lineage.length > 1,
        profiles: card.profiles.map(profileView),
        cashIdentity: card.cashIdentity,
        access: accessView(card.access),
        invited: card.invited.map(invitationView),
        invitedBy: card.invitedBy.map(invitationView),
    }
}
