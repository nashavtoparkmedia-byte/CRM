import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { fleetCheckCallbackGateV1 } from '@/modules/fleet-operations/public/v1';

// A machine route: the scraper worker posts its fleet-check result here with the
// shared FLEET_CHECK_CALLBACK_SECRET. The gate runs before the body is read; an
// unset secret answers 503, a missing or wrong one 401, and nothing is touched.
export async function POST(req: NextRequest) {
    const gate = fleetCheckCallbackGateV1(req.headers);
    if (!gate.ok) {
        return NextResponse.json({ error: gate.status === 503 ? 'callback is not configured' : 'unauthorized' }, { status: gate.status });
    }

    let body: any;
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
    }

    const { checkId, driverId, status, finishedAt, result, errorCode } = body;

    if (!checkId || !driverId || !status) {
        return NextResponse.json({ error: 'checkId, driverId, status required' }, { status: 400 });
    }

    // Primary key: driverId
    const driver = await prisma.driver.findUnique({ where: { id: driverId } });
    if (!driver) {
        console.warn(`[fleet-check/callback] Driver not found: driverId=${driverId}, checkId=${checkId}`);
        return NextResponse.json({ error: 'Driver not found' }, { status: 404 });
    }

    // Idempotency: if checkId doesn't match last check, ignore
    if (driver.lastFleetCheckId !== checkId) {
        console.warn(
            `[fleet-check/callback] Ignoring stale callback: driverId=${driverId}, ` +
            `received checkId=${checkId}, expected=${driver.lastFleetCheckId}`
        );
        return NextResponse.json({ ignored: true, reason: 'checkId mismatch' });
    }

    // Status mapping: SUCCESS → completed, FAILED → failed
    const mappedStatus = status === 'SUCCESS' ? 'completed' : 'failed';
    const checkFinishedAt = finishedAt ? new Date(finishedAt) : new Date();

    // Determine lastExternalPark from otherParks
    let lastExternalPark: string | null = null;
    const otherParks = result?.otherParks;
    if (Array.isArray(otherParks) && otherParks.length > 0) {
        // Park with latest date, or first in scraper's sort order
        lastExternalPark = otherParks[0]?.company || null;
    }

    // Update driver + create events in transaction
    await prisma.$transaction(async (tx) => {
        await tx.driver.update({
            where: { id: driverId },
            data: {
                lastFleetCheckAt: checkFinishedAt,
                lastFleetCheckStatus: mappedStatus,
                lastExternalPark: lastExternalPark, // null if otherParks empty → clears old park
            },
        });

        // Create fleet_check_completed event
        await tx.driverEvent.create({
            data: {
                driverId,
                eventType: 'fleet_check_completed',
                payload: {
                    checkId,
                    status: mappedStatus,
                    checksLeft: result?.checksLeft ?? null,
                    errorCode: errorCode ?? null,
                    result: result ?? null // <--- Save full parsed result here for UI rendering
                },
            },
        });

        // Create external_park_detected event if park found
        if (lastExternalPark) {
            await tx.driverEvent.create({
                data: {
                    driverId,
                    eventType: 'external_park_detected',
                    payload: {
                        parkName: lastExternalPark,
                        otherParks: otherParks,
                    },
                },
            });
        }
    });

    return NextResponse.json({ ok: true, status: mappedStatus });
}
