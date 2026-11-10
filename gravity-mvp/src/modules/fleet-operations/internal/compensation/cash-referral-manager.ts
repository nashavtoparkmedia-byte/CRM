/**
 * Cash referral, the manager's side: two separate tools and the pure rules
 * behind them.
 *
 *   invitations   a manager finds two people in the CRM and records that one
 *                 invited the other. The record is history. It grants
 *                 nothing, to either of them.
 *   access        a manager grants a person perpetual Cash access, or takes
 *                 it back. The grant is the ledger's own manual grant, the
 *                 one thing Cash reads as manual access; its basis (the
 *                 referral programme, naming an invitation when there is one,
 *                 or another decision) is kept beside it and decides nothing.
 *
 * A person is a canonical Contact, never a Driver row: one person may hold
 * profiles in several parks, and a profile is only what the manager sees to
 * tell people apart. Nothing here picks a person on the manager's behalf.
 *
 * Every write is made by a signed staff session that holds the capability
 * its kind requires, and the database refuses any other writer. Nothing here
 * reads the CRM's unsigned user cookie as authority.
 *
 * Nothing here touches money: the cap, the one order a day, the budget,
 * provider confirmation and every other C1 rule apply to an access holder
 * exactly as before.
 */

import { createHash } from 'node:crypto'

import {
    cashAccessWriterAllowedV1,
    foldCashAccessLedgerV1,
    type CashAccessEventV1,
    type CashAccessJsonV1,
} from './compensation-referral-ledger'

// ---------------------------------------------------------------------------
// Who acts.
// ---------------------------------------------------------------------------

/**
 * The only actor a manager write accepts: a signed staff session, as Identity
 * Access proves it. Its capabilities are the session's own, never a role.
 */
export interface CashStaffAuthorityV1 {
    principalId: string
    /** Human label for the history; never used for identity. */
    operatorLabel: string
    sessionId: string
    authenticatedAt: Date
    capabilities: readonly string[]
}

export type CashStaffAuthorityRefusalV1 = 'staff_session_invalid' | 'capability_missing'

/** Whether a staff session may write a kind that needs this capability now. */
export function cashStaffAuthorityAdmitsV1(
    authority: CashStaffAuthorityV1,
    capability: string,
    at: Date,
): { admitted: true } | { admitted: false; refusal: CashStaffAuthorityRefusalV1 } {
    const principal = typeof authority.principalId === 'string' ? authority.principalId.trim() : ''
    const session = typeof authority.sessionId === 'string' ? authority.sessionId.trim() : ''
    const authenticatedAt = authority.authenticatedAt instanceof Date ? authority.authenticatedAt.getTime() : Number.NaN
    if (principal === '' || session === '' || Number.isNaN(authenticatedAt) || authenticatedAt > at.getTime()) {
        return { admitted: false, refusal: 'staff_session_invalid' }
    }
    if (!Array.isArray(authority.capabilities) || !authority.capabilities.includes(capability)) {
        return { admitted: false, refusal: 'capability_missing' }
    }
    return { admitted: true }
}

/**
 * Recording and withdrawing an invitation is a referral decision: the
 * capability the ledger writer table admits for those kinds
 * (CASH_REFERRAL_QUALIFY_CAPABILITY_V1, pinned equal by the test).
 */
export const CASH_REFERRAL_LINK_CAPABILITY_V1 = 'cash.referral.qualify'
/**
 * Granting and revoking access is an access decision
 * (CASH_ACCESS_MANAGE_CAPABILITY_V1, pinned equal by the test).
 */
export const CASH_ACCESS_GRANT_CAPABILITY_V1 = 'cash.access.manage'

/** What a manager write is for: the capability follows from it, never from a caller. */
export type CashStaffPurposeV1 = 'invitation' | 'access'

function capabilityForV1(purpose: CashStaffPurposeV1): string {
    return purpose === 'invitation' ? CASH_REFERRAL_LINK_CAPABILITY_V1 : CASH_ACCESS_GRANT_CAPABILITY_V1
}

/** Whether a staff session may make a write of this purpose now. */
export function cashStaffAuthorityForV1(
    authority: CashStaffAuthorityV1,
    purpose: CashStaffPurposeV1,
    at: Date,
): { admitted: true } | { admitted: false; refusal: CashStaffAuthorityRefusalV1 } {
    return cashStaffAuthorityAdmitsV1(authority, capabilityForV1(purpose), at)
}

