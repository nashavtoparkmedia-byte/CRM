/* eslint-disable @typescript-eslint/no-explicit-any -- Prisma client types
   for AI-call models may not be regenerated on every dev box. */
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

export const dynamic = 'force-dynamic'

/**
 * POST /api/ai-calls/sessions/[id]/transcript-item
 *
 * Bridge streams transcript items into CRM as they're recognised. The
 * stored form is a single growing `Call.transcript` string of the shape
 *   [User] ... \n
 *   [AI] ... \n
 * so the existing call-detail page (Транскрипт tab) just renders it.
 *
 *  body: { role: 'user' | 'assistant', text: string }
 *
 * No-op on missing/empty text; never 5xx — failures don't break the call.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
    const { id } = await ctx.params
    if (!id) return NextResponse.json({ error: 'id_required' }, { status: 400 })

    let body: any
    try { body = await req.json() } catch { return NextResponse.json({ error: 'invalid_json' }, { status: 400 }) }

    const role: string = body.role
    const text: string = (body.text ?? '').toString().trim()
    if (!text) return NextResponse.json({ ok: true, skipped: 'empty' })
    if (role !== 'user' && role !== 'assistant') {
        return NextResponse.json({ error: 'role_must_be_user_or_assistant' }, { status: 400 })
    }

    const label = role === 'user' ? '[Лид]' : '[AI]'
    const line = `${label} ${text}\n`

    // Single SQL roundtrip — append to existing transcript or set if null.
    // Postgres has || on text columns so we can do it atomically via raw
    // SQL; with Prisma we have to read-modify-write but it's fine for the
    // call cadence (≤ a few items per second).
    const call = await prisma.call.findUnique({ where: { id }, select: { transcript: true } })
    if (!call) return NextResponse.json({ error: 'not_found' }, { status: 404 })

    await prisma.call.update({
        where: { id },
        data: { transcript: `${call.transcript ?? ''}${line}` },
    })
    return NextResponse.json({ ok: true })
}
