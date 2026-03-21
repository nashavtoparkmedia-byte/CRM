import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

// In-memory mutex to prevent parallel sync runs
let syncRunning = false;

/**
 * Normalize phone to E.164 format: +79991234567
 * Handles common Russian formats: 89991234567, +7(999)123-45-67, etc.
 */
function normalizePhone(phone: string | null | undefined): string | null {
    if (!phone) return null;
    // Strip everything except digits and leading +
    const cleaned = phone.replace(/[^\d+]/g, '');
    if (!cleaned) return null;

    // If starts with 8 and is 11 digits (Russian mobile)
    if (cleaned.startsWith('8') && cleaned.length === 11) {
        return '+7' + cleaned.slice(1);
    }
    // If starts with 7 and is 11 digits
    if (cleaned.startsWith('7') && cleaned.length === 11) {
        return '+' + cleaned;
    }
    // If already has + prefix
    if (cleaned.startsWith('+')) {
        return cleaned;
    }
    // If 10 digits (without country code)
    if (cleaned.length === 10) {
        return '+7' + cleaned;
    }
    return cleaned; // return as-is if can't normalize
}

export async function POST(req: NextRequest) {
    // Auth: validate X-CRON-KEY
    const cronKey = req.headers.get('x-cron-key');
    const expectedKey = process.env.CRON_SECRET;
    if (expectedKey && cronKey !== expectedKey) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Mutex: prevent parallel runs
    if (syncRunning) {
        return NextResponse.json({ error: 'Sync already running' }, { status: 409 });
    }

    syncRunning = true;
    try {
        // Get API connection
        const connection = await prisma.apiConnection.findFirst({
            orderBy: { createdAt: 'desc' },
        });

        if (!connection) {
            return NextResponse.json({ error: 'No API connection configured' }, { status: 500 });
        }

        const PAGE_SIZE = 500;
        let offset = 0;
        let totalFetched = 0;
        let upsertedCount = 0;

        while (true) {
            const res = await fetch(`https://fleet-api.taxi.yandex.net/v1/parks/driver-profiles/list`, {
                method: 'POST',
                cache: 'no-store',
                headers: {
                    'X-Client-ID': connection.clid,
                    'X-Api-Key': connection.apiKey,
                    'X-Park-Id': connection.parkId,
                    'Accept-Language': 'ru',
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    query: { park: { id: connection.parkId } },
                    limit: PAGE_SIZE,
                    offset: offset,
                }),
            });

            if (!res.ok) {
                const errText = await res.text();
                throw new Error(`Yandex API error (${res.status}): ${errText}`);
            }

            const data = await res.json() as any;
            const profiles = data.driver_profiles || [];
            const totalInApi = data.total || 0;

            if (profiles.length === 0) break;

            for (const p of profiles) {
                const dp = p.driver_profile || {};
                const id = dp.id;
                if (!id) continue;

                // Activity mapping: prioritize last_order_at -> last_ride_at
                // EXCLUDE last_transaction_date/accounts because it reflects balance changes without trips
                const lastOrderAtRaw = dp.last_order_at || p.last_order_at || p.last_ride_at;
                const lastOrderAt = lastOrderAtRaw ? new Date(lastOrderAtRaw) : null;

                const phone = normalizePhone(dp.phones?.[0]);

                await prisma.driver.upsert({
                    where: { yandexDriverId: id },
                    create: {
                        yandexDriverId: id,
                        fullName: `${dp.last_name || ''} ${dp.first_name || ''}`.trim() || 'No Name',
                        phone,
                        lastOrderAt,
                        segment: 'unknown',
                    },
                    update: {
                        fullName: `${dp.last_name || ''} ${dp.first_name || ''}`.trim() || 'No Name',
                        phone,
                        lastOrderAt,
                    },
                });
                upsertedCount++;
            }

            totalFetched += profiles.length;
            offset += PAGE_SIZE;

            if (totalFetched >= totalInApi) break;
        }

        return NextResponse.json({
            ok: true,
            totalFetched,
            upsertedCount,
        });
    } catch (err: any) {
        console.error('[sync] Fatal Error:', err.message);
        return NextResponse.json({ error: err.message }, { status: 500 });
    } finally {
        syncRunning = false;
    }
}
