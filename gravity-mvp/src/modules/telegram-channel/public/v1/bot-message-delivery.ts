export type TelegramBotInlineButtonV1 = {
    text: string
    callback_data?: string
    url?: string
}

export type TelegramBotInlineKeyboardV1 = TelegramBotInlineButtonV1[][]

export type ExactTelegramBotDeliveryInputV1 = {
    providerAccountId: string
    connectionId: string
    peerId: string
    text: string
    inlineKeyboard?: TelegramBotInlineKeyboardV1
}

export type ExactTelegramBotDeliveryResultV1 = {
    providerAccountId: string
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
    if (!providerAccountId) throw new Error('TELEGRAM_BOT_PROVIDER_ACCOUNT_UNPROVEN')
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
            providerAccountId,
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
    if (payload.providerAccountId !== providerAccountId) {
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
