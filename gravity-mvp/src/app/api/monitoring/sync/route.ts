import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { normalizePhoneE164 } from '@/modules/contacts/public/v1/phone-identity';
import { CREATE_CONTACT_PHONE_COMMAND_V1, DEACTIVATE_CONTACT_PHONE_COMMAND_V1 } from '@/contracts/contacts/v1';
import { createContactPhoneV1, deactivateContactPhoneV1 } from '@/modules/contacts/public/v1';
import { CREATE_FLEET_CONTACT_COMMAND_V1, PATCH_FLEET_CONTACT_COMMAND_V1 } from '@/contracts/contacts/v1';
import { createFleetContactV1, patchFleetContactV1 } from '@/modules/contacts/public/v1';

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
type ActivePhoneOwner = {
    id: string;
    contactId: string;
    contact: {
        id: string;
        yandexDriverId: string | null;
        isArchived: boolean;
    };
};

async function findActivePhoneOwners(normalizedE164: string): Promise<ActivePhoneOwner[]> {
    return prisma.contactPhone.findMany({
        where: { phone: normalizedE164, isActive: true },
        select: {
            id: true,
            contactId: true,
            contact: {
                select: {
                    id: true,
                    yandexDriverId: true,
                    isArchived: true,
                },
            },
        },
    });
}

function phoneOwnerDiagnostics(owners: ActivePhoneOwner[]) {
    return owners.map((owner) => ({
        contactId: owner.contactId,
        contactPhoneId: owner.id,
        yandexDriverId: owner.contact.yandexDriverId,
        isArchived: owner.contact.isArchived,
    }));
}

function logPhoneOwnerConflict(
    event: string,
    yandexDriverId: string,
    normalizedE164: string,
    currentContactId: string,
    owners: ActivePhoneOwner[],
) {
    console.warn(JSON.stringify({
        level: 'warn',
        event,
        source: 'monitoring-sync',
        yandexDriverId,
        currentContactId,
        phoneSuffix: normalizedE164.slice(-4),
        ownerCount: owners.length,
        owners: phoneOwnerDiagnostics(owners),
    }));
}

