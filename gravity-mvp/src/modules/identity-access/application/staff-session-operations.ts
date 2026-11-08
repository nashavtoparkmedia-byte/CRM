import { randomUUID } from 'node:crypto'
import {
    createStaffPasswordVerifierV1,
    isStaffSessionEnforcedV1,
    isStaffSessionSecretValidV1,
    issueStaffSessionTokenV1,
    readStaffSessionTokenV1,
    STAFF_SESSION_TTL_SECONDS,
    staffPasswordRefusalV1,
    staffSessionCookieOptionsV1,
    staffSessionIdV1,
    verifyStaffPasswordV1,
    type StaffPasswordRefusalV1,
} from '../internal/staff-session-credentials'
import {
    prismaStaffCredentialStoreV1,
    type StaffCredentialRowV1,
} from '../internal/staff-credential-store'
import {
    isRegistryRecordV1,
    locateRegistryV1,
    readRegistryForWriteV1,
    readRegistryLenientV1,
    readRegistryStrictV1,
    withRegistryWriteTurnV1,
    writeRegistryAtomicV1,
    type RegistryRecordV1,
} from '../internal/user-registry-file'

/**
 * Staff Session v1 composition (docs/design/staff-session-v1.md v1.3).
 *
 * The employee registry (users.json via getUsers) stays the only authority for
 * who exists, their role and their status (D1). PostgreSQL holds only the
 * password verifier and the revocation counter. Where one change touches both
 * stores, PostgreSQL is written first and the registry second, and nothing
 * claims they change together (D2): a lost registry write leaves an employee
 * who cannot sign in, never one who can sign in with more than the registry
 * says.
 */

export type StaffRoleV1 = RegistryRecordV1['role']

/** The verified employee principal consumers take authority from (v1.2 §4.2 field names). */
export interface StaffSessionPrincipalV1 {
    kind: 'staff_session'
    userId: string
    role: StaffRoleV1
    /** Non-secret per-login id: a labelled sha256 of the token's random instance id. */
    sid: string
    /** The password login time. There is no re-issue without a password. */
    issuedAt: Date
    expiresAt: Date
}

const store = prismaStaffCredentialStoreV1

// ── Facade facts the public surface and the request boundary need ────────

/**
 * The staff session cookie. `__Host-` makes the browser refuse it unless it
 * is Secure, Path=/ and has no Domain, so a sibling host cannot plant one.
 */
const STAFF_SESSION_COOKIE = '__Host-yoko_staff_session'

/** The staff session cookie's name (`__Host-` prefixed). */
export function staffSessionCookieNameV1(): string {
    return STAFF_SESSION_COOKIE
}

/** Whether browser-lane enforcement is on now (YOKO_STAFF_SESSION_ENFORCE=on). */
export function isStaffSessionEnforcementOnV1(): boolean {
    return isStaffSessionEnforcedV1()
}

/** The hardened cookie options for a session of the full lifetime, or a clearing cookie. */
export function staffSessionCookieSettingsV1(clear = false) {
    return staffSessionCookieOptionsV1(clear ? 0 : STAFF_SESSION_TTL_SECONDS)
}

/** The session lifetime, for the derived UI cookie. */
export function staffSessionLifetimeSecondsV1(): number {
    return STAFF_SESSION_TTL_SECONDS
}

// ── Lane state ───────────────────────────────────────────────────────────

export type StaffLaneStateV1 =
    | { kind: 'dormant' }
    | { kind: 'ready', registryPath: string }
    | { kind: 'refused', reason: string }

/** Dormant without a valid secret; otherwise ready only when the registry is where it must be (C-D3a). */
export async function staffLaneStateV1(): Promise<StaffLaneStateV1> {
    if (!isStaffSessionSecretValidV1()) return { kind: 'dormant' }
    const location = await locateRegistryV1({ laneConfigured: true, anyCredentialRow: () => store.anyRow() })
    return location.ok ? { kind: 'ready', registryPath: location.path } : { kind: 'refused', reason: location.reason }
}

/** The registry file for display and legacy reads, or null when a configured lane refuses. */
export async function registryPathForReadV1(): Promise<string | null> {
    if (!isStaffSessionSecretValidV1()) {
        const location = await locateRegistryV1({ laneConfigured: false, anyCredentialRow: async () => false })
        return location.ok ? location.path : null
    }
    const lane = await staffLaneStateV1()
    return lane.kind === 'ready' ? lane.registryPath : null
}

