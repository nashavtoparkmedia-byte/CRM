/**
 * Live-acceptance recipient guard (test environment only).
 *
 * The live integration acceptance runs real provider accounts against an
 * isolated CRM. Every channel adapter calls this guard at its last outbound
 * choke point, right before the provider call, with the RESOLVED provider
 * recipient (WhatsApp JID, MAX chat/user id, Telegram peer/chat id), and at
 * inbound/sync before anything is created for a peer.
 *
 * Activation is read from the environment once, when this module loads; no
 * request, setting or database row can switch it:
 * - `YOKO_LIVE_ACCEPTANCE` unset: OFF. Every call returns at once; production
 *   behaviour is unchanged. Production configuration never sets it.
 * - `YOKO_LIVE_ACCEPTANCE=1`: ENFORCE, fail-closed. The allowlist file
 *   (`YOKO_LIVE_RECIPIENT_ALLOWLIST_FILE`, read at load and then frozen: any
 *   later change of its bytes, emptying it in place included, refuses
 *   everything until restart and can never widen it) must be present, valid, unexpired and
 *   name at least one recipient for the lane, and the state directory
 *   (`YOKO_LIVE_STATE_DIR`, absolute, writable) must be usable; otherwise every
 *   send and every inbound peer of that lane is refused.
 * - Any other value of `YOKO_LIVE_ACCEPTANCE`: refuse everything (a typo never
 *   turns the guard off).
 *
 * Matching is exact on the resolved id: no prefix, suffix or normalisation
 * logic. A group is allowed only when its id is listed. The send cap counts
 * every attempt the guard lets through (text, media, reaction, delete, retry)
 * per lane. It is persisted in the state directory as one exclusively created
 * slot file per send, re-read on every send, so it survives restarts and is
 * shared by every module instance and process of the lane. A minimum interval
 * applies per recipient (two instances racing on the same recipient within one
 * read can both pass it; the cap itself cannot be exceeded). A refusal is a
 * typed `terminal` channel delivery error raised before the provider is called.
 *
 * Status (`liveAcceptanceGuardStatusV1`) reports counts only, never ids. When
 * the marker is set, one `YOKO_LIVE_GUARD channel=<lane> mode=<enforce|refuse_all>
 * entries=<N>` line per lane is logged as the module loads, for the live
 * environment's pre-start check.
 */

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { channelDeliveryErrorV1, type ChannelDeliveryErrorV1 } from './channel-delivery-runtime'

export const LIVE_ACCEPTANCE_ALLOWLIST_SCHEMA_V1 = 'yoko.live-acceptance.recipient-allowlist.v1'

export const LIVE_ACCEPTANCE_LANES_V1 = ['whatsapp', 'max', 'telegram_mtproto', 'telegram_bot'] as const
export type LiveAcceptanceLaneV1 = typeof LIVE_ACCEPTANCE_LANES_V1[number]

/** `send` counts against the cap and the interval; `lookup` (a provider lookup of a recipient) only checks the allowlist. */
export type LiveAcceptanceSendKindV1 = 'send' | 'lookup'

export type LiveAcceptanceRefusalCodeV1 =
    | 'LIVE_GUARD_CONFIG_INVALID'
    | 'LIVE_GUARD_CONFIG_CHANGED'
    | 'LIVE_GUARD_EXPIRED'
    | 'LIVE_GUARD_LANE_EMPTY'
    | 'LIVE_GUARD_NOT_LISTED'
    | 'LIVE_GUARD_CAP_REACHED'
    | 'LIVE_GUARD_INTERVAL'
    | 'LIVE_GUARD_COUNTER_UNAVAILABLE'

export type LiveAcceptanceGuardStatusV1 =
    | { mode: 'off' }
    | { mode: 'refuse_all'; reason: LiveAcceptanceRefusalCodeV1 }
    | {
        mode: 'enforce'
        runId: string
        expiresAt: string
        lanes: Record<LiveAcceptanceLaneV1, { entries: number; maxSends: number; sendsUsed: number }>
    }

export interface LiveAcceptanceGuardV1 {
    isActive(): boolean
    assertRecipientAllowed(lane: LiveAcceptanceLaneV1, recipientId: string, kind: LiveAcceptanceSendKindV1): void
    isPeerAllowed(lane: LiveAcceptanceLaneV1, peerId: string): boolean
    status(): LiveAcceptanceGuardStatusV1
}

export interface LiveAcceptanceGuardDependenciesV1 {
    env: Readonly<Record<string, string | undefined>>
    readFile(file: string): string
    ensureDirectory(directory: string): void
    /** Contents of every slot file in `directory` whose name starts with `prefix` (none yet: []). */
    readSlots(directory: string, prefix: string): string[]
    /** Creates `file` exclusively with `content`: true when created, false when it already exists; throws otherwise. */
    claimSlot(file: string, content: string): boolean
    log(line: string): void
    now(): number
}

