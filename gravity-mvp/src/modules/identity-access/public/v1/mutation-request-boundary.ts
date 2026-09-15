type MutationRequestEvidence = {
    headers: { get(name: string): string | null }
    nextUrl: { protocol: string }
}

function firstForwardedValue(value: string | null): string | null {
    return value?.split(',')[0]?.trim() || null
}

/**
 * Require a browser mutation to prove the exact externally visible origin.
 * Missing or ambiguous Origin evidence fails closed. When a trusted proxy
 * supplies forwarding metadata, it must agree with Host as well.
 */
export function isExactSameOriginMutationRequest(request: MutationRequestEvidence): boolean {
    const origin = request.headers.get('origin')
    const host = request.headers.get('host')?.trim() || null
    const forwardedHost = firstForwardedValue(request.headers.get('x-forwarded-host'))
    const forwardedProtocol = firstForwardedValue(request.headers.get('x-forwarded-proto'))
        ?.toLowerCase()
    const protocol = forwardedProtocol || request.nextUrl.protocol.slice(0, -1).toLowerCase()

    if (!origin || !host) return false
    if (forwardedHost && forwardedHost.toLowerCase() !== host.toLowerCase()) return false
    if (protocol !== 'http' && protocol !== 'https') return false

    try {
        const parsedOrigin = new URL(origin)
        return parsedOrigin.origin.toLowerCase() === origin.toLowerCase()
            && parsedOrigin.protocol === `${protocol}:`
            && parsedOrigin.host.toLowerCase() === host.toLowerCase()
    } catch {
        return false
    }
}

export function isJsonMutationRequest(request: MutationRequestEvidence): boolean {
    return request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
        === 'application/json'
}
