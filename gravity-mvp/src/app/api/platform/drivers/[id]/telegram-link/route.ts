import { NextRequest, NextResponse } from 'next/server'

import {
    getIntegrationAdminPrincipal,
    isExactSameOriginMutationRequest,
    isJsonMutationRequest,
} from '@/modules/identity-access/public/v1'
import {
    removeDriverTelegramLink,
    saveDriverTelegramLink,
} from '@/modules/platform-shell/internal/driver-telegram-link-orchestrator'

type RouteContext = { params: Promise<{ id: string }> }

export const isSameOriginMutationRequest = isExactSameOriginMutationRequest

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
    if (!await getIntegrationAdminPrincipal()) return forbidden()
    if (!isJsonMutationRequest(req)) {
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
    if (!await getIntegrationAdminPrincipal()) return forbidden()
    const { id } = await params
    return NextResponse.json(await removeDriverTelegramLink(id))
}