/**
 * The fields of Identity Access's `StaffSessionPrincipalV1` that Cash reads
 * (docs/design/staff-session-v1.md, v1.2 §4.2). Identity Access produces it
 * from `getStaffSessionPrincipalV1()` only after it has verified the
 * signature, the audience, the expiry, both revocation epochs and the
 * registry's durable authority copy; nothing in Cash produces, verifies or
 * stores a session. The contract is docs/design/cash-staff-authority-v2.md.
 */
export interface CashStaffSessionPrincipalV1 {
    kind: string
    userId: string
    role: string
    sid: string
    issuedAt: Date
    expiresAt: Date
}

/**
 * The employee as Identity Access's directory names them
 * (`UserIdentityV1`): the source of the history's label, never of identity.
 */
export interface CashStaffDirectoryEntryV1 {
    id: string
    firstName: string
    lastName: string
    role: string
    status: string
}

/**
 * Who may write Cash referral and access decisions (Owner, 2026-11-08): a
 * confirmed Администратор, and no other role. A Менеджер or Руководитель
 * holds no Cash capability until the Owner decides otherwise.
 */
export const CASH_STAFF_WRITE_ROLES_V1: readonly string[] = ['Администратор']

export type CashStaffSessionBindingRefusalV1 =
    /** No session, another principal kind, a malformed one, or one outside its lifetime. */
    | 'staff_session_invalid'
    /** The directory does not name this principal as Identity Access verified it. */
    | 'staff_identity_mismatch'
    /** A verified employee whose role holds no Cash capability. */
    | 'staff_role_not_allowed'

export type CashStaffSessionBindingV1 =
    | { bound: true; authority: CashStaffAuthorityV1 }
    | { bound: false; refusal: CashStaffSessionBindingRefusalV1 }

const CASH_STAFF_SESSION_ID_LABEL_V1 = 'yoko.cash.staff-session-id.v1:'

/**
 * The ledger's name for a Staff Session: a labelled digest of the session
 * instance id, so Cash keeps no copy of it. One session gives one name, two
 * sessions two names.
 */
export function cashStaffSessionIdV1(sid: string): string {
    return `staff_session:${createHash('sha256').update(`${CASH_STAFF_SESSION_ID_LABEL_V1}${sid}`, 'utf8').digest('hex')}`
}

function exactTextV1(value: unknown, max: number): string | null {
    if (typeof value !== 'string' || value === '' || value.length > max || value.trim() !== value) return null
    return value
}

function validDateV1(value: unknown): Date | null {
    return value instanceof Date && !Number.isNaN(value.getTime()) ? value : null
}

/**
 * The Cash authority of a verified Staff Session principal. The binding is
 * Cash's own (Staff Session v1.2 §2): the person is the principal's userId,
 * the session is its sid, the authentication time is when that session was
 * issued at login, and the two Cash capabilities follow from the role alone.
 * The label is the directory's name for that same userId; a client value
 * (crm_user_id, a header, a form field) is never read. Anything else binds
 * nothing.
 */
export function cashStaffAuthorityFromStaffSessionV1(
    principal: CashStaffSessionPrincipalV1 | null | undefined,
    entry: CashStaffDirectoryEntryV1 | null | undefined,
    at: Date,
): CashStaffSessionBindingV1 {
    const invalid: CashStaffSessionBindingV1 = { bound: false, refusal: 'staff_session_invalid' }
    if (principal === null || principal === undefined || typeof principal !== 'object') return invalid
    if (principal.kind !== 'staff_session') return invalid
    // actorId is staff:<userId> in a 255-character column.
    const userId = exactTextV1(principal.userId, 200)
    const sid = exactTextV1(principal.sid, 255)
    const issuedAt = validDateV1(principal.issuedAt)
    const expiresAt = validDateV1(principal.expiresAt)
    const now = validDateV1(at)
    if (userId === null || sid === null || issuedAt === null || expiresAt === null || now === null) return invalid
    if (issuedAt.getTime() > now.getTime() || expiresAt.getTime() <= now.getTime()) return invalid

    const mismatch: CashStaffSessionBindingV1 = { bound: false, refusal: 'staff_identity_mismatch' }
    if (entry === null || entry === undefined || typeof entry !== 'object') return mismatch
    if (entry.id !== userId || entry.role !== principal.role || entry.status !== 'Активен') return mismatch
    const operatorLabel = [entry.firstName, entry.lastName]
        .map((part) => (typeof part === 'string' ? part.trim() : ''))
        .filter((part) => part !== '')
        .join(' ')
    if (operatorLabel === '') return mismatch

    if (!CASH_STAFF_WRITE_ROLES_V1.includes(principal.role)) return { bound: false, refusal: 'staff_role_not_allowed' }

    return {
        bound: true,
        authority: {
            principalId: `staff:${userId}`,
            operatorLabel,
            sessionId: cashStaffSessionIdV1(sid),
            authenticatedAt: new Date(issuedAt.getTime()),
            capabilities: [CASH_REFERRAL_LINK_CAPABILITY_V1, CASH_ACCESS_GRANT_CAPABILITY_V1],
        },
    }
}

