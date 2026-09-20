export type TelegramBotInlineButtonV1 = {
    text: string
    callback_data?: string
    url?: string
}

export type TelegramBotInlineKeyboardV1 = TelegramBotInlineButtonV1[][]

export type ExactTelegramBotDeliveryInputV1 = {
    providerAccountId: string | null
    connectionId: string | undefined
    peerId: string
    text: string
    inlineKeyboard?: TelegramBotInlineKeyboardV1
}

export type ExactTelegramBotDeliveryResultV1 = {
    providerAccountId: string | null
    connectionId: string
    messageId: string
}

function concreteId(value: unknown): string | null {
    if (typeof value !== 'string' || value !== value.trim() || !value) return null
    return value !== 'legacy' && value !== 'telegram-default' ? value : null
}

function exactPrivatePeer(value: unknown): string | null {
    const candidate = concreteId(value)
    return candidate && /^\d+$/.test(candidate) && candidate !== '0' ? candidate : null
}

function botServiceUrl(): string {
    const configured = concreteId(process.env.BOT_API_URL) || concreteId(process.env.TG_BOT_API_URL)
    if (!configured) throw new Error('TELEGRAM_BOT_TRANSPORT_URL_UNPROVEN')
    const base = configured.replace(/\/+$/, '')
    return base.endsWith('/api/bot') ? base : `${base}/api/bot`
}

function botServiceSecret(): string {
    const secret = concreteId(process.env.BOT_CRM_SECRET)
    if (!secret) throw new Error('TELEGRAM_BOT_TRANSPORT_AUTH_UNPROVEN')
    return secret
}

function assertKeyboard(value: TelegramBotInlineKeyboardV1 | undefined): void {
    if (value === undefined) return
    if (!Array.isArray(value) || value.length === 0) {
        throw new Error('TELEGRAM_INLINE_KEYBOARD_INVALID')
    }
    for (const row of value) {
        if (!Array.isArray(row) || row.length === 0) {
            throw new Error('TELEGRAM_INLINE_KEYBOARD_INVALID')
        }
        for (const button of row) {
            const keys = button && typeof button === 'object' && !Array.isArray(button)
                ? Object.keys(button)
                : []
            const actionCount = Number(typeof button?.callback_data === 'string' && Boolean(button.callback_data))
                + Number(typeof button?.url === 'string' && Boolean(button.url))
            if (
                !button
                || typeof button.text !== 'string'
                || !button.text.trim()
                || actionCount !== 1
                || keys.some((key) => !['text', 'callback_data', 'url'].includes(key))
            ) {
                throw new Error('TELEGRAM_INLINE_KEYBOARD_INVALID')
            }
        }
    }
}

/**
 * Delivers through the driver-bot process. The bot process re-attests both its
 * live Bot API account (`getMe`) and configured connection immediately before
 * mutating Telegram, then echoes that proof for this boundary to verify.
 */
export async function sendExactTelegramBotMessageV1(
    input: ExactTelegramBotDeliveryInputV1,
): Promise<ExactTelegramBotDeliveryResultV1> {
    const providerAccountId = concreteId(input.providerAccountId)
    const connectionId = concreteId(input.connectionId)
    const peerId = exactPrivatePeer(input.peerId)
    // No production Telegram conversation carries a provider-account stamp, so
    // demanding one here would reject every bot send while proving nothing. The
    // echo proof below still runs whenever we DID request a specific account.
    // See docs/design/provider-account-identity-v1.md.
    if (!connectionId) throw new Error('TELEGRAM_BOT_CONNECTION_UNPROVEN')
    if (!peerId) throw new Error('TELEGRAM_OUTBOUND_PEER_INVALID')
    if (typeof input.text !== 'string' || !input.text) throw new Error('TELEGRAM_MESSAGE_EMPTY')
    assertKeyboard(input.inlineKeyboard)

    const response = await fetch(`${botServiceUrl()}/send-message`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-bot-signature': botServiceSecret(),
        },
        body: JSON.stringify({
            chatId: peerId,
            text: input.text,
            ...(providerAccountId ? { providerAccountId } : {}),
            connectionId,
            ...(input.inlineKeyboard ? { inlineKeyboard: input.inlineKeyboard } : {}),
        }),
    })
    const raw: unknown = await response.json().catch(() => ({}))
    const payload = raw && typeof raw === 'object' && !Array.isArray(raw)
        ? raw as Record<string, unknown>
        : {}
    if (!response.ok || payload.success !== true) {
        const detail = typeof payload.error === 'string' && payload.error.trim()
            ? payload.error.trim()
            : `TELEGRAM_BOT_DELIVERY_FAILED:${response.status}`
        throw new Error(detail)
    }
    if (providerAccountId && payload.providerAccountId !== providerAccountId) {
        throw new Error('TELEGRAM_BOT_PROVIDER_ACCOUNT_PROOF_MISMATCH')
    }
    if (payload.connectionId !== connectionId) {
        throw new Error('TELEGRAM_BOT_CONNECTION_PROOF_MISMATCH')
    }
    const messageId = concreteId(payload.messageId)
    if (!messageId || !/^\d+$/.test(messageId) || messageId === '0') {
        throw new Error('TELEGRAM_BOT_DELIVERY_RESULT_UNPROVEN')
    }
    return { providerAccountId, connectionId, messageId }
}