function isUniqueConstraintError(err: any): boolean {
    return err?.code === 'P2002';
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

    // ── Scenario 1: Contact already linked to this yandexDriverId ─────
    const existing = await prisma.contact.findUnique({
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
            const phoneOwners = await findActivePhoneOwners(normalizedE164);
            const otherOwners = phoneOwners.filter((owner) => owner.contactId !== existing.id);
            const sameContactOwner = phoneOwners.find((owner) => owner.contactId === existing.id);

            if (otherOwners.length > 0) {
                logPhoneOwnerConflict(
                    'monitoring_sync_contact_phone_owner_conflict',
                    yandexDriverId,
                    normalizedE164,
                    existing.id,
                    otherOwners,
                );
                return { action: 'ambiguous_phone_owner', phonesDeactivated: 0, phonesCreated: 0 };
            }

            if (currentYandexPhone && currentYandexPhone.phone !== normalizedE164) {
                await deactivateContactPhoneV1({
                    contract: DEACTIVATE_CONTACT_PHONE_COMMAND_V1,
                    contactPhoneId: currentYandexPhone.id,
                });
                deactivated++;

                if (sameContactOwner) {
                    if (existing.primaryPhoneId === currentYandexPhone.id) {
                        updates.primaryPhoneId = sameContactOwner.id;
                    }
                } else {
                    try {
                        const { contactPhoneId: newPhoneId } = await createContactPhoneV1({
                            contract: CREATE_CONTACT_PHONE_COMMAND_V1,
                            contactId: existing.id,
                            phone: normalizedE164,
                            source: 'yandex',
                            isPrimary: true,
                        });
                        created++;

                        if (existing.primaryPhoneId === currentYandexPhone.id) {
                            updates.primaryPhoneId = newPhoneId;
                        }
                    } catch (err: any) {
                        if (!isUniqueConstraintError(err)) throw err;
                        const ownersAfterRace = await findActivePhoneOwners(normalizedE164);
                        const otherOwnersAfterRace = ownersAfterRace.filter((owner) => owner.contactId !== existing.id);
                        const sameOwnerAfterRace = ownersAfterRace.find((owner) => owner.contactId === existing.id);
                        if (otherOwnersAfterRace.length > 0 || !sameOwnerAfterRace) {
                            logPhoneOwnerConflict(
                                'monitoring_sync_contact_phone_create_race_conflict',
                                yandexDriverId,
                                normalizedE164,
                                existing.id,
                                otherOwnersAfterRace,
                            );
                            return { action: 'ambiguous_phone_owner', phonesDeactivated: deactivated, phonesCreated: 0 };
                        }
                        if (existing.primaryPhoneId === currentYandexPhone.id) {
                            updates.primaryPhoneId = sameOwnerAfterRace.id;
                        }
                    }
                }
            } else if (!currentYandexPhone) {
                if (sameContactOwner) {
                    if (!existing.primaryPhoneId) {
                        updates.primaryPhoneId = sameContactOwner.id;
                    }
                } else {
                    try {
                        const { contactPhoneId: newPhoneId } = await createContactPhoneV1({
                            contract: CREATE_CONTACT_PHONE_COMMAND_V1,
                            contactId: existing.id,
                            phone: normalizedE164,
                            source: 'yandex',
                            isPrimary: !existing.primaryPhoneId,
                        });
                        created++;
                        if (!existing.primaryPhoneId) {
                            updates.primaryPhoneId = newPhoneId;
                        }
                    } catch (err: any) {
                        if (!isUniqueConstraintError(err)) throw err;
                        const ownersAfterRace = await findActivePhoneOwners(normalizedE164);
                        const otherOwnersAfterRace = ownersAfterRace.filter((owner) => owner.contactId !== existing.id);
                        const sameOwnerAfterRace = ownersAfterRace.find((owner) => owner.contactId === existing.id);
                        if (otherOwnersAfterRace.length > 0 || !sameOwnerAfterRace) {
                            logPhoneOwnerConflict(
                                'monitoring_sync_contact_phone_create_race_conflict',
                                yandexDriverId,
                                normalizedE164,
                                existing.id,
                                otherOwnersAfterRace,
                            );
                            return { action: 'ambiguous_phone_owner', phonesDeactivated: 0, phonesCreated: 0 };
                        }
                        if (!existing.primaryPhoneId) {
                            updates.primaryPhoneId = sameOwnerAfterRace.id;
                        }
                    }
                }
            }
        }

        if (Object.keys(updates).length > 0) {
            await patchFleetContactV1({ contract: PATCH_FLEET_CONTACT_COMMAND_V1, contactId: existing.id, patch: updates });
        }

        return { action: (Object.keys(updates).length > 0 || deactivated > 0 || created > 0) ? 'updated' : 'noop', phonesDeactivated: deactivated, phonesCreated: created };
    }

    // ── Scenario 2: No Contact by yandexDriverId, but phone matches ───
    if (normalizedE164) {
        const phoneRecords = await prisma.contactPhone.findMany({
            where: { phone: normalizedE164, isActive: true },
            include: { contact: true },
        });

        if (phoneRecords.length > 1) {
            console.warn(JSON.stringify({
                level: 'warn',
                event: 'monitoring_sync_contact_phone_ambiguous',
                yandexDriverId,
                phoneSuffix: normalizedE164.slice(-4),
                candidateContactIds: phoneRecords.map((record) => record.contactId),
            }));
            return { action: 'ambiguous', phonesDeactivated: 0, phonesCreated: 0 };
        }

        if (phoneRecords.length === 1 && phoneRecords[0].contact.yandexDriverId && phoneRecords[0].contact.yandexDriverId !== yandexDriverId) {
            console.warn(JSON.stringify({
                level: 'warn',
                event: 'monitoring_sync_contact_driver_existing_link_conflict',
                yandexDriverId,
                existingYandexDriverId: phoneRecords[0].contact.yandexDriverId,
                contactId: phoneRecords[0].contactId,
                phoneSuffix: normalizedE164.slice(-4),
            }));
            return { action: 'noop', phonesDeactivated: 0, phonesCreated: 0 };
        }

        if (phoneRecords.length === 1 && !phoneRecords[0].contact.yandexDriverId) {
            const phoneRecord = phoneRecords[0]
            // Link existing Contact to Yandex
            const nameUpdate = phoneRecord.contact.displayNameSource !== 'manual'
                ? { displayName: fullName, displayNameSource: 'yandex' as const }
                : {};

            await patchFleetContactV1({
                contract: PATCH_FLEET_CONTACT_COMMAND_V1,
                contactId: phoneRecord.contactId,
                patch: {
                    yandexDriverId,
                    masterSource: 'yandex',
                    ...nameUpdate,
                },
            });

            console.log(`[sync] Linked Contact ${phoneRecord.contactId} to Yandex ${yandexDriverId} via phone ${normalizedE164}`);
            return { action: 'linked', phonesDeactivated: 0, phonesCreated: 0 };
        }
    }

    // ── Scenario 3: No match → create new Contact ─────────────────────
    let contact
    try {
        contact = (await createFleetContactV1({
            contract: CREATE_FLEET_CONTACT_COMMAND_V1,
                displayName: fullName,
                displayNameSource: 'yandex',
                masterSource: 'yandex',
                yandexDriverId,
        })).contact;
    } catch (err: any) {
        // Concurrent sync can race on Contact.yandexDriverId. The unique
        // constraint is the final guard; reuse the row created by the winner.
        if (err?.code !== 'P2002') throw err;
        const existingAfterRace = await prisma.contact.findUnique({
            where: { yandexDriverId },
        });
        if (!existingAfterRace) throw err;
        contact = existingAfterRace;
        console.warn(JSON.stringify({
            level: 'warn',
            event: 'monitoring_sync_contact_create_race_reused',
            yandexDriverId,
        }));
    }

    let newPhoneId: string | null = null;
    if (normalizedE164) {
        const existingPhones = await findActivePhoneOwners(normalizedE164);
        const otherOwners = existingPhones.filter((owner) => owner.contactId !== contact.id);
        const sameContactOwner = existingPhones.find((owner) => owner.contactId === contact.id);

        if (otherOwners.length > 0) {
            logPhoneOwnerConflict(
                'monitoring_sync_contact_phone_owner_conflict',
                yandexDriverId,
                normalizedE164,
                contact.id,
                otherOwners,
            );
        } else if (sameContactOwner) {
            if (!contact.primaryPhoneId) {
                await patchFleetContactV1({
                    contract: PATCH_FLEET_CONTACT_COMMAND_V1,
                    contactId: contact.id,
                    patch: { primaryPhoneId: sameContactOwner.id },
                });
            }
        } else {
            try {
                const { contactPhoneId } = await createContactPhoneV1({
                    contract: CREATE_CONTACT_PHONE_COMMAND_V1,
                    contactId: contact.id,
                    phone: normalizedE164,
                    source: 'yandex',
                    isPrimary: true,
                });
                newPhoneId = contactPhoneId;

                await patchFleetContactV1({
                    contract: PATCH_FLEET_CONTACT_COMMAND_V1,
                    contactId: contact.id,
                    patch: { primaryPhoneId: contactPhoneId },
                });
            } catch (err: any) {
                if (!isUniqueConstraintError(err)) throw err;
                const ownersAfterRace = await findActivePhoneOwners(normalizedE164);
                const otherOwnersAfterRace = ownersAfterRace.filter((owner) => owner.contactId !== contact.id);
                const sameOwnerAfterRace = ownersAfterRace.find((owner) => owner.contactId === contact.id);
                if (otherOwnersAfterRace.length > 0 || !sameOwnerAfterRace) {
                    logPhoneOwnerConflict(
                        'monitoring_sync_contact_phone_create_race_conflict',
                        yandexDriverId,
                        normalizedE164,
                        contact.id,
                        otherOwnersAfterRace,
                    );
                } else if (!contact.primaryPhoneId) {
                    await patchFleetContactV1({
                        contract: PATCH_FLEET_CONTACT_COMMAND_V1,
                        contactId: contact.id,
                        patch: { primaryPhoneId: sameOwnerAfterRace.id },
                    });
                }
            }
        }
    }

    return { action: 'created', phonesDeactivated: 0, phonesCreated: newPhoneId ? 1 : 0 };
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

        // Contact sync counters
        let contactsCreated = 0;
        let contactsLinkedByPhone = 0;
        let contactsUpdated = 0;
        let phonesDeactivated = 0;
        let phonesCreated = 0;
        let contactSyncErrors = 0;

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
                const fullName = `${dp.last_name || ''} ${dp.first_name || ''}`.trim() || 'No Name';

                await prisma.driver.upsert({
                    where: { yandexDriverId: id },
                    create: {
                        yandexDriverId: id,
                        fullName,
                        phone,
                        lastOrderAt,
                        segment: 'unknown',
                    },
                    update: {
                        fullName,
                        phone,
                        lastOrderAt,
                    },
                });
                upsertedCount++;

                // ── Contact Model sync ────────────────────────────
                try {
                    const result = await syncContactForDriver(id, fullName, phone);
                    if (result.action === 'created') contactsCreated++;
                    else if (result.action === 'linked') contactsLinkedByPhone++;
                    else if (result.action === 'updated') contactsUpdated++;
                    phonesDeactivated += result.phonesDeactivated;
                    phonesCreated += result.phonesCreated;
                } catch (contactErr: any) {
                    contactSyncErrors++;
                    console.error(`[sync] Contact sync error for yandexDriverId=${id}: ${contactErr.message}`);
                }
                // ──────────────────────────────────────────────────
            }

            totalFetched += profiles.length;
            offset += PAGE_SIZE;

            if (totalFetched >= totalInApi) break;
        }

        return NextResponse.json({
            ok: true,
            totalFetched,
            upsertedCount,
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
