import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { destroyClient } from '@/lib/whatsapp/WhatsAppService'
import { revalidatePath } from 'next/cache'

export async function POST(req: Request) {
    try {
        const { id } = await req.json()
        if (!id) return NextResponse.json({ error: 'Missing ID' }, { status: 400 })

        console.log(`[API-WA] Deleting connection: ${id}`)

        // 1. Destroy client
        try {
            await destroyClient(id).catch(err => console.error(`[API-WA] destroyClient error for ${id}:`, err))
        } catch (err) {}

        // 2. Delete from DB (manual cascade to be safe)
        try {
            await prisma.whatsAppMessage.deleteMany({ where: { chat: { connectionId: id } } }).catch(() => {})
            await prisma.whatsAppChat.deleteMany({ where: { connectionId: id } }).catch(() => {})
            await prisma.whatsAppConnection.delete({ where: { id } })
            console.log(`[API-WA] Deleted connection ${id} from DB`)
        } catch (err) {
            console.error(`[API-WA] DB Delete error for ${id}:`, err)
            // Last attempt
            await prisma.whatsAppConnection.delete({ where: { id } }).catch(() => {})
        }

        revalidatePath('/whatsapp')
        return NextResponse.json({ success: true })
    } catch (err: any) {
        console.error(`[API-WA] Global error:`, err)
        return NextResponse.json({ error: String(err) }, { status: 500 })
    }
}