interface LaneConfig { recipients: Set<string>; maxSends: number }
interface EnforceConfig {
    runId: string
    expiresAtMs: number
    expiresAt: string
    minIntervalMs: number
    counterDirectory: string
    lanes: Record<LiveAcceptanceLaneV1, LaneConfig>
}

const MAX_SENDS_LIMIT = 1000
const CLAIM_ATTEMPTS = 8
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value)
}

function sha256(value: string): string {
    return createHash('sha256').update(value).digest('hex')
}

/** Parses the allowlist file. Any deviation from the schema is invalid: unknown keys included. */
function parseAllowlist(raw: string, counterDirectory: string): EnforceConfig | null {
    let value: unknown
    try {
        value = JSON.parse(raw)
    } catch {
        return null
    }
    if (!isRecord(value)) return null
    const keys = Object.keys(value).sort().join(',')
    if (keys !== 'channels,expires_at,min_interval_ms_per_recipient,run_id,schema') return null
    if (value.schema !== LIVE_ACCEPTANCE_ALLOWLIST_SCHEMA_V1) return null
    if (typeof value.run_id !== 'string' || !RUN_ID.test(value.run_id)) return null
    if (typeof value.expires_at !== 'string') return null
    const expiresAtMs = Date.parse(value.expires_at)
    if (!Number.isFinite(expiresAtMs)) return null
    const minIntervalMs = value.min_interval_ms_per_recipient
    if (typeof minIntervalMs !== 'number' || !Number.isInteger(minIntervalMs) || minIntervalMs < 0 || minIntervalMs > 3_600_000) return null
    if (!isRecord(value.channels)) return null
    const channelKeys = Object.keys(value.channels)
    if (channelKeys.some((key) => !(LIVE_ACCEPTANCE_LANES_V1 as readonly string[]).includes(key))) return null
    const lanes = {} as Record<LiveAcceptanceLaneV1, LaneConfig>
    for (const lane of LIVE_ACCEPTANCE_LANES_V1) {
        const entry = value.channels[lane]
        if (entry === undefined) {
            lanes[lane] = { recipients: new Set(), maxSends: 0 }
            continue
        }
        if (!isRecord(entry)) return null
        if (Object.keys(entry).sort().join(',') !== 'max_sends,recipients') return null
        const { recipients, max_sends: maxSends } = entry
        if (!Array.isArray(recipients) || recipients.some((id) => typeof id !== 'string' || id === '' || id.trim() !== id)) return null
        if (new Set(recipients).size !== recipients.length) return null
        if (typeof maxSends !== 'number' || !Number.isInteger(maxSends) || maxSends < 0 || maxSends > MAX_SENDS_LIMIT) return null
        lanes[lane] = { recipients: new Set(recipients as string[]), maxSends }
    }
    return { runId: value.run_id, expiresAtMs, expiresAt: new Date(expiresAtMs).toISOString(), minIntervalMs, counterDirectory, lanes }
}

function refusal(code: LiveAcceptanceRefusalCodeV1): ChannelDeliveryErrorV1 {
    return channelDeliveryErrorV1(`live acceptance guard refused the send (${code})`, 'terminal', code)
}

interface SlotRecord { atMs: number; recipientHash: string }

/** One slot per send the guard let through: `<ISO time>\t<sha256 of the recipient id>\n`. */
function parseSlot(content: string): SlotRecord {
    const match = /^([^\t\n]+)\t([0-9a-f]{64})\n$/.exec(content)
    const atMs = match ? Date.parse(match[1]) : Number.NaN
    if (!match || !Number.isFinite(atMs)) throw new Error('counter slot is malformed')
    return { atMs, recipientHash: match[2] }
}