export async function readRegistryForDisplayV1(): Promise<RegistryRecordV1[]> {
    const file = await registryPathForReadV1()
    return file === null ? [] : readRegistryLenientV1(file)
}

/** Whether `/login` asks for a password (the lane is ready). Non-secret. */
export async function staffLoginModeV1(): Promise<'password' | 'legacy' | 'unavailable'> {
    const lane = await staffLaneStateV1()
    if (lane.kind === 'ready') return 'password'
    if (lane.kind === 'refused') return 'unavailable'
    return isStaffSessionEnforcedV1() ? 'unavailable' : 'legacy'
}

// ── Verification ─────────────────────────────────────────────────────────

export type StaffSessionVerificationV1 =
    | { kind: 'valid', principal: StaffSessionPrincipalV1, credential: StaffCredentialRowV1 }
    | { kind: 'refused' }
    | { kind: 'unverifiable' }

function isEligible(record: RegistryRecordV1 | undefined, row: StaffCredentialRowV1 | null): record is RegistryRecordV1 {
    return record !== undefined
        && row !== null
        && row.revokedAt === null
        && record.status === 'Активен'
        && record.createdAt !== ''
        && record.createdAt === row.registryCreatedAt
}

/**
 * Verify a staff session token against live state. `unverifiable` when the
 * credential store or the registry cannot be read (R3, C-D1a) or the lane
 * refuses its registry (C-D3a): the request then has no operator, and is
 * never treated as logged out.
 */
export async function verifyStaffSessionTokenV1(token: string | undefined, nowMs = Date.now()): Promise<StaffSessionVerificationV1> {
    if (token === undefined || token === '') return { kind: 'refused' }
    const lane = await staffLaneStateV1().catch(() => ({ kind: 'refused', reason: 'lane_unreadable' } as const))
    if (lane.kind === 'dormant') return { kind: 'refused' }
    if (lane.kind === 'refused') return { kind: 'unverifiable' }
    const claims = readStaffSessionTokenV1(token, undefined, nowMs)
    if (claims === null) return { kind: 'refused' }
    let row: StaffCredentialRowV1 | null
    let registry: RegistryRecordV1[]
    try {
        row = await store.find(claims.userId)
        registry = await readRegistryStrictV1(lane.registryPath)
    } catch (error) {
        console.error('[staff-session] verification store unreadable; refusing the session:', error instanceof Error ? error.name : 'unknown')
        return { kind: 'unverifiable' }
    }
    const record = registry.find((candidate) => candidate.id === claims.userId)
    if (!isEligible(record, row) || row!.sessionEpoch !== claims.userEpoch) return { kind: 'refused' }
    const sid = staffSessionIdV1(claims.sessionInstanceId)
    if (sid === null) return { kind: 'refused' }
    return {
        kind: 'valid',
        credential: row!,
        principal: Object.freeze({
            kind: 'staff_session' as const,
            userId: record.id,
            role: record.role,
            sid,
            issuedAt: new Date(claims.issuedAtSeconds * 1000),
            expiresAt: new Date(claims.expiresAtSeconds * 1000),
        }),
    }
}

// ── Password work: a 4-slot limiter and per-user / per-source backoff ────

const MAX_CONCURRENT_SCRYPT = 4
const SLOT_WAIT_MS = 2_000
let slotsInUse = 0
const slotWaiters: Array<() => void> = []

async function withScryptSlot<T>(work: () => Promise<T>): Promise<T | 'busy'> {
    if (slotsInUse >= MAX_CONCURRENT_SCRYPT) {
        const admitted = await new Promise<boolean>((resolve) => {
            const waiter = () => { clearTimeout(timer); resolve(true) }
            const timer = setTimeout(() => {
                const index = slotWaiters.indexOf(waiter)
                if (index !== -1) slotWaiters.splice(index, 1)
                resolve(false)
            }, SLOT_WAIT_MS)
            slotWaiters.push(waiter)
        })
        if (!admitted) return 'busy'
    } else {
        slotsInUse += 1
    }
    try {
        return await work()
    } finally {
        const next = slotWaiters.shift()
        if (next) next()
        else slotsInUse -= 1
    }
}

