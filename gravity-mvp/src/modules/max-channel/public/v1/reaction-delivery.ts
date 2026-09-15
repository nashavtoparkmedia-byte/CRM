export type MaxReactionDeliveryResultV1 = {
    reactionConfirmed: boolean
    status?: string
}

export function isRealMaxMessageIdV1(value: unknown): value is string {
    return typeof value === 'string' && /^d301[0-9a-f]+$/i.test(value)
}

/** Send one exact MAX reaction operation and preserve provider confirmation truth. */
export async function sendMaxReactionDeliveryV1(
    input: {
        chatId: string
        messageId: string
        emoji: string
        remove: boolean
        providerAccountId: string
    },
    options: {
        endpoint?: string
        fetchImpl?: typeof fetch
    } = {},
): Promise<MaxReactionDeliveryResultV1> {
    if (!isRealMaxMessageIdV1(input.messageId)) {
        throw new Error('MAX reaction requires a real MAX message id, not a CRM or placeholder id')
    }

    const fetchImpl = options.fetchImpl ?? fetch
    const endpoint = options.endpoint ?? `${process.env.MAX_SCRAPER_URL || 'http://localhost:3005'}/send-reaction`
    const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
    })
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>
    if (!response.ok) throw new Error(String(payload.error || `MAX request failed: ${response.status}`))
    if (payload.providerAccountId !== input.providerAccountId) {
        throw new Error('MAX_PROVIDER_ACCOUNT_PROOF_MISMATCH')
    }
    return {
        reactionConfirmed: payload.reactionConfirmed === true,
        ...(typeof payload.status === 'string' ? { status: payload.status } : {}),
    }
}
