import type { NextRequest } from 'next/server'

function firstForwardedValue(value: string | null): string | null {
    return value?.split(',')[0]?.trim() || null
}

export function isSameOriginAiCallCampaignMutation(req: NextRequest): boolean {
    const origin = req.headers.get('origin')
    const host = req.headers.get('host')?.trim() || null
    const forwardedHost = firstForwardedValue(req.headers.get('x-forwarded-host'))
    const forwardedProtocol = firstForwardedValue(req.headers.get('x-forwarded-proto'))?.toLowerCase()
    const protocol = forwardedProtocol || req.nextUrl.protocol.slice(0, -1).toLowerCase()
    if (!origin || !host) return false
    if (forwardedHost && forwardedHost.toLowerCase() !== host.toLowerCase()) return false
    if (protocol !== 'http' && protocol !== 'https') return false
    try {
        const parsedOrigin = new URL(origin)
        return parsedOrigin.protocol === `${protocol}:`
            && parsedOrigin.host.toLowerCase() === host.toLowerCase()
    } catch {
        return false
    }
}

export function isJsonAiCallCampaignMutation(req: NextRequest): boolean {
    return req.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() === 'application/json'
}
