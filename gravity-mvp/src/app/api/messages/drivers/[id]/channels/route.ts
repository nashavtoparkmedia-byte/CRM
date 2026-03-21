import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

export async function GET(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id: driverId } = await params

    try {
        const driver = await prisma.driver.findUnique({
            where: { id: driverId },
            include: {
                chats: {
                    select: {
                        channel: true,
                        externalChatId: true
                    }
                }
            }
        })

        if (!driver) {
            return NextResponse.json({ error: 'Driver not found' }, { status: 404 })
        }

        // Check for other potential channel identifications
        // For Telegram: Check DriverTelegram model using raw SQL for robustness
        const tgConnections: any[] = await prisma.$queryRaw`SELECT * FROM "DriverTelegram" WHERE "driverId" = ${driverId} LIMIT 1`
        const tgConnection = tgConnections[0] || null

        const channels = [
            { 
                type: 'whatsapp', 
                available: !!driver.phone, 
                existingChatId: driver.chats.find(c => c.channel === 'whatsapp')?.externalChatId 
            },
            { 
                type: 'telegram', 
                available: !!tgConnection || !!driver.phone, 
                existingChatId: driver.chats.find(c => c.channel === 'telegram')?.externalChatId 
            },
            { 
                type: 'max', 
                available: !!driver.phone, // Assuming MAX can be reached via phone
                existingChatId: driver.chats.find(c => c.channel === 'max')?.externalChatId 
            },
            {
                type: 'yandex_pro',
                available: !!driver.yandexDriverId,
                existingChatId: driver.chats.find(c => c.channel === 'yandex_pro')?.externalChatId
            }
        ]

        function serialize(obj: any): any {
            return JSON.parse(JSON.stringify(obj, (key, value) =>
                typeof value === 'bigint' ? value.toString() : value
            ));
        }

        return NextResponse.json(serialize({
            driverId: driver.id,
            fullName: driver.fullName,
            phone: driver.phone,
            channels
        }))
    } catch (error) {
        console.error('[API-DRIVER-CHANNELS] GET Error:', error)
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
    }
}
