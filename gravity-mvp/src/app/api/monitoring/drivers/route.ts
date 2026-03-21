import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import {
    DRIVERS_PAGE_LIMIT_DEFAULT,
    DRIVERS_PAGE_LIMIT_MAX,
    RECENT_EVENTS_MAX,
    RECENT_EVENTS_DAYS,
    SCRAPER_BASE_URL,
    SCRAPER_STATS_CACHE_TTL_MS,
} from '@/app/monitoring/lib/constants';

// In-memory cache for scraper stats (graceful degradation)
let scraperStatsCache: { data: any; timestamp: number } | null = null;

async function getScraperStats() {
    // Return cache if fresh
    if (scraperStatsCache && Date.now() - scraperStatsCache.timestamp < SCRAPER_STATS_CACHE_TTL_MS) {
        return scraperStatsCache.data;
    }

    try {
        const res = await fetch(`${SCRAPER_BASE_URL}/admin/stats`, {
            signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) throw new Error(`Scraper ${res.status}`);
        const data = await res.json();
        scraperStatsCache = { data, timestamp: Date.now() };
        return data;
    } catch (err) {
        console.warn('[monitoring/drivers] Scraper unavailable:', (err as Error).message);
        // Return cached data if available, otherwise null
        return scraperStatsCache?.data || null;
    }
}

export async function GET(req: NextRequest) {
    const { searchParams } = new URL(req.url);

    const page = Math.max(1, parseInt(searchParams.get('page') || '1'));
    const rawLimit = parseInt(searchParams.get('limit') || String(DRIVERS_PAGE_LIMIT_DEFAULT));
    const limit = Math.min(Math.max(1, rawLimit), DRIVERS_PAGE_LIMIT_MAX);
    const search = searchParams.get('search') || undefined;
    const sort = searchParams.get('sort') || 'fullName';
    const order = searchParams.get('order') === 'desc' ? 'desc' : 'asc';

    const skip = (page - 1) * limit;

    // Build where clause
    const where = search
        ? { fullName: { contains: search, mode: 'insensitive' as const } }
        : {};

    // Build orderBy
    const orderBy = { [sort]: order };

    const [drivers, total] = await Promise.all([
        prisma.driver.findMany({
            where,
            orderBy,
            skip,
            take: limit,
            include: {
                events: {
                    where: {
                        createdAt: { gte: new Date(Date.now() - RECENT_EVENTS_DAYS * 86400000) },
                    },
                    orderBy: { createdAt: 'desc' },
                    take: 20, // fetch more than needed to deduplicate types
                    select: { eventType: true },
                },
            },
        }),
        prisma.driver.count({ where }),
    ]);

    // Get scraper stats with graceful degradation
    const scraperStats = await getScraperStats();

    const activeDrivers = total;

    // Scraper /admin/stats returns BullMQ queue counts: {wait, active, completed, failed, delayed}
    // Map to our UI: completed = checks done, wait+active = pending, configurable daily limit
    const dailyLimit = parseInt(process.env.FLEET_DAILY_LIMIT || '30');
    const checksUsedToday = scraperStats?.completed ?? null;
    const checksLimitToday = dailyLimit;
    const checksLimitReached = checksUsedToday !== null ? checksUsedToday >= checksLimitToday : false;

    // Map drivers with recentEvents (unique types, max 3)
    const driversResponse = drivers.map((d) => {
        const uniqueTypes = [...new Set(d.events.map((e) => e.eventType))].slice(0, RECENT_EVENTS_MAX);
        return {
            id: d.id,
            yandexDriverId: d.yandexDriverId,
            fullName: d.fullName,
            phone: d.phone,
            licenseNumber: d.licenseNumber,
            lastFleetCheckAt: d.lastFleetCheckAt?.toISOString() || null,
            lastExternalPark: d.lastExternalPark,
            lastFleetCheckStatus: d.lastFleetCheckStatus,
            lastFleetCheckId: d.lastFleetCheckId,
            recentEvents: uniqueTypes,
        };
    });

    return NextResponse.json({
        drivers: driversResponse,
        total,
        stats: {
            activeDrivers,
            checksUsedToday,
            checksLimitToday,
            checksLimitReached,
        },
    });
}
