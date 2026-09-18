/**
 * WhatsApp pairing observation (M2A1-S2, measurement only).
 *
 * Reads the WhatsApp Web page's own stored pairing record, the PN user and the
 * LID user the page believes it is paired to, in one synchronous page
 * evaluation, and classifies what it saw. This evidence is transport-asserted:
 * the slot describes itself. Nothing here creates, verifies or changes an
 * account, key, binding, lease, conversation or any runtime authority, and raw
 * identifiers never leave this module except as the in-memory comparable pair
 * the observer turns into a keyed comparison value.
 */

export const WHATSAPP_PAIRING_OUTCOMES_V1 = [
    'complete',
    'partial',
    'invalid',
    'unavailable',
    'gated',
    'timeout',
    'stale_instance',
] as const
export type WhatsAppPairingOutcomeV1 = (typeof WHATSAPP_PAIRING_OUTCOMES_V1)[number]

export const WHATSAPP_SOCKET_STATE_CLASSES_V1 = [
    'connected',
    'opening',
    'pairing',
    'unpaired',
    'conflict',
    'timeout',
    'other',
    'unknown',
] as const
export type WhatsAppSocketStateClassV1 = (typeof WHATSAPP_SOCKET_STATE_CLASSES_V1)[number]

export const WHATSAPP_PAGE_UNAVAILABLE_REASONS_V1 = [
    'page_missing',
    'page_closed',
    'context_destroyed',
    'evaluate_failed',
    'malformed_result',
    'module_unavailable',
] as const
export type WhatsAppPageUnavailableReasonV1 = (typeof WHATSAPP_PAGE_UNAVAILABLE_REASONS_V1)[number]

/** One wid exactly as the page returned it. Raw values stay inside this module. */
export interface WhatsAppPairingPageWidV1 {
    server: string | null
    user: string | null
    device: unknown
    agent: unknown
}

/** What the page evaluation returns. */
export interface WhatsAppPairingPageStateV1 {
    moduleAvailable: boolean
    socketState: string | null
    hasSynced: boolean
    pn: WhatsAppPairingPageWidV1 | null
    pnReadFailed: boolean
    lid: WhatsAppPairingPageWidV1 | null
    lidReadFailed: boolean
    waWebVersion: string | null
}

export type WhatsAppPairingPageReadV1 =
    | {
        kind: 'page_state'
        state: WhatsAppPairingPageStateV1
        infoWid: { server: unknown; user: unknown } | null
    }
    | { kind: 'unavailable'; reasonClass: WhatsAppPageUnavailableReasonV1 }
    | { kind: 'timeout' }

/** The part of a whatsapp-web.js client the reader needs, and nothing more. */
export interface WhatsAppPairingObservationClientV1 {
    readonly pupPage?: {
        evaluate(pageFunction: () => unknown): Promise<unknown>
        isClosed?(): boolean
    } | null
    readonly info?: { readonly wid?: { readonly server?: unknown; readonly user?: unknown } | null } | null
}

export interface WhatsAppPairingReadOptionsV1 {
    timeoutMs: number
    setTimer(callback: () => void, delayMs: number): unknown
    clearTimer(handle: unknown): void
}

/**
 * Runs inside the WhatsApp Web page, so it must stay self-contained: no await,
 * no imports and no helpers from outside its own body. Both getters are read in
 * the same synchronous task, so they describe one page state.
 */