/* ------------------------------------------------------------------------ */
/* Reading a file the bot received                                           */
/* ------------------------------------------------------------------------ */

/**
 * A driver sends the support screenshot to the bot, so only the bot account
 * can fetch it: a Telegram file id is meaningful to exactly one bot token, and
 * that token belongs to the bot process. The CRM therefore asks the same
 * authenticated bot service it already sends through, and never holds the
 * token itself.
 *
 * The answer is bounded on purpose. A manager screen renders a screenshot, so
 * anything that is not an image or a PDF is refused rather than proxied, and a
 * file larger than the cap is refused instead of buffered.
 */
export const TELEGRAM_BOT_FILE_MAX_BYTES_V1 = 8 * 1024 * 1024
export const TELEGRAM_BOT_FILE_CONTENT_TYPES_V1 = Object.freeze([
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/gif',
    'application/pdf',
])
const TELEGRAM_BOT_FILE_TIMEOUT_MS = 15_000
/** Telegram file ids are URL-safe base64; nothing else is forwarded. */
const TELEGRAM_FILE_ID = /^[A-Za-z0-9_-]{8,256}$/u

export type TelegramBotFileReadV1 =
    | { ok: true; contentType: string; bytes: Uint8Array }
    | { ok: false; reason: 'invalid_file_id' | 'not_found' | 'unsupported_media' | 'too_large' | 'unavailable' }

function botFileFailure(reason: Exclude<TelegramBotFileReadV1, { ok: true }>['reason']): TelegramBotFileReadV1 {
    return { ok: false, reason }
}

/**
 * Fetches one file the bot received, by its Telegram file id.
 *
 * Nothing about the transport reaches the caller: a failure is a reason code,
 * never a Telegram URL, a token or a provider body.
 */
export async function readTelegramBotFileV1(input: { fileId: string }): Promise<TelegramBotFileReadV1> {
    const fileId = typeof input?.fileId === 'string' ? input.fileId.trim() : ''
    if (!TELEGRAM_FILE_ID.test(fileId)) return botFileFailure('invalid_file_id')

    let response: Response
    try {
        response = await fetch(`${botServiceUrl()}/file`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-bot-signature': botServiceSecret(),
            },
            body: JSON.stringify({ fileId }),
            signal: AbortSignal.timeout(TELEGRAM_BOT_FILE_TIMEOUT_MS),
        })
    } catch {
        return botFileFailure('unavailable')
    }

    if (response.status === 404) return botFileFailure('not_found')
    if (response.status === 413) return botFileFailure('too_large')
    if (response.status === 415) return botFileFailure('unsupported_media')
    if (!response.ok) return botFileFailure('unavailable')

    const contentType = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
    if (!TELEGRAM_BOT_FILE_CONTENT_TYPES_V1.includes(contentType)) return botFileFailure('unsupported_media')
    const declaredLength = Number(response.headers.get('content-length') ?? '')
    if (Number.isFinite(declaredLength) && declaredLength > TELEGRAM_BOT_FILE_MAX_BYTES_V1) {
        return botFileFailure('too_large')
    }

    let bytes: Uint8Array
    try {
        bytes = new Uint8Array(await response.arrayBuffer())
    } catch {
        return botFileFailure('unavailable')
    }
    if (bytes.byteLength === 0) return botFileFailure('not_found')
    if (bytes.byteLength > TELEGRAM_BOT_FILE_MAX_BYTES_V1) return botFileFailure('too_large')
    return { ok: true, contentType, bytes }
}
