import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

export async function GET(request: Request) {
    const { searchParams } = new URL(request.url)
    const query = searchParams.get('q')

    if (!query || query.length < 2) {
        return NextResponse.json([])
    }

    try {
        const drivers = await prisma.driver.findMany({
            where: {
                OR: [
                    { fullName: { contains: query, mode: 'insensitive' } },
                    { phone: { contains: query } }
                ]
            },
            select: {
                id: true,
                fullName: true,
                phone: true,
                segment: true
            },
            take: 10
        })

        // Check if query looks like a phone number (at least 7 digits)
        const digitsOnly = query.replace(/\D/g, '')
        if (digitsOnly.length >= 7) {
            // Check if exact match already exists in results
            const exactMatch = drivers.find(d => d.phone && d.phone.replace(/\D/g, '') === digitsOnly)
            
            if (!exactMatch) {
                // Determine a safe ID for this "dummy" driver to be processed by start-chat
                // We'll use the raw digits prefixed with unsaved_ so start-chat can handle it
                drivers.push({
                    id: `unsaved_${digitsOnly}`,
                    fullName: 'Неизвестный номер',
                    phone: query,
                    segment: 'Новый контакт'
                })
            }
        }

        return NextResponse.json(drivers)
    } catch (error) {
        console.error('[API-DRIVERS-SEARCH] GET Error:', error)
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
    }
}