export function readWhatsAppPairingPageStateV1(): WhatsAppPairingPageStateV1 {
    const scope = globalThis as unknown as {
        require?: (moduleName: string) => unknown
        Debug?: { VERSION?: unknown }
    }
    const state: WhatsAppPairingPageStateV1 = {
        moduleAvailable: false,
        socketState: null,
        hasSynced: false,
        pn: null,
        pnReadFailed: false,
        lid: null,
        lidReadFailed: false,
        waWebVersion: null,
    }
    const project = (wid: unknown): WhatsAppPairingPageWidV1 | null => {
        if (!wid || typeof wid !== 'object') return null
        const value = wid as { server?: unknown; user?: unknown; device?: unknown; agent?: unknown }
        return {
            server: typeof value.server === 'string' ? value.server : null,
            user: typeof value.user === 'string' ? value.user : null,
            device: value.device === undefined ? null : value.device,
            agent: value.agent === undefined ? null : value.agent,
        }
    }
    try {
        const version = scope.Debug ? scope.Debug.VERSION : undefined
        if (typeof version === 'string') state.waWebVersion = version
    } catch {
        // The version is optional telemetry.
    }
    type SocketModule = { Socket?: { state?: unknown; hasSynced?: unknown } }
    type MeUserModule = { getMaybeMePnUser?: () => unknown; getMaybeMeLidUser?: () => unknown }
    const load = (): { socket: SocketModule | null; meUser: MeUserModule | null } => {
        try {
            if (typeof scope.require !== 'function') return { socket: null, meUser: null }
            return {
                socket: scope.require('WAWebSocketModel') as SocketModule | null,
                meUser: scope.require('WAWebUserPrefsMeUser') as MeUserModule | null,
            }
        } catch {
            return { socket: null, meUser: null }
        }
    }
    const modules = load()
    const socket = modules.socket ? modules.socket.Socket : undefined
    const meUser = modules.meUser
    if (!socket || !meUser
        || typeof meUser.getMaybeMePnUser !== 'function'
        || typeof meUser.getMaybeMeLidUser !== 'function') {
        return state
    }
    state.moduleAvailable = true
    state.socketState = typeof socket.state === 'string' ? socket.state : null
    state.hasSynced = socket.hasSynced === true
    if (state.socketState !== 'CONNECTED' || !state.hasSynced) return state
    try {
        state.pn = project(meUser.getMaybeMePnUser())
    } catch {
        state.pnReadFailed = true
    }
    try {
        state.lid = project(meUser.getMaybeMeLidUser())
    } catch {
        state.lidReadFailed = true
    }
    return state
}

const CONTEXT_DESTROYED = /Execution context was destroyed|Protocol error \(Runtime\.|Target closed|detached Frame|frame was detached|Session closed/i
const TIMED_OUT = Symbol('whatsapp-pairing-read-timeout')

function isPageState(value: unknown): value is WhatsAppPairingPageStateV1 {
    if (!value || typeof value !== 'object') return false
    const state = value as Record<string, unknown>
    const isWid = (wid: unknown) => wid === null || (typeof wid === 'object' && wid !== null)
    return typeof state.moduleAvailable === 'boolean'
        && (state.socketState === null || typeof state.socketState === 'string')
        && typeof state.hasSynced === 'boolean'
        && isWid(state.pn)
        && typeof state.pnReadFailed === 'boolean'
        && isWid(state.lid)
        && typeof state.lidReadFailed === 'boolean'
        && (state.waWebVersion === null || typeof state.waWebVersion === 'string')
}

/**
 * Reads the pairing record from a client's page with a bounded wait. It never
 * retries: a page that is navigating or closed is reported as unavailable.
 */
export async function readWhatsAppPairingObservationV1(
    client: WhatsAppPairingObservationClientV1,
    options: WhatsAppPairingReadOptionsV1,
): Promise<WhatsAppPairingPageReadV1> {
    const page = client.pupPage
    if (!page) return { kind: 'unavailable', reasonClass: 'page_missing' }
    try {
        if (typeof page.isClosed === 'function' && page.isClosed()) {
            return { kind: 'unavailable', reasonClass: 'page_closed' }
        }
    } catch {
        return { kind: 'unavailable', reasonClass: 'page_closed' }
    }

    let timer: unknown = null
    const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
        timer = options.setTimer(() => resolve(TIMED_OUT), options.timeoutMs)
    })
    try {
        const result = await Promise.race([page.evaluate(readWhatsAppPairingPageStateV1), timeout])
        if (result === TIMED_OUT) return { kind: 'timeout' }
        if (!isPageState(result)) return { kind: 'unavailable', reasonClass: 'malformed_result' }
        const wid = client.info ? client.info.wid : null
        return {
            kind: 'page_state',
            state: result,
            infoWid: wid ? { server: wid.server, user: wid.user } : null,
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {
            kind: 'unavailable',
            reasonClass: CONTEXT_DESTROYED.test(message) ? 'context_destroyed' : 'evaluate_failed',
        }
    } finally {
        options.clearTimer(timer)
    }
}

/** Measurement flags only: no identifier, and null means not evaluated. */
export interface WhatsAppPairingObservationFlagsV1 {
    outcome: WhatsAppPairingOutcomeV1
    reasonClass: WhatsAppPageUnavailableReasonV1 | 'none'
    socketStateClass: WhatsAppSocketStateClassV1
    hasSynced: boolean | null
    pnPresent: boolean | null
    pnShapeValid: boolean | null
    lidPresent: boolean | null
    lidShapeValid: boolean | null
    pnDiffersFromLid: boolean | null
    infoWidMatchesPn: boolean | null
    waWebVersion: string | null
}

