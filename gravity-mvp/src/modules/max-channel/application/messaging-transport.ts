import 'server-only'

export interface MaxTransportTextInputV1 {
    target: string
    content: string
    providerAccountId: string
    connectionId?: string
    isPersonal: boolean
    quotedMsgId?: string
    uiChatId?: string
    clientMessageId?: string
}

function exactProviderAccountId(value: unknown): string | null {
    if (typeof value !== 'string') return null
    const normalized = value.trim()
    if (!normalized || normalized === 'legacy' || normalized === 'max-default') return null
    return normalized
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

/**
 * The MAX text-send failure contract. The scraper answers every failed send
 * with one of these codes; the CRM's retry policy classifies the error by its
 * prefix, so the message text is fixed here rather than taken from the peer:
 *   *_NOT_DISPATCHED     nothing reached MAX - safe to send again
 *   *_SEND_OUTCOME_UNKNOWN  an action was taken without proof either way -
 *                        never sent again automatically
 *   *_REFUSED            refused before or by MAX - terminal
 */
const MAX_TEXT_SEND_FAILURES: Readonly<Record<string, string>> = Object.freeze({
    MAX_SEND_NOT_DISPATCHED: 'MAX_SEND_NOT_DISPATCHED: nothing reached MAX; the message can be sent again',
    MAX_SEND_OUTCOME_UNKNOWN: 'MAX_SEND_OUTCOME_UNKNOWN: MAX may have received the message; it must not be sent again automatically',
    MAX_ROUTE_UNRESOLVED: 'MAX_ROUTE_UNRESOLVED: no attested MAX Web route for this chat; nothing was dispatched (MAX_SEND_REFUSED)',
    MAX_SEND_REJECTED: 'MAX_SEND_REJECTED: MAX refused the message (MAX_SEND_REFUSED)',
    MAX_REPLY_TARGET_NOT_ADDRESSABLE: 'MAX_REPLY_TARGET_NOT_ADDRESSABLE: the quoted message has no MAX provider id; nothing was dispatched (MAX_SEND_REFUSED)',
})

/** The fixed failure message for a MAX text-send code, or null for any other code. */
export function maxTextSendFailureMessageV1(code: string): string | null {
    return MAX_TEXT_SEND_FAILURES[code] ?? null
}

/**
 * What a failed text send proves (S2 typed failure). The scraper refuses
 * before it touches the page with a status and a code, so:
 *   503 with MAX_SEND_NOT_DISPATCHED or MAX_PROVIDER_ACCOUNT_UNPROVEN, and a
 *       scraper that refused the connection: nothing reached MAX - safe to send
 *       again;
 *   400, 404, 409 and 422: refused before anything was sent, or refused by MAX
 *       itself - a repeat meets the same answer, so terminal;
 *   anything else (500, 502 MAX_SEND_OUTCOME_UNKNOWN, a reset, no answer):
 *       unknown, and not typed at all.
 */
export interface MaxTextSendFailureV1 {
    outcome: 'safe_to_redeliver' | 'terminal'
    code: string
}

const MAX_TEXT_SEND_SAFE_CODES: ReadonlySet<string> = new Set(['MAX_SEND_NOT_DISPATCHED', 'MAX_PROVIDER_ACCOUNT_UNPROVEN'])
const MAX_TEXT_SEND_TERMINAL_STATUSES: ReadonlySet<number> = new Set([400, 404, 409, 422])
const MAX_TEXT_SEND_FAILURE = Symbol('maxTextSendFailure')

type TypedMaxTextSendError = Error & { [MAX_TEXT_SEND_FAILURE]?: MaxTextSendFailureV1 }

function classifyMaxTextSendAnswer(status: number, code: string): MaxTextSendFailureV1 | null {
    if (status === 503 && MAX_TEXT_SEND_SAFE_CODES.has(code)) return { outcome: 'safe_to_redeliver', code }
    if (MAX_TEXT_SEND_TERMINAL_STATUSES.has(status)) return { outcome: 'terminal', code: code || `MAX_SCRAPER_HTTP_${status}` }
    return null
}

/** The typed failure a MAX text send threw, or null for an error of unknown outcome. */
export function readMaxTextSendFailureV1(error: unknown): MaxTextSendFailureV1 | null {
    if (!(error instanceof Error)) return null
    return (error as TypedMaxTextSendError)[MAX_TEXT_SEND_FAILURE] ?? null
}

function typedMaxTextSendError(message: string, failure: MaxTextSendFailureV1 | null): Error {
    const error: TypedMaxTextSendError = new Error(message)
    if (failure) error[MAX_TEXT_SEND_FAILURE] = failure
    return error
}

function maxTextSendFailure(payload: Record<string, unknown>, fallback: string, status: number): Error {
    const code = typeof payload.code === 'string' ? payload.code.trim() : ''
    return typedMaxTextSendError(maxTextSendFailureMessageV1(code) ?? fallback, classifyMaxTextSendAnswer(status, code))
}

// fetch rejects with the socket error as its cause: ECONNREFUSED means the
// scraper never accepted the request, so it cannot have acted on it.
function scraperRefusedConnection(error: unknown): boolean {
    const cause = error instanceof Error ? (error as Error & { cause?: unknown }).cause : null
    const code = cause && typeof cause === 'object' ? (cause as { code?: unknown }).code : null
    return code === 'ECONNREFUSED'
}

/**
 * MAX-owned, server-only transport boundary. The personal scraper must prove
 * that the requested account is the authenticated live MAX Web account.
 */
export async function sendMaxTransportTextV1(input: MaxTransportTextInputV1): Promise<Record<string, unknown>> {
    if (!input.target || !input.content) {
        throw new Error('Target (chatId or phone) and message are required')
    }
    const providerAccountId = exactProviderAccountId(input.providerAccountId)
    // The scraper selects a live personal session by account id and echoes it
    // back for verification, so delivery genuinely cannot proceed without one.
    // This is a TRANSPORT capability requirement, not conversation admission.
    if (!providerAccountId) {
        throw new Error('MAX_TRANSPORT_ACCOUNT_REQUIRED')
    }
    if (!input.isPersonal) {
        // No live bot transport exists yet. A configured database connection is
        // not delivery proof, so bot delivery remains unavailable.
        throw new Error('MAX_BOT_DELIVERY_TRANSPORT_UNAVAILABLE')
    }
    if (input.connectionId && input.connectionId !== 'scraper' && input.connectionId !== 'max_scraper') {
        throw new Error('CONTACT_CONVERSATION_PROVIDER_TRANSPORT_MISMATCH')
    }

    const target = input.target.replace(/\D/g, '')
    if (!target) throw new Error('Invalid target')

    const scraperUrl = process.env.MAX_SCRAPER_URL || 'http://localhost:3005'
    let response: Response
    try {
        response = await fetch(`${scraperUrl}/send-message`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chatId: target,
                message: input.content,
                quotedMsgId: input.quotedMsgId,
                uiChatId: input.uiChatId,
                clientMessageId: input.clientMessageId,
                providerAccountId,
            }),
        })
    } catch (error) {
        if (scraperRefusedConnection(error)) {
            throw typedMaxTextSendError(
                'MAX_SEND_NOT_DISPATCHED: the MAX scraper refused the connection; nothing reached MAX',
                { outcome: 'safe_to_redeliver', code: 'MAX_SCRAPER_UNREACHABLE' },
            )
        }
        throw error
    }
    const rawPayload: unknown = await response.json().catch(() => ({}))
    const payload = isRecord(rawPayload) ? rawPayload : {}
    const error = typeof payload.error === 'string' && payload.error.trim()
        ? payload.error.trim()
        : null
    const hasExplicitError = Object.prototype.hasOwnProperty.call(payload, 'error')
        && (typeof payload.error === 'string'
            ? payload.error.trim().length > 0
            : payload.error !== null && payload.error !== undefined)
    const hasExplicitFailure = payload.success === false || payload.failed === true || payload.failure === true
    if (!response.ok || hasExplicitFailure || hasExplicitError) {
        throw maxTextSendFailure(payload, error || (response.ok ? 'MAX text delivery failed' : 'Failed to send message via Scraper'), response.ok ? 0 : response.status)
    }
    if (exactProviderAccountId(payload.providerAccountId) !== providerAccountId) {
        throw new Error('MAX_PROVIDER_ACCOUNT_PROOF_MISMATCH')
    }
    return payload
}