export type CashStaffAuthorityResolutionV1 =
    | { ok: true; authority: CashStaffAuthorityV1 }
    | { ok: false; refusal: 'staff_session_unavailable' | CashStaffSessionBindingRefusalV1 }

/**
 * Identity Access's two public reads, as the referral screen composes them:
 * the verified Staff Session principal, and the directory that names it.
 */
export interface CashStaffSessionSourceV1 {
    principal(): Promise<CashStaffSessionPrincipalV1 | null>
    directory(): Promise<readonly CashStaffDirectoryEntryV1[]>
    now(): Date
}

/**
 * The authority a manager write is made by, or why there is none. No
 * session is `staff_session_unavailable`; so is a session Identity Access
 * cannot verify because its store does not answer (v1.2 R3): that is no
 * operator, never a fallback to another identity, and never a logout.
 */
export async function resolveCashStaffAuthorityFromSessionV1(source: CashStaffSessionSourceV1): Promise<CashStaffAuthorityResolutionV1> {
    let principal: CashStaffSessionPrincipalV1 | null
    try {
        principal = await source.principal()
    } catch {
        return { ok: false, refusal: 'staff_session_unavailable' }
    }
    if (principal === null || principal === undefined) return { ok: false, refusal: 'staff_session_unavailable' }
    let entries: readonly CashStaffDirectoryEntryV1[]
    try {
        entries = await source.directory()
    } catch {
        return { ok: false, refusal: 'staff_session_unavailable' }
    }
    const userId = typeof principal === 'object' ? principal.userId : undefined
    const named = Array.isArray(entries) ? entries.filter((entry) => entry !== null && typeof entry === 'object' && entry.id === userId) : []
    // A directory that names one id twice names nobody.
    const entry = named.length === 1 ? named[0] : null
    const binding = cashStaffAuthorityFromStaffSessionV1(principal, entry, source.now())
    return binding.bound ? { ok: true, authority: binding.authority } : { ok: false, refusal: binding.refusal }
}

/** The ledger actor of an admitted staff session, for a write of this purpose. */
export function cashStaffActorV1(authority: CashStaffAuthorityV1, purpose: CashStaffPurposeV1): {
    kind: 'signed_staff_session'
    id: string
    capability: string
    sessionId: string
    authenticatedAt: Date
} {
    return {
        kind: 'signed_staff_session',
        id: authority.principalId.trim(),
        capability: capabilityForV1(purpose),
        sessionId: authority.sessionId.trim(),
        authenticatedAt: authority.authenticatedAt,
    }
}

/** A client request id: one per form, so a retry after a failure writes nothing twice. */
const REQUEST_ID_PATTERN_V1 = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u

export function cashReferralRequestIdValidV1(requestId: unknown): requestId is string {
    return typeof requestId === 'string' && REQUEST_ID_PATTERN_V1.test(requestId)
}

// ---------------------------------------------------------------------------
// Search.
//
// Finding a person by name or phone is Contacts' question («which Contact is
// this?»), answered by its ContactLookup.v1 for every module alike. Cash adds
// only what Contacts cannot answer: a person found by a driving licence,
// which Fleet's own profiles hold, and the profiles a manager needs to tell
// two namesakes apart.
// ---------------------------------------------------------------------------

export const CASH_REFERRAL_MANAGER_MAX_QUERY_V1 = 100

export interface CashReferralManagerQueryV1 {
    /** Name words as typed; asked of Contacts as one name. */
    nameTokens: readonly string[]
    /** The phone's last ten digits, or fewer when fewer were typed; asked of Contacts. */
    phoneDigits: string | null
    /** The licence as letters and digits only, upper-case; matched exactly against Fleet's profiles. */
    licence: string | null
}