interface Backoff { failures: number, until: number }
const backoff = new Map<string, Backoff>()
const BACKOFF_FREE_FAILURES = 3
const BACKOFF_MAX_MS = 15 * 60 * 1000

function throttledUntil(keys: string[], nowMs: number): number {
    return Math.max(0, ...keys.map((key) => backoff.get(key)?.until ?? 0).filter((until) => until > nowMs))
}

function recordFailure(keys: string[], nowMs: number): void {
    for (const key of keys) {
        const entry = backoff.get(key) ?? { failures: 0, until: 0 }
        entry.failures += 1
        const over = entry.failures - BACKOFF_FREE_FAILURES
        entry.until = over >= 0 ? nowMs + Math.min(BACKOFF_MAX_MS, 1000 * 2 ** over) : 0
        backoff.set(key, entry)
    }
    if (backoff.size > 10_000) backoff.clear()
}

function clearFailures(keys: string[]): void {
    for (const key of keys) backoff.delete(key)
}

/** Test seam: forget limiter and backoff state. */
export function resetStaffLoginThrottleForTestsV1(): void {
    backoff.clear()
}

// ── Login and logout ─────────────────────────────────────────────────────

export type StaffLoginResultV1 =
    | { ok: true, token: string, principal: StaffSessionPrincipalV1 }
    | { ok: false, reason: 'refused' | 'throttled' | 'busy' | 'unavailable' }

/**
 * Password login. The same scrypt runs for an unknown, disabled, revoked or
 * credential-less employee, and every such case answers the same `refused`.
 */
export async function staffLoginV1(input: { userId: unknown, password: unknown, source: string | null }, nowMs = Date.now()): Promise<StaffLoginResultV1> {
    const lane = await staffLaneStateV1().catch(() => ({ kind: 'refused', reason: 'lane_unreadable' } as const))
    if (lane.kind !== 'ready') return { ok: false, reason: 'unavailable' }
    const userId = typeof input.userId === 'string' && input.userId.length <= 64 ? input.userId : ''
    const keys = [`user:${userId}`, ...(input.source ? [`source:${input.source}`] : [])]
    if (throttledUntil(keys, nowMs) > nowMs) return { ok: false, reason: 'throttled' }

    let record: RegistryRecordV1 | undefined
    let row: StaffCredentialRowV1 | null = null
    try {
        const registry = await readRegistryStrictV1(lane.registryPath)
        record = registry.find((candidate) => candidate.id === userId)
        row = userId === '' ? null : await store.find(userId)
    } catch {
        return { ok: false, reason: 'unavailable' }
    }
    const eligible = isEligible(record, row)
    const outcome = await withScryptSlot(() => verifyStaffPasswordV1(input.password, eligible ? row!.verifier : null))
    if (outcome === 'busy') return { ok: false, reason: 'busy' }
    if (!eligible || !outcome) {
        recordFailure(keys, nowMs)
        console.warn(`[staff-session] login refused user=${record === undefined ? 'unknown' : 'registry'}`)
        return { ok: false, reason: 'refused' }
    }
    const token = issueStaffSessionTokenV1({ userId: record!.id, userEpoch: row!.sessionEpoch }, undefined, nowMs)
    if (token === null) return { ok: false, reason: 'unavailable' }
    const verified = await verifyStaffSessionTokenV1(token, nowMs)
    if (verified.kind !== 'valid') return { ok: false, reason: 'unavailable' }
    clearFailures(keys)
    await store.record({ userId: record!.id, kind: 'login', actor: `staff:${record!.id}`, sid: verified.principal.sid }).catch((error) => {
        console.error('[staff-session] login audit failed:', error instanceof Error ? error.name : 'unknown')
    })
    return { ok: true, token, principal: verified.principal }
}

/** Server-side logout: every session of this employee ends (sessionEpoch + 1). */
export async function staffLogoutV1(token: string | undefined): Promise<'ended' | 'no_session' | 'unverifiable'> {
    const verified = await verifyStaffSessionTokenV1(token)
    if (verified.kind === 'refused') return 'no_session'
    if (verified.kind === 'unverifiable') return 'unverifiable'
    const { userId, sid } = verified.principal
    await store.locked(async (tx) => {
        await tx.bumpEpoch(userId, `staff:${userId}`, new Date())
        await tx.record({ userId, kind: 'logout', actor: `staff:${userId}`, sid })
    })
    return 'ended'
}

