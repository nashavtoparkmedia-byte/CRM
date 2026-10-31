/**
 * Composition root for Cash Referral Access.
 *
 * The Telegram surface reaches referral codes, captures and the inviter's
 * own status only through here, and the scheduler reaches the decision pass
 * only through here. Nothing runs, and nothing reads the referral tables,
 * unless YOKO_CASH_REFERRAL_ACCESS=on: the flag is set after the migration is
 * applied, so a database without the tables is never asked about them.
 *
 * A code is issued only to a person proven the way a Cash claim is proven:
 * the Telegram link, Contacts' confirmation of the linked Driver, and an
 * admitted lineage. A capture proves nothing about anyone and answers every
 * caller the same, whatever happened.
 */

import { compensationLineageDigestV1 } from '../internal/compensation/compensation-pilot-lineage'
import { resolvePilotPersonV1, type PilotTelegramPersonProofV1 } from '../internal/compensation/compensation-pilot-service'
import { foldCashAccessLedgerV1 } from '../internal/compensation/compensation-referral-ledger'
import { runCashReferralDecisionPassV1, type CashReferralPassOutcomeV1 } from '../internal/compensation/compensation-referral-service'
import { legacyPrismaCashReferralLedgerStoreV1 } from '../internal/compensation/legacy-prisma-cash-referral-ledger-adapter'
import {
    CashReferralYandexReadRationV1,
    legacyPrismaCashReferralDecisionPortV1,
} from '../internal/compensation/legacy-prisma-cash-referral-decision-adapter'
import { legacyPrismaCompensationPilotPortV1 } from '../internal/compensation/legacy-prisma-compensation-pilot-adapter'
import { readYandexFleetDriverDismissalV1 } from '../internal/legacy-prisma-yandex-fleet-reconciler-adapter'

/** The one switch for every referral read and write. */
export function cashReferralAccessEnabledV1(): boolean {
    return process.env.YOKO_CASH_REFERRAL_ACCESS === 'on'
}

/** The token shape a code is issued in: `r_` and 22 base64url characters (128 bits). */
const REFERRAL_TOKEN_PATTERN_V1 = /^r_[A-Za-z0-9_-]{22}$/u

export type CashReferralInviterStatusV1 = {
    /** Counts of the inviter's invitations per state; nothing about any invitee. */
    invitations: Record<string, number>
    /** When standing referral access began; null when the inviter holds none. */
    accessSince: Date | null
}

export type CashReferralIssueResultV1 =
    | ({ status: 'issued'; token: string } & CashReferralInviterStatusV1)
    | { status: 'refused'; reason: 'disabled' | 'cash_person_unconfirmed' | 'identity_busy' }

async function inviterV1(proof: PilotTelegramPersonProofV1) {
    const resolved = await resolvePilotPersonV1(proof, legacyPrismaCompensationPilotPortV1)
    if (!resolved.proven) return { proven: false as const, refusal: resolved.refusal }
    return {
        proven: true as const,
        contactId: resolved.person.canonicalContactId,
        lineageDigest: compensationLineageDigestV1(resolved.person.lineage),
    }
}

async function statusOfV1(contactId: string, lineageDigest: string): Promise<CashReferralInviterStatusV1> {
    const store = legacyPrismaCashReferralLedgerStoreV1
    const fold = foldCashAccessLedgerV1(await store.readChain(contactId), lineageDigest)
    return {
        invitations: await store.countByInviter(contactId),
        accessSince: fold.referral !== null && fold.referral.revokedAt === null && !fold.staleLineage ? fold.referral.confirmedAt : null,
    }
}

/** A new referral code for the proven person behind this Telegram link. */
export async function cashReferralIssueV1(proof: PilotTelegramPersonProofV1): Promise<CashReferralIssueResultV1> {
    if (!cashReferralAccessEnabledV1()) return { status: 'refused', reason: 'disabled' }
    const inviter = await inviterV1(proof)
    if (!inviter.proven) return { status: 'refused', reason: inviter.refusal }
    const { token } = await legacyPrismaCashReferralLedgerStoreV1.issueCode({
        inviterContactId: inviter.contactId,
        lineageDigest: inviter.lineageDigest,
    })
    return { status: 'issued', token, ...await statusOfV1(inviter.contactId, inviter.lineageDigest) }
}

/** The inviter's own counts and access, without issuing anything. */
export async function cashReferralStatusV1(
    proof: PilotTelegramPersonProofV1,
): Promise<({ status: 'ok' } & CashReferralInviterStatusV1) | { status: 'refused'; reason: 'disabled' | 'cash_person_unconfirmed' | 'identity_busy' }> {
    if (!cashReferralAccessEnabledV1()) return { status: 'refused', reason: 'disabled' }
    const inviter = await inviterV1(proof)
    if (!inviter.proven) return { status: 'refused', reason: inviter.refusal }
    return { status: 'ok', ...await statusOfV1(inviter.contactId, inviter.lineageDigest) }
}

/**
 * Records that a Telegram account opened a code. Every caller is told the
 * same, so the answer reveals neither a code nor an earlier attribution.
 */
export async function cashReferralCaptureV1(input: {
    token: string
    telegramUserId: string
    /** The Driver this account is already proven linked to, if any. */
    driverId: string | null
}): Promise<{ status: 'recorded' }> {
    if (!cashReferralAccessEnabledV1() || !REFERRAL_TOKEN_PATTERN_V1.test(input.token) || !/^\d+$/u.test(input.telegramUserId)) {
        return { status: 'recorded' }
    }
    try {
        await legacyPrismaCashReferralLedgerStoreV1.capture({
            token: input.token,
            inviteeTelegramUserId: input.telegramUserId,
            inviteeDriverId: input.driverId,
        })
    } catch (error) {
        // The code and the account never appear in the log; the reply stays the same.
        console.error(JSON.stringify({ event: 'cash_referral_capture_failed', error: error instanceof Error ? error.name : 'unknown' }))
    }
    return { status: 'recorded' }
}

/** Records the Driver an invited Telegram account was just proven linked to. */
export async function cashReferralAttachInviteeV1(input: { telegramUserId: string; driverId: string }): Promise<void> {
    if (!cashReferralAccessEnabledV1()) return
    await legacyPrismaCashReferralLedgerStoreV1.attachInviteeDriver({
        inviteeTelegramUserId: input.telegramUserId,
        driverId: input.driverId,
    })
}

// One ration per process, so a park's 429 cooldown holds across passes.
const yandexReadRationV1 = new CashReferralYandexReadRationV1(readYandexFleetDriverDismissalV1, {
    perPass: 20,
    cooldownMs: 15 * 60_000,
    nowMs: () => Date.now(),
})

export interface CashReferralDecisionScheduleV1 {
    enabled: boolean
    firstRunDelayMs: number
    intervalMs: number
}

/** The decision pass runs hourly, and only when referral access is on. */
export function cashReferralDecisionScheduleV1(): CashReferralDecisionScheduleV1 {
    return { enabled: cashReferralAccessEnabledV1(), firstRunDelayMs: 3 * 60_000, intervalMs: 60 * 60_000 }
}

/** One scheduled pass over the invitations not yet decided for good. */
export async function runScheduledCashReferralDecisionsV1(): Promise<CashReferralPassOutcomeV1 | { skipped: 'disabled' }> {
    if (!cashReferralAccessEnabledV1()) return { skipped: 'disabled' }
    return runCashReferralDecisionPassV1(legacyPrismaCashReferralDecisionPortV1(yandexReadRationV1), 50)
}
