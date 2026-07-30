import { createHash, createHmac, randomUUID } from 'node:crypto'

const COMMAND_NAMESPACE = 'personal-max-command-v1'
const REAL_MAX_MESSAGE_ID = /^d301[0-9a-f]{14}$/i

function binding() {
    const baseUrl = process.env.MAX_PERSONAL_GATEWAY_URL || ''
    const accountId = process.env.MAX_PERSONAL_ACCOUNT_ID || ''
    const secret = process.env.MAX_PERSONAL_TEXT_COMMAND_HMAC_SECRET || ''
    const base = new URL(baseUrl)
    const privateTarget = base.hostname === 'max-personal-gateway'
      ? base.port === '8080'
      : ['127.0.0.1', 'localhost'].includes(base.hostname) && base.port !== ''
    if (base.protocol !== 'http:' || !privateTarget || base.username || base.password || base.search || base.hash
        || !['', '/'].includes(base.pathname)
        || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(accountId) || Buffer.byteLength(secret) < 32) {
        throw new Error('Personal MAX durable sender binding is invalid')
    }
    const url = new URL('/v1/personal-max/commands/text', base)
    return { url, accountId, secret: Buffer.from(secret) }
}

export async function sendPersonalMaxDurableText(input: {
    protocolChatId: string
    text: string
    clientMessageId?: string
}) {
    const { url, accountId, secret } = binding()
    if (!/^\d{5,15}$/.test(input.protocolChatId) || !input.text || Buffer.byteLength(input.text, 'utf8') > 65_536) {
        throw new Error('Personal MAX durable text command is invalid')
    }
    const body = JSON.stringify({
        schemaVersion: 1,
        accountId,
        protocolChatId: input.protocolChatId,
        text: input.text,
        clientMessageId: input.clientMessageId || randomUUID(),
    })
    const timestamp = new Date().toISOString()
    const nonce = randomUUID()
    const bodyHash = createHash('sha256').update(body).digest('hex')
    const signature = createHmac('sha256', secret)
        .update(`${COMMAND_NAMESPACE}\nPOST\n/v1/personal-max/commands/text\n${timestamp}\n${nonce}\n${bodyHash}`)
        .digest('hex')
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            'x-max-command-timestamp': timestamp,
            'x-max-command-nonce': nonce,
            'x-max-command-signature': signature,
        },
        body,
        redirect: 'error',
        signal: AbortSignal.timeout(45_000),
    })
    const result = await response.json().catch(() => ({})) as Record<string, unknown>
    if (!response.ok && response.status !== 202) {
        const code = typeof result.code === 'string' ? result.code : 'DURABLE_TEXT_SEND_FAILED'
        throw new Error(`Personal MAX durable sender refused: ${code}`)
    }
    const confirmedStatus = result.deliveryStatus === 'provider_confirmed'
        || result.deliveryStatus === 'accepted_by_max'
    const exactProviderConfirmation = result.deliveryConfirmed === true
        && typeof result.externalId === 'string'
        && REAL_MAX_MESSAGE_ID.test(result.externalId)
    if (typeof result.success !== 'boolean'
        || typeof result.deliveryConfirmed !== 'boolean'
        || typeof result.deliveryStatus !== 'string'
        || !['provider_confirmed', 'accepted_by_max', 'needs_review', 'queued', 'sending', 'retryable_failed', 'hard_failed', 'dead_letter'].includes(result.deliveryStatus)
        || (confirmedStatus !== exactProviderConfirmation)
        || typeof result.chatId !== 'string' || result.chatId !== input.protocolChatId
        || (result.deliveryStatus !== 'queued' && (typeof result.dispatchId !== 'string' || result.dispatchId.length < 1))
        || (result.deliveryStatus === 'queued'
            && result.dispatchId !== null
            && (typeof result.dispatchId !== 'string' || result.dispatchId.length < 1))) {
        throw new Error('Personal MAX durable sender returned an invalid response')
    }
    return result
}