/**
 * What to ask ContactLookup.v1 for one manager query: the name as one text,
 * and the phone as its last ten digits, which a stored number contains
 * whether the manager typed it with 8, +7 or neither.
 */
export function cashReferralContactLookupsV1(query: CashReferralManagerQueryV1): Array<{ query: string; match: 'name' | 'phone' }> {
    const lookups: Array<{ query: string; match: 'name' | 'phone' }> = []
    if (query.nameTokens.length > 0) lookups.push({ query: query.nameTokens.join(' '), match: 'name' })
    if (query.phoneDigits !== null) lookups.push({ query: query.phoneDigits, match: 'phone' })
    return lookups
}

const LETTER_V1 = /[A-Za-zА-Яа-яЁё]/u
/** An old-format Russian licence: two region digits, two series letters, six digits («77 АВ 123456»). */
const SERIES_LICENCE_V1 = /^\d{2}\s*[A-Za-zА-Яа-яЁё]{2}\s*\d{6}$/u

/**
 * What a manager typed, as the three ways a person can be found. Digits are
 * tried as both a phone and a licence, because a Russian licence is ten
 * digits too; each result says which one matched.
 */
export function parseCashReferralManagerQueryV1(raw: unknown):
    | { ok: true; query: CashReferralManagerQueryV1 }
    | { ok: false; refusal: 'query_too_short' | 'query_too_long' } {
    const text = typeof raw === 'string' ? raw.replace(/\s+/gu, ' ').trim() : ''
    if (text.length > CASH_REFERRAL_MANAGER_MAX_QUERY_V1) return { ok: false, refusal: 'query_too_long' }
    const digits = text.replace(/\D/gu, '')
    // The series letters of an old-format licence are the licence, not a name,
    // and its digits are not a phone: such a query is a licence and only that.
    const seriesLicence = SERIES_LICENCE_V1.test(text)
    const hasLetters = LETTER_V1.test(text) && !seriesLicence

    // Words split on spaces and dots, so initials such as «И.И.» drop out
    // instead of fusing into a word no name contains.
    // Words keep the case they were typed in: Contacts' match ignores case itself.
    const nameTokens = hasLetters
        ? text.split(/[\s.]+/u)
            .map((token) => token.replace(/[^A-Za-zА-Яа-яЁё-]/gu, ''))
            .filter((token) => token.replace(/-/gu, '').length >= 2)
        : []
    // A phone typed beside a name still counts as a phone.
    const phoneDigits = digits.length >= 7 && !seriesLicence ? digits.slice(-10) : null
    const licenceText = text.toUpperCase().replace(/[^0-9A-ZА-ЯЁ]/gu, '')
    const licence = licenceText.length >= 6 && /\d/u.test(licenceText) ? licenceText : null

    if (nameTokens.length === 0 && phoneDigits === null && licence === null) {
        return { ok: false, refusal: 'query_too_short' }
    }
    return { ok: true, query: { nameTokens, phoneDigits, licence } }
}

/** A licence as the search compares it. */
export function cashReferralLicenceKeyV1(licence: string | null | undefined): string | null {
    if (typeof licence !== 'string') return null
    const key = licence.toUpperCase().replace(/[^0-9A-ZА-ЯЁ]/gu, '')
    return key.length >= 6 ? key : null
}

/** One park profile, as the manager sees it to tell people apart. */
export interface CashReferralManagerProfileV1 {
    driverId: string
    fullName: string
    phone: string | null
    licenseNumber: string | null
    externalParkId: string | null
    parkName: string | null
    employmentType: string | null
    isSelfEmployed: boolean | null
    dismissed: boolean
    /** The Fleet projection of this profile's contact; a hint, never the person. */
    contactId: string | null
}

export type CashReferralMatchV1 = 'name' | 'phone' | 'licence'

/** A profile Fleet found by its licence. */
export interface CashReferralManagerHitV1 {
    profile: CashReferralManagerProfileV1
    matchedBy: readonly CashReferralMatchV1[]
}

/** A live Contact that ContactLookup.v1 found by name or phone, with the title Contacts shows it by. */
export interface CashReferralContactHitV1 {
    contactId: string
    displayTitle: string
    matchedBy: readonly CashReferralMatchV1[]
}