// ── Credential administration ────────────────────────────────────────────

export type StaffCredentialActorV1 =
    | { kind: 'staff', principal: StaffSessionPrincipalV1 }
    | { kind: 'integration_admin' }

export type StaffPasswordChangeRefusalV1 =
    | StaffPasswordRefusalV1
    | 'unavailable'
    | 'forbidden'
    | 'unknown_or_inactive_user'
    | 'current_password_refused'
    | 'bootstrap_closed'
    | 'busy'

/**
 * Set or reset an employee's password.
 *
 * - The employee themself, with the current password.
 * - An Администратор under a Staff Session, for any active employee; this is
 *   also the only way to revive a revoked credential (C-D2b).
 * - Bootstrap (R2, C-D2a): the integration-admin session, only for an
 *   Администратор with no credential row at all, only while no Администратор
 *   holds a live credential. Never a reset, never a revival.
 *
 * Every change rebinds the row to the current registry record, bumps the
 * session epoch and is audited. Nothing without a valid secret (C-D4b).
 */
export async function setStaffPasswordV1(input: {
    actor: StaffCredentialActorV1
    targetUserId: string
    newPassword: unknown
    currentPassword?: unknown
}): Promise<{ ok: true } | { ok: false, reason: StaffPasswordChangeRefusalV1 }> {
    const lane = await staffLaneStateV1().catch(() => ({ kind: 'refused', reason: 'lane_unreadable' } as const))
    if (lane.kind !== 'ready') return { ok: false, reason: 'unavailable' }
    const policy = staffPasswordRefusalV1(input.newPassword)
    if (policy !== null) return { ok: false, reason: policy }
    const newPassword = input.newPassword as string
    const { actor, targetUserId } = input

    let registry: RegistryRecordV1[]
    try {
        registry = await readRegistryStrictV1(lane.registryPath)
    } catch {
        return { ok: false, reason: 'unavailable' }
    }
    const target = registry.find((candidate) => candidate.id === targetUserId)
    if (target === undefined || target.status !== 'Активен' || target.createdAt === '') {
        return { ok: false, reason: 'unknown_or_inactive_user' }
    }

    const isSelf = actor.kind === 'staff' && actor.principal.userId === targetUserId
    const isAdministrator = actor.kind === 'staff' && actor.principal.role === 'Администратор'
    if (actor.kind === 'staff' && !isSelf && !isAdministrator) return { ok: false, reason: 'forbidden' }
    if (actor.kind === 'integration_admin' && target.role !== 'Администратор') return { ok: false, reason: 'forbidden' }

    // The employee's own change always proves the current password, an
    // Администратор included: a stolen session alone must not take the account.
    if (isSelf) {
        const row = await store.find(targetUserId).catch(() => undefined)
        if (row === undefined) return { ok: false, reason: 'unavailable' }
        const current = await withScryptSlot(() => verifyStaffPasswordV1(input.currentPassword, isEligible(target, row) ? row!.verifier : null))
        if (current === 'busy') return { ok: false, reason: 'busy' }
        if (!current) return { ok: false, reason: 'current_password_refused' }
    }

    const verifier = await withScryptSlot(() => createStaffPasswordVerifierV1(newPassword))
    if (verifier === 'busy') return { ok: false, reason: 'busy' }
    const actorId = actor.kind === 'staff' ? `staff:${actor.principal.userId}` : 'integration-admin'
    const administratorIds = new Set(registry.filter((candidate) => candidate.role === 'Администратор').map((candidate) => candidate.id))

    try {
        return await store.locked(async (tx) => {
            const existing = await tx.find(targetUserId)
            if (actor.kind === 'integration_admin') {
                // Check-and-set in one serialized transaction.
                if (existing !== null) return { ok: false as const, reason: 'bootstrap_closed' as const }
                const live = await tx.liveUserIds()
                if ([...live].some((id) => administratorIds.has(id))) return { ok: false as const, reason: 'bootstrap_closed' as const }
            }
            if (isSelf && (existing === null || existing.revokedAt !== null)) {
                return { ok: false as const, reason: 'current_password_refused' as const }
            }
            await tx.upsertVerifier({ userId: targetUserId, registryCreatedAt: target.createdAt, verifier, actor: actorId, now: new Date() })
            await tx.record({ userId: targetUserId, kind: existing === null ? 'password_set' : 'password_reset', actor: actorId })
            return { ok: true as const }
        })
    } catch (error) {
        console.error('[staff-session] password change failed:', error instanceof Error ? error.name : 'unknown')
        return { ok: false, reason: 'unavailable' }
    }
}

