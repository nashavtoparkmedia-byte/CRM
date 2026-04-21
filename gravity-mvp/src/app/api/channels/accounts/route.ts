import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

export async function GET() {
    try {
        const [tgConnections, waConnections, maxConnections] = await Promise.all([
            prisma.telegramConnection.findMany({
                where: { isActive: true },
                select: { id: true, phoneNumber: true, name: true, isDefault: true }
            }),
            prisma.whatsAppConnection.findMany({
                where: { status: 'ready' },
                select: { id: true, phoneNumber: true, name: true }
            }),
            prisma.maxConnection.findMany({
                where: { isActive: true },
                select: { id: true, name: true, isDefault: true }
            })
        ])

        const accounts = {
            wa: waConnections.map(c => ({
                id: c.id,
                phone: c.phoneNumber || 'WhatsApp',
                label: c.name || 'WhatsApp Account',
                isDefault: true
            })),
            tg: tgConnections.map(c => {
                // If phone is missing but name looks like a phone, use name
                const resolvedPhone = c.phoneNumber || (c.name?.startsWith('+') || /^\d+$/.test(c.name || '') ? c.name : 'Telegram')
                return {
                    id: c.id,
                    phone: resolvedPhone,
                    label: c.name || `Account ${c.id.substring(0, 5)}`,
                    isDefault: c.isDefault
                }
            }),
            max: [
                { id: 'max_scraper', phone: process.env.MAX_SCRAPER_PHONE || 'MAX', label: 'MAX', isDefault: true },
                ...maxConnections.map(c => ({
                    id: c.id,
                    phone: 'Bot',
                    label: c.name || 'MAX Bot',
                    isDefault: c.isDefault
                }))
            ],
            ypro: [
                { id: 'ypro-1', phone: 'Fleet', label: 'Парк (Диспетчерская)', isDefault: true },
            ]
        }

        return NextResponse.json(accounts)
    } catch (error: any) {
        console.error('[API/CHANNELS/ACCOUNTS] Error:', error)
        return NextResponse.json({ error: error.message }, { status: 500 })
    }
}
