/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { normalizePhoneE164 } from '@/lib/phoneUtils'
import { attachDriverProfilesToContactByPhone, refreshContactMainDriver } from '@/lib/driver-profiles/multi-park';
import { resolveStrictPhoneOwnership } from '@/lib/contacts/strict-phone-ownership';
import { Prisma } from '@prisma/client';

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


type SyncContactAction = 'created' | 'linked' | 'updated' | 'noop' | 'ambiguous' | 'ambiguous_phone_owner';
type SyncContactResult = { action: SyncContactAction; phonesDeactivated: number; phonesCreated: number };
type InternalSyncContactResult = SyncContactResult & {
    contactId?: string;
    attachProfiles?: boolean;
};

function logPhoneOwnerConflict(
    event: string,
    yandexDriverId: string,
    normalizedE164: string,
    currentContactId: string,
    ownerContactIds: string[],
    reason: string,
) {
    console.warn(JSON.stringify({
        level: 'warn',
        event,
        source: 'monitoring-sync',
        yandexDriverId,
        currentContactId,
        phoneSuffix: normalizedE164.slice(-4),
        ownerCount: ownerContactIds.length,
        ownerContactIds,
        reason,
    }));
}

/**
 * Sync Contact for a Yandex driver.
 * Spec: unified-contact-spec.md v1.1 §6.2 (Yandex sync decision table)
 *
 * Scenario 1: Contact(yandexDriverId) exists → update displayName if source=yandex
 * Scenario 2: Contact not found by yandexDriverId, but phone matches → link to yandex
 * Scenario 3: No match → create new Contact(masterSource=yandex)
 *
 * Returns counters delta for the caller to aggregate.
 */