/** «Завершить сеансы»: an Администратор (or the employee) ends every session of `targetUserId`. */
export async function endStaffSessionsV1(actor: StaffSessionPrincipalV1, targetUserId: string): Promise<'ended' | 'no_credential' | 'forbidden'> {
    if (actor.userId !== targetUserId && actor.role !== 'Администратор') return 'forbidden'
    const bumped = await store.locked(async (tx) => {
        const row = await tx.bumpEpoch(targetUserId, `staff:${actor.userId}`, new Date())
        if (row !== null) await tx.record({ userId: targetUserId, kind: 'epoch_bump', actor: `staff:${actor.userId}` })
        return row
    })
    return bumped === null ? 'no_credential' : 'ended'
}

/** Credential state per employee, for an Администратор (or bootstrap) view. Never verifier material. */
export async function staffCredentialStatesV1(): Promise<Record<string, 'live' | 'revoked'>> {
    const states = await store.states()
    return Object.fromEntries(states.map((state) => [state.userId, state.revoked ? 'revoked' : 'live'] as const))
}

/**
 * Whether an employee may still use the legacy `login(targetUserId)` (N-D2):
 * never under enforcement, never for an id with any credential row. An
 * unreadable store refuses while the lane is configured; without a valid
 * secret the browser lane is the legacy trusted-app model (crm_user_id can be
 * set without this action at all), so an outage keeps today's behaviour.
 */
export async function legacyLoginAllowedForV1(targetUserId: string): Promise<boolean> {
    if (isStaffSessionEnforcedV1()) return false
    try {
        return (await store.find(targetUserId)) === null
    } catch {
        return !isStaffSessionSecretValidV1()
    }
}

// ── User management (D2, D4) ─────────────────────────────────────────────

/**
 * Strict when the lane is configured or any credential row exists, live or
 * revoked; an unreadable store with no secret counts as strict (C-D4a). In
 * MAIN at merge neither holds, so `/users` behaves as before.
 */
export async function userManagementModeV1(): Promise<'legacy' | 'strict'> {
    if (isStaffSessionSecretValidV1()) return 'strict'
    try {
        return (await store.anyRow()) ? 'strict' : 'legacy'
    } catch {
        return 'strict'
    }
}

export type StaffUserManagementErrorCodeV1 =
    | 'forbidden'
    | 'unavailable'
    | 'invalid_role'
    | 'invalid_status'
    | 'invalid_field'
    | 'not_found'
    | 'last_privileged_demotion'
    | 'last_privileged_deletion'
    | 'last_credentialed_administrator'

const MANAGEMENT_ERROR_NAME = 'StaffUserManagementError'
const MANAGEMENT_ERROR_CODES: ReadonlySet<string> = new Set([
    'forbidden', 'unavailable', 'invalid_role', 'invalid_status', 'invalid_field', 'not_found',
    'last_privileged_demotion', 'last_privileged_deletion', 'last_credentialed_administrator',
])

function managementError(code: StaffUserManagementErrorCodeV1): Error {
    const error = new Error(code)
    error.name = MANAGEMENT_ERROR_NAME
    return error
}

/** The refusal code of a strict user-management error, or null for any other error. */
export function staffUserManagementErrorCodeV1(error: unknown): StaffUserManagementErrorCodeV1 | null {
    return error instanceof Error && error.name === MANAGEMENT_ERROR_NAME && MANAGEMENT_ERROR_CODES.has(error.message)
        ? error.message as StaffUserManagementErrorCodeV1
        : null
}

