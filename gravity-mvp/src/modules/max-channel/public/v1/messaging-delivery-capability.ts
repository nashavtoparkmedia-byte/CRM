import { sendMaxMessage } from '@/app/max-actions'
import {
    registerMaxChannelDeliveryV1,
    type MaxChannelDeliveryV1,
} from '@/modules/messaging/public/v1/channel-delivery-runtime'

const scraperUrl = () => process.env.MAX_SCRAPER_URL || 'http://localhost:3005'

async function post(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const response = await fetch(`${scraperUrl()}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(String(payload.error || `MAX request failed: ${response.status}`))
    return payload
}

const capability: MaxChannelDeliveryV1 = {
    async sendText(input) {
        return sendMaxMessage(input.target, input.content, input.options)
    },
    async sendMedia(input) {
        const payload = await post('/send-media', input)
        return { externalId: typeof payload.externalId === 'string' ? payload.externalId : undefined }
    },
    async sendReaction(input) {
        await post('/send-reaction', input)
    },
}

export function registerMaxMessagingDeliveryCapabilityV1(): void {
    registerMaxChannelDeliveryV1(capability)
}
