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

function maxTextSendFailure(payload: Record<string, unknown>, fallback: string): Error {
    const code = typeof payload.code === 'string' ? payload.code.trim() : ''
    return new Error(maxTextSendFailureMessageV1(code) ?? fallback)
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
    const response = await fetch(`${scraperUrl}/send-message`, {
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
        throw maxTextSendFailure(payload, error || (response.ok ? 'MAX text delivery failed' : 'Failed to send message via Scraper'))
    }
    if (exactProviderAccountId(payload.providerAccountId) !== providerAccountId) {
        throw new Error('MAX_PROVIDER_ACCOUNT_PROOF_MISMATCH')
    }
    return payload
}
