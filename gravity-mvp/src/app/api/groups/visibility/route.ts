import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { cookies } from 'next/headers'

/**
 * GET /api/groups/visibility
 * Returns hidden group chat IDs for the current user.
 */
export async function GET() {
    try {
        const cookieStore = await cookies()
        const userId = cookieStore.get('crm_user_id')?.value
        if (!userId) {
            return NextResponse.json({ hiddenChatIds: [] })
        }

        const rows = await (prisma.groupVisibility as any).findMany({
            where: { userId, visibility: 'hidden' },
            select: { chatId: true }
        })

        return NextResponse.json({
            hiddenChatIds: rows.map((r: any) => r.chatId)
        })
    } catch (err: any) {
        console.error('[GROUP-VISIBILITY] GET error:', err.message)
        return NextResponse.json({ hiddenChatIds: [] })
    }
}

/**
 * POST /api/groups/visibility
 * Body: { chatId: string, visibility: 'hidden' | 'visible' }
 * Upserts GroupVisibility for current user + chatId.
 */
export async function POST(req: NextRequest) {
    try {
        const cookieStore = await cookies()
        const userId = cookieStore.get('crm_user_id')?.value
        if (!userId) {
            return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
        }

        const { chatId, visibility } = await req.json()
        if (!chatId || !['hidden', 'visible'].includes(visibility)) {
            return NextResponse.json({ error: 'Invalid body: { chatId, visibility: "hidden"|"visible" }' }, { status: 400 })
        }

        await (prisma.groupVisibility as any).upsert({
            where: {
                userId_chatId: { userId, chatId }
            },
            update: { visibility },
            create: { userId, chatId, visibility }
        })

        return NextResponse.json({ success: true })
    } catch (err: any) {
        console.error('[GROUP-VISIBILITY] POST error:', err.message)
        return NextResponse.json({ error: err.message }, { status: 500 })
    }
}