const ROLES: ReadonlySet<string> = new Set(['Менеджер', 'Руководитель', 'Администратор'])
const STATUSES: ReadonlySet<string> = new Set(['Активен', 'Отключен'])
const PRIVILEGED: ReadonlySet<string> = new Set(['Администратор', 'Руководитель'])
const EDITABLE_TEXT_FIELDS = ['firstName', 'lastName', 'email', 'phone'] as const

export interface UserPatchV1 {
    firstName?: string
    lastName?: string
    email?: string
    phone?: string
    role?: StaffRoleV1
    status?: 'Активен' | 'Отключен'
}

/** The explicit field allowlist (§4.4, C-D1b): id, createdAt and anything else are never writable. */
export function allowlistedUserPatchV1(patch: unknown): UserPatchV1 {
    const source = patch !== null && typeof patch === 'object' ? patch as Record<string, unknown> : {}
    const result: UserPatchV1 = {}
    for (const field of EDITABLE_TEXT_FIELDS) {
        const value = source[field]
        if (value === undefined) continue
        if (typeof value !== 'string' || value.length > 256) throw managementError('invalid_field')
        result[field] = value
    }
    if (source.role !== undefined) {
        if (typeof source.role !== 'string' || !ROLES.has(source.role)) throw managementError('invalid_role')
        result.role = source.role as StaffRoleV1
    }
    if (source.status !== undefined) {
        if (typeof source.status !== 'string' || !STATUSES.has(source.status)) throw managementError('invalid_status')
        result.status = source.status as 'Активен' | 'Отключен'
    }
    return result
}

function leavesNoPrivileged(after: RegistryRecordV1[]): boolean {
    return !after.some((record) => PRIVILEGED.has(record.role))
}

/** No change may leave the system without an active Администратор holding a live credential (last-privileged, incl. disable). */
function leavesNoCredentialedAdministrator(before: RegistryRecordV1[], after: RegistryRecordV1[], live: Set<string>): boolean {
    const counts = (records: RegistryRecordV1[], liveIds: Set<string>) => records
        .filter((record) => record.role === 'Администратор' && record.status === 'Активен' && liveIds.has(record.id)).length
    return counts(before, live) > 0 && counts(after, live) === 0
}

async function strictActor(currentPrincipal: () => Promise<StaffSessionPrincipalV1 | null>): Promise<StaffSessionPrincipalV1> {
    const principal = await currentPrincipal()
    if (principal === null) throw managementError('forbidden')
    return principal
}

function audit(action: string, actor: StaffSessionPrincipalV1, target: string, outcome: string): void {
    console.warn(`[staff-session] user-management action=${action} actor=${actor.userId} role=${actor.role} target=${target} outcome=${outcome}`)
}

async function readyRegistry(): Promise<string> {
    const lane = await staffLaneStateV1().catch(() => ({ kind: 'refused', reason: 'lane_unreadable' } as const))
    if (lane.kind === 'ready') return lane.registryPath
    // Strict because rows exist but the lane is not configured: frozen (C-D4a).
    throw managementError(lane.kind === 'dormant' ? 'forbidden' : 'unavailable')
}

/** Strict add: an Администратор under a Staff Session; random immutable id. */
export async function strictAddUserV1(
    currentPrincipal: () => Promise<StaffSessionPrincipalV1 | null>,
    input: unknown,
): Promise<RegistryRecordV1> {
    const actor = await strictActor(currentPrincipal)
    if (actor.role !== 'Администратор') throw managementError('forbidden')
    const patch = allowlistedUserPatchV1(input)
    if (patch.role === undefined) throw managementError('invalid_role')
    const file = await readyRegistry()
    return withRegistryWriteTurnV1(async () => {
        const stored = await readRegistryForWriteV1(file)
        const record: RegistryRecordV1 = {
            id: randomUUID(),
            firstName: patch.firstName ?? '',
            lastName: patch.lastName ?? '',
            ...(patch.email === undefined ? {} : { email: patch.email }),
            ...(patch.phone === undefined ? {} : { phone: patch.phone }),
            role: patch.role!,
            status: patch.status ?? 'Активен',
            createdAt: new Date().toISOString(),
        }
        await writeRegistryAtomicV1(file, [...stored, record])
        audit('addUser', actor, record.id, 'ok')
        return record
    })
}

