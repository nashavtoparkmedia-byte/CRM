import { NextRequest, NextResponse } from 'next/server'

import {
    removeDriverTelegramLink,
    saveDriverTelegramLink,
} from '@/modules/platform-shell/internal/driver-telegram-link-orchestrator'

type RouteContext = { params: Promise<{ id: string }> }

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

function bodyRecord(value: unknown): Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {}
}

export async function POST(req: NextRequest, { params }: RouteContext) {
    if (!isSameOriginMutationRequest(req)) return forbidden()
    if (req.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
        return unsupportedMediaType()
    }
    const { id } = await params
    const body = bodyRecord(await req.json())
    const result = await saveDriverTelegramLink({
        driverId: id,
        telegramId: body.telegramId,
        ...(typeof body.driverName === 'string' ? { driverName: body.driverName } : {}),
    })
    return NextResponse.json(result)
}

export async function DELETE(req: NextRequest, { params }: RouteContext) {
    if (!isSameOriginMutationRequest(req)) return forbidden()
    const { id } = await params
    return NextResponse.json(await removeDriverTelegramLink(id))
}
