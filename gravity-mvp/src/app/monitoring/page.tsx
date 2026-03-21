import { prisma } from '@/lib/prisma';
import { MonitoringClient } from './MonitoringClient';
import { RECENT_EVENTS_MAX, RECENT_EVENTS_DAYS, SCRAPER_BASE_URL } from './lib/constants';
import type { MonitoringDriver, MonitoringStats, AttentionItem } from './lib/types';
import type { EventType } from './lib/constants';

// Fetch scraper stats with graceful degradation
async function getScraperStats(): Promise<{ checksUsedToday: number | null; checksLimitToday: number }> {
    const dailyLimit = parseInt(process.env.FLEET_DAILY_LIMIT || '30');
    try {
        const res = await fetch(`${SCRAPER_BASE_URL}/admin/stats`, {
            signal: AbortSignal.timeout(5000),
            cache: 'no-store',
        });
        if (!res.ok) throw new Error(`Scraper ${res.status}`);
        const data = await res.json();
        // Scraper returns BullMQ counts: {wait, active, completed, failed, delayed}
        return {
            checksUsedToday: data.completed ?? null,
            checksLimitToday: dailyLimit,
        };
    } catch {
        return { checksUsedToday: null, checksLimitToday: dailyLimit };
    }
}

export default async function MonitoringPage() {
    // SSR: read directly from Prisma
    const [driversRaw, total, attentionRaw, attentionTotal, scraperStats] = await Promise.all([
        prisma.driver.findMany({
            orderBy: { fullName: 'asc' },
            take: 20,
            include: {
                events: {
                    where: {
                        createdAt: { gte: new Date(Date.now() - RECENT_EVENTS_DAYS * 86400000) },
                    },
                    orderBy: { createdAt: 'desc' },
                    take: 20,
                    select: { eventType: true },
                },
            },
        }),
        prisma.driver.count(),
        prisma.driverAttention.findMany({
            where: { status: 'open' },
            orderBy: { createdAt: 'desc' },
            take: 20,
            include: {
                driver: {
                    select: { id: true, fullName: true, phone: true, lastExternalPark: true, licenseNumber: true },
                },
            },
        }),
        prisma.driverAttention.count({ where: { status: 'open' } }),
        getScraperStats(),
    ]);

    // Map to MonitoringDriver
    const drivers: MonitoringDriver[] = driversRaw.map((d) => {
        const uniqueTypes = [...new Set(d.events.map((e) => e.eventType))].slice(0, RECENT_EVENTS_MAX) as EventType[];
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

    // Map to AttentionItem
    const attention: AttentionItem[] = attentionRaw.map((a) => ({
        id: a.id,
        reason: a.reason,
        riskLevel: a.riskLevel as any,
        status: a.status,
        createdAt: a.createdAt.toISOString(),
        driver: a.driver,
    }));

    const stats: MonitoringStats = {
        activeDrivers: total,
        checksUsedToday: scraperStats.checksUsedToday,
        checksLimitToday: scraperStats.checksLimitToday,
        checksLimitReached: scraperStats.checksUsedToday !== null
            ? scraperStats.checksUsedToday >= scraperStats.checksLimitToday
            : false,
    };

    return (
        <MonitoringClient
            initialDrivers={drivers}
            initialTotal={total}
            initialStats={stats}
            initialAttention={attention}
            initialAttentionTotal={attentionTotal}
        />
    );
}