export async function syncContactForDriver(
    yandexDriverId: string,
    fullName: string,
    phone: string | null,
): Promise<SyncContactResult> {
    const normalizedE164 = phone ? normalizePhoneE164(phone) : null;
    const outcome = await prisma.$transaction(async (tx) => {
        if (normalizedE164) {
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`contact-phone:${normalizedE164}`}))`;
        }
        return syncContactForDriverLocked(tx, yandexDriverId, fullName, normalizedE164);
    }, {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        timeout: 30000,
    });

    if (outcome.contactId) {
        if (outcome.attachProfiles && normalizedE164) {
            await attachDriverProfilesToContactByPhone(normalizedE164, 'monitoring-sync');
        } else {
            await refreshContactMainDriver(outcome.contactId, 'monitoring-sync');
        }
    }

    return {
        action: outcome.action,
        phonesDeactivated: outcome.phonesDeactivated,
        phonesCreated: outcome.phonesCreated,
    };
}

async function syncContactForDriverLocked(
    db: Prisma.TransactionClient,
    yandexDriverId: string,
    fullName: string,
    normalizedE164: string | null,
): Promise<InternalSyncContactResult> {
    // ── Scenario 1: Contact already linked to this yandexDriverId ─────
    const existing = await db.contact.findUnique({
        where: { yandexDriverId },
        include: {
            phones: { where: { isActive: true, source: 'yandex' }, orderBy: { isPrimary: 'desc' } },
        },
    });

    if (existing) {
        const updates: any = {};

        // Update displayName if source is yandex (not manual override)
        if (existing.displayNameSource === 'yandex' && existing.displayName !== fullName) {
            updates.displayName = fullName;
        }

        let deactivated = 0;
        let created = 0;
        const currentYandexPhone = existing.phones[0];

        if (normalizedE164) {
            const ownership = await resolveStrictPhoneOwnership(db, normalizedE164);
            const sameContactOwner = await db.contactPhone.findUnique({
                where: { contactId_phone: { contactId: existing.id, phone: normalizedE164 } },
            });

            if (
                ownership.kind === 'ambiguous'
                || (ownership.kind === 'matched' && ownership.contactId !== existing.id)
            ) {
                const ownerContactIds = ownership.kind === 'ambiguous'
                    ? ownership.contactIds
                    : [ownership.contactId];
                logPhoneOwnerConflict(
                    'monitoring_sync_contact_phone_owner_conflict',
                    yandexDriverId,
                    normalizedE164,
                    existing.id,
                    ownerContactIds,
                    ownership.kind === 'ambiguous' ? ownership.reason : 'different_canonical_owner',
                );
                return { action: 'ambiguous_phone_owner', phonesDeactivated: 0, phonesCreated: 0 };
            }
            if (sameContactOwner && !sameContactOwner.isActive) {
                await db.contactPhone.update({
                    where: { id: sameContactOwner.id },
                    data: { isActive: true },
                });
            }

            if (currentYandexPhone && currentYandexPhone.phone !== normalizedE164) {
                await db.contactPhone.update({
                    where: { id: currentYandexPhone.id },
                    data: { isActive: false },
                });
                deactivated++;

                if (sameContactOwner) {
                    if (existing.primaryPhoneId === currentYandexPhone.id) {
                        updates.primaryPhoneId = sameContactOwner.id;
                    }
                } else {
                    const newPhone = await db.contactPhone.upsert({
                        where: { contactId_phone: { contactId: existing.id, phone: normalizedE164 } },
                        create: {
                            contactId: existing.id,
                            phone: normalizedE164,
                            source: 'yandex',
                            isPrimary: true,
                        },
                        update: { isActive: true },
                    });
                    created++;

                    if (existing.primaryPhoneId === currentYandexPhone.id) {
                        updates.primaryPhoneId = newPhone.id;
                    }
                }
            } else if (!currentYandexPhone) {
                if (sameContactOwner) {
                    if (!existing.primaryPhoneId) {
                        updates.primaryPhoneId = sameContactOwner.id;
                    }
                } else {
                    const newPhone = await db.contactPhone.upsert({
                        where: { contactId_phone: { contactId: existing.id, phone: normalizedE164 } },
                        create: {
                            contactId: existing.id,
                            phone: normalizedE164,
                            source: 'yandex',
                            isPrimary: !existing.primaryPhoneId,
                        },
                        update: { isActive: true },
                    });
                    created++;
                    if (!existing.primaryPhoneId) {
                        updates.primaryPhoneId = newPhone.id;
                    }
                }
            }
        }

        if (Object.keys(updates).length > 0) {
            await db.contact.update({ where: { id: existing.id }, data: updates });
        }
        await db.driver.updateMany({ where: { yandexDriverId }, data: { contactId: existing.id } });

        return {
            action: (Object.keys(updates).length > 0 || deactivated > 0 || created > 0) ? 'updated' : 'noop',
            phonesDeactivated: deactivated,
            phonesCreated: created,
            contactId: existing.id,
        };
    }

    // ── Scenario 2: No Contact by yandexDriverId, but phone matches ───
    if (normalizedE164) {
        const ownership = await resolveStrictPhoneOwnership(db, normalizedE164);
        if (ownership.kind === 'ambiguous') {
            console.warn(JSON.stringify({
                level: 'warn',
                event: 'monitoring_sync_contact_phone_ambiguous',
                yandexDriverId,
                phoneSuffix: normalizedE164.slice(-4),
                candidateContactIds: ownership.contactIds,
                reason: ownership.reason,
            }));
            return { action: 'ambiguous', phonesDeactivated: 0, phonesCreated: 0 };
        }

        const phoneOwner = ownership.kind === 'matched'
            ? await db.contact.findUnique({ where: { id: ownership.contactId } })
            : null;

        if (phoneOwner?.yandexDriverId && phoneOwner.yandexDriverId !== yandexDriverId) {
            console.warn(JSON.stringify({
                level: 'warn',
                event: 'monitoring_sync_contact_driver_existing_link_conflict',
                yandexDriverId,
                existingYandexDriverId: phoneOwner.yandexDriverId,
                contactId: phoneOwner.id,
                phoneSuffix: normalizedE164.slice(-4),
            }));
            return { action: 'noop', phonesDeactivated: 0, phonesCreated: 0 };
        }

        if (phoneOwner && !phoneOwner.yandexDriverId && !phoneOwner.isArchived) {
            // Link existing Contact to Yandex
            const nameUpdate = phoneOwner.displayNameSource !== 'manual'
                ? { displayName: fullName, displayNameSource: 'yandex' as const }
                : {};

            await db.contact.update({
                where: { id: phoneOwner.id },
                data: {
                    yandexDriverId,
                    masterSource: 'yandex',
                    ...nameUpdate,
                },
            });
            await db.driver.updateMany({ where: { yandexDriverId }, data: { contactId: phoneOwner.id } });

            console.log(`[sync] Linked Contact ${phoneOwner.id} to Yandex ${yandexDriverId} via phone ${normalizedE164}`);
            return {
                action: 'linked',
                phonesDeactivated: 0,
                phonesCreated: 0,
                contactId: phoneOwner.id,
                attachProfiles: true,
            };
        }
    }

    // ── Scenario 3: No match → create new Contact ─────────────────────
    const contact = await db.contact.upsert({
        where: { yandexDriverId },
        create: {
                displayName: fullName,
                displayNameSource: 'yandex',
                masterSource: 'yandex',
                yandexDriverId,
        },
        update: {},
    });

    let newPhoneId: string | null = null;
    if (normalizedE164) {
        const ownership = await resolveStrictPhoneOwnership(db, normalizedE164);
        const sameContactOwner = await db.contactPhone.findUnique({
            where: { contactId_phone: { contactId: contact.id, phone: normalizedE164 } },
        });

        if (
            ownership.kind === 'ambiguous'
            || (ownership.kind === 'matched' && ownership.contactId !== contact.id)
        ) {
            logPhoneOwnerConflict(
                'monitoring_sync_contact_phone_owner_conflict',
                yandexDriverId,
                normalizedE164,
                contact.id,
                ownership.kind === 'ambiguous' ? ownership.contactIds : [ownership.contactId],
                ownership.kind === 'ambiguous' ? ownership.reason : 'different_canonical_owner',
            );
        } else if (sameContactOwner) {
            if (!sameContactOwner.isActive) {
                await db.contactPhone.update({
                    where: { id: sameContactOwner.id },
                    data: { isActive: true },
                });
            }
            if (!contact.primaryPhoneId) {
                await db.contact.update({
                    where: { id: contact.id },
                    data: { primaryPhoneId: sameContactOwner.id },
                });
            }
        } else {
            const newPhone = await db.contactPhone.upsert({
                where: { contactId_phone: { contactId: contact.id, phone: normalizedE164 } },
                create: {
                    contactId: contact.id,
                    phone: normalizedE164,
                    source: 'yandex',
                    isPrimary: true,
                },
                update: { isActive: true },
            });
            newPhoneId = newPhone.id;

            await db.contact.update({
                where: { id: contact.id },
                data: { primaryPhoneId: newPhone.id },
            });
        }
    }

    await db.driver.updateMany({ where: { yandexDriverId }, data: { contactId: contact.id } });

    return {
        action: 'created',
        phonesDeactivated: 0,
        phonesCreated: newPhoneId ? 1 : 0,
        contactId: contact.id,
        attachProfiles: Boolean(normalizedE164),
    };
}

export async function POST(req: NextRequest) {
    const expectedKey = process.env.CRON_SECRET;
    const cronKey = req.headers.get('x-cron-key') || req.nextUrl.searchParams.get('key');

    if (expectedKey && cronKey !== expectedKey) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (syncRunning) {
        return NextResponse.json({ error: 'Sync already running' }, { status: 409 });
    }

    syncRunning = true;
    try {
        const connections = await prisma.apiConnection.findMany({ orderBy: { createdAt: 'asc' } });
        if (connections.length === 0) {
            return NextResponse.json({ error: 'No API connection configured' }, { status: 500 });
        }

        const PAGE_SIZE = 500;
        let totalFetched = 0;
        let upsertedCount = 0;
        let contactsCreated = 0;
        let contactsLinkedByPhone = 0;
        let contactsUpdated = 0;
        let phonesDeactivated = 0;
        let phonesCreated = 0;
        let contactSyncErrors = 0;
        const parkResults: Array<{ parkId: string; parkName: string; fetched: number; upserted: number; error?: string }> = [];

        for (const connection of connections) {
            const parkName = connection.name || connection.parkId;
            let offset = 0;
            let parkFetched = 0;
            let parkUpserted = 0;

            try {
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
                            offset,
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

                        const lastOrderAtRaw = dp.last_order_at || p.last_order_at || p.last_ride_at;
                        const lastOrderAt = lastOrderAtRaw ? new Date(lastOrderAtRaw) : null;
                        const phone = normalizePhone(dp.phones?.[0]);
                        const fullName = `${dp.last_name || ''} ${dp.first_name || ''}`.trim() || 'No Name';
                        const status = dp.work_status || p.current_status?.status || null;
                        const dismissedAt = status === 'fired' && p.current_status?.status_updated_at
                            ? new Date(p.current_status.status_updated_at)
                            : null;

                        await prisma.driver.upsert({
                            where: { yandexDriverId: id },
                            create: {
                                yandexDriverId: id,
                                fullName,
                                phone,
                                lastOrderAt,
                                dismissedAt,
                                statusOverride: dismissedAt ? 'dismissed' : 'working',
                                lastExternalPark: parkName,
                                segment: 'unknown',
                            },
                            update: {
                                fullName,
                                phone,
                                lastOrderAt,
                                dismissedAt,
                                statusOverride: dismissedAt ? 'dismissed' : 'working',
                                lastExternalPark: parkName,
                            },
                        });
                        upsertedCount++;
                        parkUpserted++;

                        try {
                            const result = await syncContactForDriver(id, fullName, phone);
                            if (result.action === 'created') contactsCreated++;
                            else if (result.action === 'linked') contactsLinkedByPhone++;
                            else if (result.action === 'updated') contactsUpdated++;
                            phonesDeactivated += result.phonesDeactivated;
                            phonesCreated += result.phonesCreated;
                        } catch (contactErr: any) {
                            contactSyncErrors++;
                            console.error(`[sync] Contact sync error for park=${parkName} yandexDriverId=${id}: ${contactErr.message}`);
                        }
                    }

                    parkFetched += profiles.length;
                    totalFetched += profiles.length;
                    offset += PAGE_SIZE;
                    if (offset >= totalInApi) break;
                }
                parkResults.push({ parkId: connection.parkId, parkName, fetched: parkFetched, upserted: parkUpserted });
            } catch (err: any) {
                parkResults.push({ parkId: connection.parkId, parkName, fetched: parkFetched, upserted: parkUpserted, error: err?.message || String(err) });
                console.error(`[sync] Park sync error park=${parkName}:`, err?.message || err);
            }
        }

        const failed = parkResults.filter(result => result.error);
        if (failed.length === connections.length) {
            return NextResponse.json({ error: 'All Yandex park syncs failed', parkResults }, { status: 500 });
        }

        return NextResponse.json({
            ok: true,
            totalFetched,
            upsertedCount,
            parksProcessed: connections.length,
            parkResults,
            contactSync: {
                created: contactsCreated,
                linkedByPhone: contactsLinkedByPhone,
                updated: contactsUpdated,
                phonesDeactivated,
                phonesCreated,
                errors: contactSyncErrors,
            },
        });
    } catch (err: any) {
        console.error('[sync] Fatal Error:', err.message);
        return NextResponse.json({ error: err.message }, { status: 500 });
    } finally {
        syncRunning = false;
    }
}