export function createLiveAcceptanceGuardV1(dependencies: LiveAcceptanceGuardDependenciesV1): LiveAcceptanceGuardV1 {
    const marker = dependencies.env.YOKO_LIVE_ACCEPTANCE
    if (marker === undefined || marker === '') {
        return {
            isActive: () => false,
            assertRecipientAllowed: () => undefined,
            isPeerAllowed: () => true,
            status: () => ({ mode: 'off' }),
        }
    }

    let config: EnforceConfig | null = null
    let startupRaw: string | null = null
    let startupRefusal: LiveAcceptanceRefusalCodeV1 = 'LIVE_GUARD_CONFIG_INVALID'
    const file = dependencies.env.YOKO_LIVE_RECIPIENT_ALLOWLIST_FILE
    const counterDirectory = dependencies.env.YOKO_LIVE_STATE_DIR
    if (marker === '1' && file && counterDirectory && path.isAbsolute(counterDirectory)) {
        let raw: string | null = null
        try {
            raw = dependencies.readFile(file)
        } catch {
            raw = null
        }
        config = raw === null ? null : parseAllowlist(raw, counterDirectory)
        startupRaw = raw
        if (config) {
            try {
                dependencies.ensureDirectory(counterDirectory)
                for (const lane of LIVE_ACCEPTANCE_LANES_V1) slots(config, lane)
            } catch {
                config = null
                startupRefusal = 'LIVE_GUARD_COUNTER_UNAVAILABLE'
            }
        }
    }

    function slotPrefix(active: EnforceConfig, lane: LiveAcceptanceLaneV1): string {
        return `${active.runId}.${lane}.slot-`
    }

    /** Re-read on every use, so every module instance and process of the lane shares one count, across restarts. */
    function slots(active: EnforceConfig, lane: LiveAcceptanceLaneV1): SlotRecord[] {
        return dependencies.readSlots(active.counterDirectory, slotPrefix(active, lane)).map(parseSlot)
    }

    /**
     * The file is frozen at its startup bytes: it is re-read on every check and any
     * change (emptied in place, edited, removed, unreadable) refuses everything until
     * the process restarts. It can stop sends at once and can never widen the list.
     */
    function fileChanged(): boolean {
        try {
            return dependencies.readFile(file as string) !== startupRaw
        } catch {
            return true
        }
    }

    /** Null when the lane may proceed to the per-recipient checks; otherwise the refusal code. */
    function laneRefusal(lane: LiveAcceptanceLaneV1): LiveAcceptanceRefusalCodeV1 | null {
        if (!config) return startupRefusal
        if (fileChanged()) return 'LIVE_GUARD_CONFIG_CHANGED'
        if (!(LIVE_ACCEPTANCE_LANES_V1 as readonly string[]).includes(lane)) return 'LIVE_GUARD_CONFIG_INVALID'
        if (dependencies.now() >= config.expiresAtMs) return 'LIVE_GUARD_EXPIRED'
        if (config.lanes[lane].recipients.size === 0) return 'LIVE_GUARD_LANE_EMPTY'
        return null
    }

    const guard: LiveAcceptanceGuardV1 = {
        isActive: () => true,
        assertRecipientAllowed(lane, recipientId, kind) {
            const laneCode = laneRefusal(lane)
            if (laneCode) throw refusal(laneCode)
            const active = config as EnforceConfig
            if (typeof recipientId !== 'string' || !active.lanes[lane].recipients.has(recipientId)) throw refusal('LIVE_GUARD_NOT_LISTED')
            if (kind !== 'send') {
                if (kind !== 'lookup') throw refusal('LIVE_GUARD_CONFIG_INVALID')
                return
            }
            const recipientHash = sha256(recipientId)
            for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt += 1) {
                let taken: SlotRecord[]
                try {
                    taken = slots(active, lane)
                } catch {
                    throw refusal('LIVE_GUARD_COUNTER_UNAVAILABLE')
                }
                if (taken.length >= active.lanes[lane].maxSends) throw refusal('LIVE_GUARD_CAP_REACHED')
                const now = dependencies.now()
                const last = taken.filter((slot) => slot.recipientHash === recipientHash).reduce((max, slot) => Math.max(max, slot.atMs), Number.NEGATIVE_INFINITY)
                if (now - last < active.minIntervalMs) throw refusal('LIVE_GUARD_INTERVAL')
                // Claimed before the provider call: a crash after this point still counts as a send (fail-closed).
                const slotFile = path.join(active.counterDirectory, `${slotPrefix(active, lane)}${String(taken.length + 1).padStart(4, '0')}`)
                let claimed: boolean
                try {
                    claimed = dependencies.claimSlot(slotFile, `${new Date(now).toISOString()}\t${recipientHash}\n`)
                } catch {
                    throw refusal('LIVE_GUARD_COUNTER_UNAVAILABLE')
                }
                if (claimed) return
                // Another instance took this slot first: count again.
            }
            throw refusal('LIVE_GUARD_COUNTER_UNAVAILABLE')
        },
        isPeerAllowed(lane, peerId) {
            if (laneRefusal(lane)) return false
            return typeof peerId === 'string' && (config as EnforceConfig).lanes[lane].recipients.has(peerId)
        },
        status() {
            if (!config) return { mode: 'refuse_all', reason: startupRefusal }
            if (fileChanged()) return { mode: 'refuse_all', reason: 'LIVE_GUARD_CONFIG_CHANGED' }
            const lanes = {} as Record<LiveAcceptanceLaneV1, { entries: number; maxSends: number; sendsUsed: number }>
            for (const lane of LIVE_ACCEPTANCE_LANES_V1) {
                let sendsUsed: number
                try {
                    sendsUsed = slots(config, lane).length
                } catch {
                    return { mode: 'refuse_all', reason: 'LIVE_GUARD_COUNTER_UNAVAILABLE' }
                }
                lanes[lane] = { entries: config.lanes[lane].recipients.size, maxSends: config.lanes[lane].maxSends, sendsUsed }
            }
            return { mode: 'enforce', runId: config.runId, expiresAt: config.expiresAt, lanes }
        },
    }

    // The live environment's pre-start check reads this line per lane (mode and count only, never ids).
    // Printed only when the marker is set; with the guard off nothing is logged.
    const startup = guard.status()
    for (const lane of LIVE_ACCEPTANCE_LANES_V1) {
        const mode = startup.mode === 'enforce' && startup.lanes[lane].entries > 0 ? 'enforce' : 'refuse_all'
        const entries = startup.mode === 'enforce' ? startup.lanes[lane].entries : 0
        dependencies.log(`YOKO_LIVE_GUARD channel=${lane} mode=${mode} entries=${entries}`)
    }
    return guard
}

