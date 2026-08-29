import { NextRequest, NextResponse } from 'next/server'

import { recordManagerDriverCommunication } from '@/modules/platform-shell/internal/manager-driver-communication-orchestrator'

type RouteContext = { params: Promise<{ id: string }> }
type ManagerCommunicationActivity = 'call' | 'message'

function firstForwardedValue(value: string | null): string | null {
    return value?.split(',')[0]?.trim() || null
}

export function isSameOriginMutationRequest(req: NextRequest): boolean {
    const origin = req.headers.get('origin')
    const host = req.headers.get('host')?.trim() || null
    const forwardedHost = firstForwardedValue(req.headers.get('x-forwarded-host'))
    const forwardedProtocol = firstForwardedValue(req.headers.get('x-forwarded-proto'))
        ?.toLowerCase()
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

function forbidden() {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
}

function unsupportedMediaType() {
    return NextResponse.json(
        { success: false, error: 'Unsupported Media Type' },
        { status: 415 },
    )
}

function badRequest() {
    return NextResponse.json({ success: false, error: 'Bad Request' }, { status: 400 })
}

function parseActivity(value: unknown): ManagerCommunicationActivity | null {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
    const body = value as Record<string, unknown>
    if (Object.keys(body).length !== 1 || !Object.hasOwn(body, 'activity')) return null
    return body.activity === 'call' || body.activity === 'message' ? body.activity : null
}

export async function POST(req: NextRequest, { params }: RouteContext) {
    if (!isSameOriginMutationRequest(req)) return forbidden()
    if (req.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
        return unsupportedMediaType()
    }

    let body: unknown
    try {
        body = await req.json()
    } catch {
        return badRequest()
    }
    const activity = parseActivity(body)
    if (!activity) return badRequest()

    const { id } = await params
    await recordManagerDriverCommunication(id, activity)
    return NextResponse.json({ success: true })
}