export type CashReferralLineageReadV1 =
    | { status: 'resolved'; canonicalContactId: string; contactIds: readonly string[] }
    | { status: 'missing' }
    | { status: 'unresolvable' }

export type CashReferralManagerCandidateV1 =
    | {
        selectable: true
        /** The canonical Contact: what an invitation and access bind to. */
        personContactId: string
        lineage: readonly string[]
        displayName: string
        matchedBy: readonly CashReferralMatchV1[]
        /** Every profile of the person, matched or not, working ones first. */
        profiles: readonly CashReferralManagerProfileV1[]
    }
    | {
        selectable: false
        reason: 'no_contact' | 'contact_unresolved'
        displayName: string
        matchedBy: readonly CashReferralMatchV1[]
        profiles: readonly CashReferralManagerProfileV1[]
    }

function byWorkingFirstV1(left: CashReferralManagerProfileV1, right: CashReferralManagerProfileV1): number {
    if (left.dismissed !== right.dismissed) return left.dismissed ? 1 : -1
    return (left.parkName ?? left.externalParkId ?? '').localeCompare(right.parkName ?? right.externalParkId ?? '')
}

/** The name a person is shown by: a working profile's first, else any; null when none has one. */
export function cashReferralDisplayNameV1(profiles: readonly CashReferralManagerProfileV1[]): string | null {
    const working = profiles.find((profile) => !profile.dismissed && profile.fullName.trim() !== '')
    const any = profiles.find((profile) => profile.fullName.trim() !== '')
    return (working ?? any)?.fullName.trim() ?? null
}

function displayNameOfV1(profiles: readonly CashReferralManagerProfileV1[]): string {
    return cashReferralDisplayNameV1(profiles) ?? 'Без имени'
}

/**
 * The search hits as people. Contacts and profiles that Contacts places in
 * one lineage are one person; a profile with no contact, or a contact
 * Contacts cannot resolve, is shown on its own and cannot be chosen.
 *
 * `lineages` holds the read for every contact a hit names; `profilesOf`
 * holds every profile of each canonical contact found. A person is shown by
 * a profile's name, and by Contacts' title only when no profile has one.
 */
export function groupCashReferralCandidatesV1(
    contactHits: readonly CashReferralContactHitV1[],
    hits: readonly CashReferralManagerHitV1[],
    lineages: ReadonlyMap<string, CashReferralLineageReadV1>,
    profilesOf: ReadonlyMap<string, readonly CashReferralManagerProfileV1[]>,
): CashReferralManagerCandidateV1[] {
    const people = new Map<string, { lineage: readonly string[]; matchedBy: Set<CashReferralMatchV1>; matched: CashReferralManagerProfileV1[]; title: string | null }>()
    const loose: CashReferralManagerCandidateV1[] = []
    const personOf = (read: { canonicalContactId: string; contactIds: readonly string[] }) => {
        const person = people.get(read.canonicalContactId)
            ?? { lineage: read.contactIds, matchedBy: new Set<CashReferralMatchV1>(), matched: [], title: null }
        people.set(read.canonicalContactId, person)
        return person
    }
    for (const hit of contactHits) {
        const read = lineages.get(hit.contactId) ?? { status: 'missing' as const }
        const title = hit.displayTitle.trim() === '' ? null : hit.displayTitle.trim()
        if (read.status !== 'resolved') {
            loose.push({
                selectable: false,
                reason: 'contact_unresolved',
                displayName: title ?? 'Без имени',
                matchedBy: [...hit.matchedBy],
                profiles: [],
            })
            continue
        }
        const person = personOf(read)
        for (const match of hit.matchedBy) person.matchedBy.add(match)
        person.title = person.title ?? title
    }
    for (const hit of hits) {
        const contactId = hit.profile.contactId
        const read = contactId === null ? null : lineages.get(contactId) ?? { status: 'missing' as const }
        if (read === null || read.status !== 'resolved') {
            loose.push({
                selectable: false,
                reason: read === null ? 'no_contact' : 'contact_unresolved',
                displayName: displayNameOfV1([hit.profile]),
                matchedBy: [...hit.matchedBy],
                profiles: [hit.profile],
            })
            continue
        }
        const person = personOf(read)
        for (const match of hit.matchedBy) person.matchedBy.add(match)
        person.matched.push(hit.profile)
    }
    const grouped: CashReferralManagerCandidateV1[] = [...people.entries()].map(([personContactId, person]) => {
        const all = new Map<string, CashReferralManagerProfileV1>()
        for (const profile of [...(profilesOf.get(personContactId) ?? []), ...person.matched]) all.set(profile.driverId, profile)
        const profiles = [...all.values()].sort(byWorkingFirstV1)
        return {
            selectable: true,
            personContactId,
            lineage: person.lineage,
            displayName: cashReferralDisplayNameV1(profiles) ?? person.title ?? 'Без имени',
            matchedBy: [...person.matchedBy],
            profiles,
        }
    })
    grouped.sort((left, right) => left.displayName.localeCompare(right.displayName, 'ru'))
    return [...grouped, ...loose]
}