function readSlotsFromDisk(directory: string, prefix: string): string[] {
    return readdirSync(directory)
        .filter((name) => name.startsWith(prefix))
        .sort()
        .map((name) => readFileSync(path.join(directory, name), 'utf8'))
}

function claimSlotOnDisk(file: string, content: string): boolean {
    try {
        writeFileSync(file, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
        return true
    } catch (error: unknown) {
        if (isRecord(error) && error.code === 'EEXIST') return false
        throw error
    }
}

const LIVE_GUARD_CODES: ReadonlySet<string> = new Set<LiveAcceptanceRefusalCodeV1>([
    'LIVE_GUARD_CONFIG_INVALID', 'LIVE_GUARD_CONFIG_CHANGED', 'LIVE_GUARD_EXPIRED', 'LIVE_GUARD_LANE_EMPTY', 'LIVE_GUARD_NOT_LISTED',
    'LIVE_GUARD_CAP_REACHED', 'LIVE_GUARD_INTERVAL', 'LIVE_GUARD_COUNTER_UNAVAILABLE',
])

/** The guard's refusal code when `error` is a guard refusal, otherwise null. */
export function readLiveRecipientRefusalV1(error: unknown): LiveAcceptanceRefusalCodeV1 | null {
    if (!isRecord(error) || error.name !== 'ChannelDeliveryErrorV1' || error.deliveryOutcome !== 'terminal') return null
    return typeof error.deliveryErrorCode === 'string' && LIVE_GUARD_CODES.has(error.deliveryErrorCode)
        ? error.deliveryErrorCode as LiveAcceptanceRefusalCodeV1
        : null
}

/**
 * A provider id safe for evidence and logs: in every run of five or more digits
 * only the last four stay (a phone-bearing JID, a peer or chat id); everything
 * else is kept as is. `79161234567@c.us` -> `•••••••4567@c.us`.
 */
export function maskLiveProviderIdV1(id: string): string {
    return String(id).replace(/\d{5,}/g, (digits) => `${'•'.repeat(digits.length - 4)}${digits.slice(-4)}`)
}

const processGuard = createLiveAcceptanceGuardV1({
    env: process.env,
    readFile: (file) => readFileSync(file, 'utf8'),
    ensureDirectory: (directory) => { mkdirSync(directory, { recursive: true, mode: 0o700 }) },
    readSlots: readSlotsFromDisk,
    claimSlot: claimSlotOnDisk,
    log: (line) => console.log(line),
    now: () => Date.now(),
})

/** True only when this process runs with the live-acceptance marker set (enforcing or refusing everything). */
export function isLiveAcceptanceGuardActiveV1(): boolean {
    return processGuard.isActive()
}

/** Throws a `terminal` ChannelDeliveryErrorV1 unless the resolved provider recipient is allowed; a no-op when the guard is off. */
export function assertLiveRecipientAllowedV1(lane: LiveAcceptanceLaneV1, recipientId: string, kind: LiveAcceptanceSendKindV1): void {
    processGuard.assertRecipientAllowed(lane, recipientId, kind)
}

/** Inbound and sync: true when nothing may be refused (guard off) or the peer is listed for the lane. */
export function isLivePeerAllowedV1(lane: LiveAcceptanceLaneV1, peerId: string): boolean {
    return processGuard.isPeerAllowed(lane, peerId)
}

/** Counts only, never ids: for each lane's status field and the live environment's pre-start check. */
export function liveAcceptanceGuardStatusV1(): LiveAcceptanceGuardStatusV1 {
    return processGuard.status()
}
