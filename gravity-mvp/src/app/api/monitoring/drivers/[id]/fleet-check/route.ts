import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { SCRAPER_BASE_URL } from '@/app/monitoring/lib/constants';

export async function POST(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;
    const body = await req.json();

    // Step 1: Validate licenseNumber
    const licenseFromBody = body.licenseNumber?.trim() || null;

    // Use transaction with row lock to prevent double-click burning quota
    const result = await prisma.$transaction(async (tx) => {
        // Lock the driver row
        const drivers = await tx.$queryRaw<Array<{
            id: string;
            licenseNumber: string | null;
            lastFleetCheckStatus: string | null;
            lastFleetCheckId: string | null;
        }>>`SELECT id, "licenseNumber", "lastFleetCheckStatus", "lastFleetCheckId" FROM "Driver" WHERE id = ${id} FOR UPDATE`;

        if (drivers.length === 0) {
            return { error: 'Driver not found', status: 404 };
        }

        const driver = drivers[0];
        const licenseNumber = licenseFromBody || driver.licenseNumber;

        if (!licenseNumber) {
            return { error: 'licenseNumber is required', status: 400 };
        }

        // Step 2: Save licenseNumber if provided in body
        if (licenseFromBody && licenseFromBody !== driver.licenseNumber) {
            await tx.driver.update({
                where: { id },
                data: { licenseNumber: licenseFromBody },
            });
        }

        // Step 3: Idempotency — verify via scraper API if the existing check is still active
        if (driver.lastFleetCheckStatus === 'queued' && driver.lastFleetCheckId) {
            try {
                const statusRes = await fetch(
                    `${SCRAPER_BASE_URL}/api/checks/${driver.lastFleetCheckId}`,
                    { signal: AbortSignal.timeout(3000) }
                );
                if (statusRes.ok) {
                    const checkData = await statusRes.json();
                    if (checkData.status === 'QUEUED' || checkData.status === 'RUNNING') {
                        return { checkId: driver.lastFleetCheckId, status: 'QUEUED', idempotent: true };
                    }
                    // FAILED/SUCCESS → fall through to create new check
                }
            } catch {
                // Scraper unavailable → allow new check
            }
        }

        // Step 4: Check quota (get from scraper)
        let quotaExceeded = false;
        try {
            const statsRes = await fetch(`${SCRAPER_BASE_URL}/admin/stats`, {
                signal: AbortSignal.timeout(5000),
            });
            if (statsRes.ok) {
                const stats = await statsRes.json();
                quotaExceeded = stats.checksUsedToday >= stats.checksLimitToday;
            }
        } catch {
            // If scraper unavailable, allow the check (graceful)
        }

        if (quotaExceeded) {
            return { error: 'FLEET_DAILY_QUOTA_EXCEEDED', status: 429 };
        }

        // Step 5: Create new check (status is completed/failed/null → new check allowed)
        // Call scraper
        let checkId: string;
        try {
            const scraperRes = await fetch(`${SCRAPER_BASE_URL}/api/checks`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    license: licenseNumber,
                    crmDriverId: id,
                }),
                signal: AbortSignal.timeout(10000),
            });

            if (!scraperRes.ok) {
                const errText = await scraperRes.text();
                return { error: `Scraper error: ${errText}`, status: 502 };
            }

            const scraperData = await scraperRes.json();
            checkId = scraperData.checkId || scraperData.id;
        } catch (err) {
            return { error: `Scraper unavailable: ${(err as Error).message}`, status: 502 };
        }

        // Update driver with check status
        await tx.driver.update({
            where: { id },
            data: {
                lastFleetCheckStatus: 'queued',
                lastFleetCheckId: checkId,
            },
        });

        // Create event
        await tx.driverEvent.create({
            data: {
                driverId: id,
                eventType: 'fleet_check_requested',
                payload: { checkId, licenseNumber },
                createdBy: body.createdBy || null,
            },
        });

        return { checkId, status: 'QUEUED' };
    });

    // Handle transaction results
    if ('error' in result) {
        const statusCode = (result.status as number) || 500;
        if (statusCode === 429) {
            return NextResponse.json({ errorCode: result.error }, { status: 429 });
        }
        return NextResponse.json({ error: result.error }, { status: statusCode });
    }

    return NextResponse.json({
        checkId: result.checkId,
        status: result.status,
    }, { status: result.idempotent ? 200 : 201 });
}