export interface WhatsAppPairingClassificationV1 {
    flags: WhatsAppPairingObservationFlagsV1
    /** Present only for a complete observation; the observer keeps it in memory only. */
    comparablePair: { pnUser: string; lidUser: string } | null
}

const DIGITS_ONLY = /^[0-9]{1,64}$/

function socketStateClass(state: string | null): WhatsAppSocketStateClassV1 {
    switch (state) {
        case null: return 'unknown'
        case 'CONNECTED': return 'connected'
        case 'OPENING': return 'opening'
        case 'PAIRING': return 'pairing'
        case 'UNPAIRED':
        case 'UNPAIRED_IDLE': return 'unpaired'
        case 'CONFLICT': return 'conflict'
        case 'TIMEOUT': return 'timeout'
        default: return 'other'
    }
}

function isUserWid(wid: WhatsAppPairingPageWidV1 | null, server: 'c.us' | 'lid'): boolean {
    if (!wid) return false
    const noDevice = (value: unknown) => value === null || value === 0
    return wid.server === server
        && typeof wid.user === 'string'
        && DIGITS_ONLY.test(wid.user)
        && noDevice(wid.device)
        && noDevice(wid.agent)
}

function notEvaluated(
    outcome: WhatsAppPairingOutcomeV1,
    reasonClass: WhatsAppPairingObservationFlagsV1['reasonClass'],
    extra: Partial<WhatsAppPairingObservationFlagsV1> = {},
): WhatsAppPairingClassificationV1 {
    return {
        flags: {
            outcome,
            reasonClass,
            socketStateClass: 'unknown',
            hasSynced: null,
            pnPresent: null,
            pnShapeValid: null,
            lidPresent: null,
            lidShapeValid: null,
            pnDiffersFromLid: null,
            infoWidMatchesPn: null,
            waWebVersion: null,
            ...extra,
        },
        comparablePair: null,
    }
}

/**
 * Classifies one page read. A complete observation requires a connected,
 * synced page, both getters returning a user wid of their own server with a
 * digits-only user and no device part, PN and LID differing, and client.info
 * wid equal to the PN.
 */
export function classifyWhatsAppPairingObservationV1(read: WhatsAppPairingPageReadV1): WhatsAppPairingClassificationV1 {
    if (read.kind === 'timeout') return notEvaluated('timeout', 'none')
    if (read.kind === 'unavailable') return notEvaluated('unavailable', read.reasonClass)

    const { state } = read
    const common = {
        socketStateClass: socketStateClass(state.socketState),
        hasSynced: state.hasSynced,
        waWebVersion: state.waWebVersion,
    }
    // Without the modules the socket was never read, so its state and sync flag stay not evaluated.
    if (!state.moduleAvailable) return notEvaluated('unavailable', 'module_unavailable', { waWebVersion: state.waWebVersion })
    if (state.socketState !== 'CONNECTED' || !state.hasSynced) return notEvaluated('gated', 'none', common)

    const pnPresent = state.pn !== null || state.pnReadFailed
    const lidPresent = state.lid !== null || state.lidReadFailed
    const pnShapeValid = pnPresent ? !state.pnReadFailed && isUserWid(state.pn, 'c.us') : false
    const lidShapeValid = lidPresent ? !state.lidReadFailed && isUserWid(state.lid, 'lid') : false
    const bothValid = pnShapeValid && lidShapeValid
    const pnUser = bothValid ? state.pn!.user! : null
    const lidUser = bothValid ? state.lid!.user! : null
    const pnDiffersFromLid = bothValid ? pnUser !== lidUser : null
    const infoWidMatchesPn = pnShapeValid
        ? read.infoWid !== null && read.infoWid.server === 'c.us' && read.infoWid.user === state.pn!.user
        : null

    let outcome: WhatsAppPairingOutcomeV1
    if ((pnPresent && !pnShapeValid) || (lidPresent && !lidShapeValid)) outcome = 'invalid'
    else if (!pnPresent || !lidPresent) outcome = 'partial'
    else if (!pnDiffersFromLid || !infoWidMatchesPn) outcome = 'invalid'
    else outcome = 'complete'

    return {
        flags: {
            outcome,
            reasonClass: 'none',
            ...common,
            pnPresent,
            pnShapeValid,
            lidPresent,
            lidShapeValid,
            pnDiffersFromLid,
            infoWidMatchesPn,
        },
        comparablePair: outcome === 'complete' ? { pnUser: pnUser!, lidUser: lidUser! } : null,
    }
}