// ---------------------------------------------------------------------------
// Invitations.
// ---------------------------------------------------------------------------

/** One invitation of either path, as stored. */
export interface CashReferralInvitationRowV1 {
    attributionId: string
    source: 'telegram' | 'manager'
    state: string
    inviterContactId: string
    inviteeContactId: string | null
    capturedAt: Date
    decidedAt: Date | null
    version: number
}

/** States that count an invitation for its invitee; at most one row per invitee holds one. */
export const CASH_REFERRAL_COUNTED_STATES_V1: readonly string[] = ['qualified', 'recorded']

export interface CashReferralLinkPersonV1 {
    contactId: string
    lineage: readonly string[]
    /** Licences of the person's profiles, as cashReferralLicenceKeyV1 gives them. */
    licenceKeys: readonly string[]
}

export type CashReferralLinkRefusalV1 = 'self_invitation' | 'invitee_already_attributed'

export type CashReferralLinkDecisionV1 =
    | { outcome: 'record' }
    | { outcome: 'already_recorded'; attributionId: string }
    | { outcome: 'refused'; reason: 'self_invitation' }
    | { outcome: 'refused'; reason: 'invitee_already_attributed'; attributionId: string; inviterContactId: string }

/**
 * Whether one person may be recorded as another's invitee.
 *
 * The same contact lineage or the same licence on both sides is one person.
 * A shared phone is not: relatives share phones, and the manager who picked
 * both people has seen them. An invitee already counted for this inviter is
 * already recorded; counted for anyone else, it stays theirs until a manager
 * withdraws that record.
 */
export function decideCashReferralLinkV1(input: {
    inviter: CashReferralLinkPersonV1
    invitee: CashReferralLinkPersonV1
    /** Every invitation whose invitee is in the invitee's lineage. */
    inviteeInvitations: readonly CashReferralInvitationRowV1[]
}): CashReferralLinkDecisionV1 {
    const inviterContacts = new Set([input.inviter.contactId, ...input.inviter.lineage])
    const inviteeContacts = [input.invitee.contactId, ...input.invitee.lineage]
    if (inviteeContacts.some((contactId) => inviterContacts.has(contactId))) {
        return { outcome: 'refused', reason: 'self_invitation' }
    }
    const inviterLicences = new Set(input.inviter.licenceKeys)
    if (input.invitee.licenceKeys.some((key) => inviterLicences.has(key))) {
        return { outcome: 'refused', reason: 'self_invitation' }
    }
    const counted = input.inviteeInvitations.find((row) => CASH_REFERRAL_COUNTED_STATES_V1.includes(row.state))
    if (counted !== undefined) {
        if (inviterContacts.has(counted.inviterContactId)) return { outcome: 'already_recorded', attributionId: counted.attributionId }
        return {
            outcome: 'refused',
            reason: 'invitee_already_attributed',
            attributionId: counted.attributionId,
            inviterContactId: counted.inviterContactId,
        }
    }
    return { outcome: 'record' }
}

/** Whether a manager may withdraw one invitation: only their own kind, only while it stands. */
export function cashReferralLinkWithdrawableV1(row: CashReferralInvitationRowV1): boolean {
    return row.source === 'manager' && row.state === 'recorded'
}

const MAX_REASON_V1 = 1000

/** Optional manager comment, trimmed; null when empty. */
export function cashReferralCommentV1(raw: unknown): string | null {
    if (typeof raw !== 'string') return null
    const text = raw.replace(/\s+/gu, ' ').trim()
    return text === '' ? null : text.slice(0, 500)
}

function reasonV1(label: string, comment: string | null): string {
    return (comment === null ? label : `${label}: ${comment}`).slice(0, MAX_REASON_V1)
}

