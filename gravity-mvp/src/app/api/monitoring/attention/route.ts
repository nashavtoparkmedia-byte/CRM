import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { ATTENTION_LIMIT_DEFAULT } from '@/app/monitoring/lib/constants';

export async function GET(req: NextRequest) {
    const { searchParams } = new URL(req.url);
    const limit = Math.min(Math.max(1, parseInt(searchParams.get('limit') || String(ATTENTION_LIMIT_DEFAULT))), 100);

    const [items, total] = await Promise.all([
        prisma.driverAttention.findMany({
            where: { status: 'open' },
            orderBy: { createdAt: 'desc' },
            take: limit,
            include: {
                driver: {
                    select: {
                        id: true,
                        fullName: true,
                        phone: true,
                        lastExternalPark: true,
                        licenseNumber: true,
                    },
                },
            },
        }),
        prisma.driverAttention.count({ where: { status: 'open' } }),
    ]);

    return NextResponse.json({
        items: items.map((item) => ({
            id: item.id,
            reason: item.reason,
            riskLevel: item.riskLevel,
            status: item.status,
            createdAt: item.createdAt.toISOString(),
            driver: item.driver,
        })),
        total,
    });
}