/**
 * Strict update. Role and status changes, and any write to an employee who
 * holds a credential, need an Администратор; a Руководитель may edit the
 * names and contacts of an employee without one. PostgreSQL first (revoke on
 * disable, epoch bump on role change), then the registry (D2).
 */
export async function strictUpdateUserV1(
    currentPrincipal: () => Promise<StaffSessionPrincipalV1 | null>,
    targetUserId: string,
    input: unknown,
): Promise<void> {
    const actor = await strictActor(currentPrincipal)
    const patch = allowlistedUserPatchV1(input)
    const file = await readyRegistry()
    await withRegistryWriteTurnV1(async () => {
        const stored = await readRegistryForWriteV1(file)
        const registry = stored.filter(isRegistryRecordV1)
        const storedIndex = stored.findIndex((entry) => isRegistryRecordV1(entry) && entry.id === targetUserId)
        if (storedIndex === -1) throw managementError('not_found')
        const before = stored[storedIndex] as RegistryRecordV1
        const changesRole = patch.role !== undefined && patch.role !== before.role
        const changesStatus = patch.status !== undefined && patch.status !== before.status
        const row = await prismaStaffCredentialStoreV1.find(targetUserId).catch(() => {
            throw managementError('unavailable')
        })
        const needsAdministrator = changesRole || changesStatus || row !== null
        if (needsAdministrator ? actor.role !== 'Администратор' : !PRIVILEGED.has(actor.role)) {
            audit('updateUser', actor, targetUserId, 'forbidden')
            throw managementError('forbidden')
        }
        const updated: RegistryRecordV1 = { ...before, ...patch, id: before.id, createdAt: before.createdAt }
        const after = registry.map((record) => (record === before ? updated : record))
        if (leavesNoPrivileged(after)) throw managementError('last_privileged_demotion')

        const disabling = changesStatus && patch.status === 'Отключен'
        if (row !== null && (disabling || changesRole)) {
            // D2: the credential side first, in one transaction. Failure aborts.
            await prismaStaffCredentialStoreV1.locked(async (tx) => {
                const live = await tx.liveUserIds()
                if (leavesNoCredentialedAdministrator(registry, after, live)) throw managementError('last_credentialed_administrator')
                if (disabling) {
                    await tx.revoke(targetUserId, `staff:${actor.userId}`, new Date())
                    await tx.record({ userId: targetUserId, kind: 'revoked', actor: `staff:${actor.userId}` })
                } else {
                    await tx.bumpEpoch(targetUserId, `staff:${actor.userId}`, new Date())
                    await tx.record({ userId: targetUserId, kind: 'epoch_bump', actor: `staff:${actor.userId}` })
                }
            })
        }
        await writeRegistryAtomicV1(file, stored.map((entry, position) => (position === storedIndex ? updated : entry)))
        audit('updateUser', actor, targetUserId, 'ok')
    })
}

/** Strict delete: an Администратор; the credential is revoked first and its row kept (C-D2b), then the registry. */
export async function strictDeleteUserV1(
    currentPrincipal: () => Promise<StaffSessionPrincipalV1 | null>,
    targetUserId: string,
): Promise<void> {
    const actor = await strictActor(currentPrincipal)
    if (actor.role !== 'Администратор') throw managementError('forbidden')
    const file = await readyRegistry()
    await withRegistryWriteTurnV1(async () => {
        const stored = await readRegistryForWriteV1(file)
        const registry = stored.filter(isRegistryRecordV1)
        if (!registry.some((record) => record.id === targetUserId)) throw managementError('not_found')
        const after = registry.filter((record) => record.id !== targetUserId)
        if (leavesNoPrivileged(after)) throw managementError('last_privileged_deletion')
        await prismaStaffCredentialStoreV1.locked(async (tx) => {
            const live = await tx.liveUserIds()
            if (leavesNoCredentialedAdministrator(registry, after, live)) throw managementError('last_credentialed_administrator')
            const revoked = await tx.revoke(targetUserId, `staff:${actor.userId}`, new Date())
            if (revoked !== null) await tx.record({ userId: targetUserId, kind: 'revoked', actor: `staff:${actor.userId}` })
        })
        await writeRegistryAtomicV1(file, stored.filter((entry) => !(isRegistryRecordV1(entry) && entry.id === targetUserId)))
        audit('deleteUser', actor, targetUserId, 'ok')
    })
}