export function cashReferralLinkReasonV1(comment: string | null): string {
    return reasonV1('Приглашение закреплено менеджером', comment)
}

export function cashReferralWithdrawReasonV1(comment: string | null): string {
    return reasonV1('Закрепление приглашения снято менеджером', comment)
}

// ---------------------------------------------------------------------------
// Access.
// ---------------------------------------------------------------------------

export const CASH_ACCESS_GRANT_BASES_V1 = ['referral_program', 'manager_decision'] as const
export type CashAccessGrantBasisV1 = typeof CASH_ACCESS_GRANT_BASES_V1[number]

export function cashAccessGrantBasisV1(raw: unknown): CashAccessGrantBasisV1 | null {
    return (CASH_ACCESS_GRANT_BASES_V1 as readonly unknown[]).includes(raw) ? raw as CashAccessGrantBasisV1 : null
}

/** One access event of a person's chain, as the history shows it. */
export interface CashAccessHistoryEntryV1 {
    kind: 'manual_granted' | 'manual_denied' | 'manual_cleared' | 'referral_entitlement_granted' | 'referral_entitlement_revoked'
    occurredAt: Date
    actorKind: 'system' | 'signed_staff_session'
    operatorLabel: string | null
    reason: string | null
    basis: CashAccessGrantBasisV1 | null
    referralAttributionId: string | null
    /** Recorded under an earlier contact lineage: it no longer applies. */
    stale: boolean
}

export interface CashAccessManagerViewV1 {
    /**
     * granted       a standing manual grant or referral entitlement
     * denied        a standing manual denial; Cash refuses the person
     * needs_review  access was recorded under an earlier lineage of this person
     *               (a merge since); Cash keeps the section closed until a
     *               manager records access again
     * none          nothing stands; the standard programme still applies
     */
    state: 'granted' | 'denied' | 'needs_review' | 'none'
    manualGrant: { since: Date; basis: CashAccessGrantBasisV1 | null; referralAttributionId: string | null; operatorLabel: string | null } | null
    referralEntitlement: { since: Date; attributionId: string | null } | null
    history: readonly CashAccessHistoryEntryV1[]
}

const HISTORY_KINDS_V1: ReadonlySet<string> = new Set([
    'manual_granted',
    'manual_denied',
    'manual_cleared',
    'referral_entitlement_granted',
    'referral_entitlement_revoked',
])

function payloadTextV1(payload: { [key: string]: CashAccessJsonV1 }, key: string): string | null {
    const value = payload[key]
    return typeof value === 'string' && value.trim() !== '' ? value : null
}

/**
 * A person's access as Cash reads it, and how it got there. The state comes
 * from the ledger fold Cash itself applies, so the screen cannot disagree
 * with the section.
 */
export function cashAccessManagerViewV1(events: readonly CashAccessEventV1[], lineageDigest: string): CashAccessManagerViewV1 {
    const ordered = [...events].sort((left, right) => left.seq - right.seq)
    const fold = foldCashAccessLedgerV1(ordered, lineageDigest)
    const history: CashAccessHistoryEntryV1[] = []
    let latestGrant: CashAccessEventV1 | null = null
    let latestEntitlement: CashAccessEventV1 | null = null
    for (const event of ordered) {
        if (!HISTORY_KINDS_V1.has(event.kind) || !cashAccessWriterAllowedV1(event)) continue
        const current = event.lineageDigest === lineageDigest
        if (current && event.kind === 'manual_granted') latestGrant = event
        if (current && event.kind === 'referral_entitlement_granted') latestEntitlement = event
        history.push({
            kind: event.kind as CashAccessHistoryEntryV1['kind'],
            occurredAt: event.occurredAt,
            actorKind: event.actorKind,
            operatorLabel: payloadTextV1(event.payload, 'operatorLabel'),
            reason: event.reason,
            basis: cashAccessGrantBasisV1(event.payload.basis),
            referralAttributionId: payloadTextV1(event.payload, 'referralAttributionId') ?? event.attributionId,
            stale: !current,
        })
    }
    const manualGrant = fold.manual !== null && fold.manual.decision === 'grant' && latestGrant !== null
        ? {
            since: fold.manual.decidedAt,
            basis: cashAccessGrantBasisV1(latestGrant.payload.basis),
            referralAttributionId: payloadTextV1(latestGrant.payload, 'referralAttributionId'),
            operatorLabel: payloadTextV1(latestGrant.payload, 'operatorLabel'),
        }
        : null
    const referralEntitlement = fold.referral !== null && fold.referral.revokedAt === null
        ? { since: fold.referral.confirmedAt, attributionId: latestEntitlement?.attributionId ?? null }
        : null
    let state: CashAccessManagerViewV1['state'] = 'none'
    if (fold.staleLineage) state = 'needs_review'
    else if (fold.manual !== null && fold.manual.decision === 'deny') state = 'denied'
    else if (manualGrant !== null || referralEntitlement !== null) state = 'granted'
    return { state, manualGrant, referralEntitlement, history: history.reverse() }
}

