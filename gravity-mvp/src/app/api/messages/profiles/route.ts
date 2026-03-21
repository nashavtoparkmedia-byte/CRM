import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

export const dynamic = 'force-dynamic'

export async function GET() {
    try {
        const [waConnections, maxConnections] = await Promise.all([
            prisma.whatsAppConnection.findMany({
                where: { status: 'ready' },
                select: { id: true, name: true, phoneNumber: true }
            }),
            prisma.maxConnection.findMany({
                where: { isActive: true },
                select: { id: true, name: true }
            })
        ])

        // Robust fetch for Telegram and Bots via $queryRaw to avoid Client out-of-sync 500s
        const tgConnections: any[] = await prisma.$queryRaw`SELECT * FROM "TelegramConnection" WHERE "isActive" = true`
        const bots: any[] = await prisma.$queryRaw`SELECT * FROM "bots" WHERE "is_active" = true`

        function serialize(obj: any): any {
            return JSON.parse(JSON.stringify(obj, (key, value) =>
                typeof value === 'bigint' ? value.toString() : value
            ));
        }

        return NextResponse.json(serialize({
            whatsapp: waConnections.map(c => {
                const cleaned = (c.phoneNumber || '').replace(/\D/g, '')
                let formattedNum = c.phoneNumber || ''
                if (cleaned.length >= 11) {
                    formattedNum = `+${cleaned.substring(0,1)} (${cleaned.substring(1,4)}) ${cleaned.substring(4,7)}-${cleaned.substring(7,9)}-${cleaned.substring(9,11)}`
                } else if (cleaned) {
                    formattedNum = `+${cleaned}`
                }

                let displayName = c.name
                if (!displayName || displayName === 'WhatsApp Account') {
                    displayName = formattedNum || 'WhatsApp Account'
                } else if (formattedNum) {
                    displayName = `${displayName} (${formattedNum})`
                }
                
                return { id: c.id, name: displayName }
            }),
            telegram: [
                ...tgConnections.map(c => ({ id: c.id, name: c.name || c.phoneNumber || 'Telegram Account', type: 'user' })),
                ...bots.map((b: any) => ({ id: b.id, name: b.name || b.username || 'Telegram Bot', type: 'bot' }))
            ],
            max: [
                { id: 'scraper', name: 'Личный аккаунт (Скрейпер)', type: 'personal' },
                ...maxConnections.map(c => ({ id: c.id, name: c.name || 'MAX Bot', type: 'bot' }))
            ]
        }))
    } catch (error) {
        console.error('[API-PROFILES] GET Error:', error)
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
    }
}