export type CashAccessGrantDecisionV1 =
    | {
        outcome: 'grant'
        reason: string
        payload: { [key: string]: CashAccessJsonV1 }
    }
    | { outcome: 'already_granted' }
    | { outcome: 'refused'; reason: 'comment_required' | 'invitation_not_found' | 'person_merged' }

/**
 * Whether a manual grant is written now, and what it records.
 *
 * A grant that already stands is not written again. A grant for the referral
 * programme may name one of the person's own invitations; another decision
 * needs the manager's words. Cash binds access only to a single-contact
 * person, so a grant for a person whose contacts were merged would never
 * apply and is refused instead of recorded.
 */
export function decideCashAccessGrantV1(input: {
    view: CashAccessManagerViewV1
    lineage: readonly string[]
    basis: CashAccessGrantBasisV1
    /** An invitation this person made, when the grant names one. */
    referralAttributionId: string | null
    personInvitations: readonly CashReferralInvitationRowV1[]
    comment: string | null
    operatorLabel: string
}): CashAccessGrantDecisionV1 {
    if (input.lineage.length !== 1) return { outcome: 'refused', reason: 'person_merged' }
    if (input.view.manualGrant !== null && input.view.state === 'granted') return { outcome: 'already_granted' }
    if (input.basis === 'manager_decision' && (input.comment === null || input.comment.length < 10)) {
        return { outcome: 'refused', reason: 'comment_required' }
    }
    let referralAttributionId: string | null = null
    if (input.basis === 'referral_program' && input.referralAttributionId !== null) {
        const named = input.personInvitations.find((row) => row.attributionId === input.referralAttributionId
            && input.lineage.includes(row.inviterContactId)
            && CASH_REFERRAL_COUNTED_STATES_V1.includes(row.state))
        if (named === undefined) return { outcome: 'refused', reason: 'invitation_not_found' }
        referralAttributionId = named.attributionId
    }
    const label = input.basis === 'referral_program' ? 'Реферальная программа' : 'Решение менеджера'
    return {
        outcome: 'grant',
        reason: reasonV1(label, input.comment),
        payload: {
            basis: input.basis,
            referralAttributionId,
            operatorLabel: input.operatorLabel,
        },
    }
}

export type CashAccessRevokeDecisionV1 =
    | {
        outcome: 'revoke'
        /** Clear the standing manual grant. */
        clearManual: boolean
        /** Revoke the standing referral entitlement of this invitation. */
        revokeEntitlementOf: string | null
        reason: string
        payload: { [key: string]: CashAccessJsonV1 }
    }
    | { outcome: 'nothing_to_revoke' }

/**
 * Taking access back: every standing grant this person holds, the manual one
 * and a referral entitlement alike. A manual denial is not access and is left
 * as it is. The standard programme is not a grant and is not touched.
 */
export function decideCashAccessRevokeV1(input: {
    view: CashAccessManagerViewV1
    comment: string | null
    operatorLabel: string
}): CashAccessRevokeDecisionV1 {
    const clearManual = input.view.manualGrant !== null && input.view.state === 'granted'
    const entitlement = input.view.state === 'granted' ? input.view.referralEntitlement : null
    if (!clearManual && entitlement === null) return { outcome: 'nothing_to_revoke' }
    if (entitlement !== null && entitlement.attributionId === null && !clearManual) return { outcome: 'nothing_to_revoke' }
    return {
        outcome: 'revoke',
        clearManual,
        revokeEntitlementOf: entitlement?.attributionId ?? null,
        reason: reasonV1('Доступ отозван менеджером', input.comment),
        payload: { operatorLabel: input.operatorLabel },
    }
}
