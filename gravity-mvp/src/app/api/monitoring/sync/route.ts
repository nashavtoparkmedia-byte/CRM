import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { normalizePhoneE164 } from '@/lib/phoneUtils';

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
async function syncContactForDriver(
    yandexDriverId: string,
    fullName: string,
    phone: string | null,
): Promise<{ action: 'created' | 'linked' | 'updated' | 'noop'; phonesDeactivated: number; phonesCreated: number }> {
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

        // Check phone change
        let deactivated = 0;
        let created = 0;
        const currentYandexPhone = existing.phones[0];

        if (normalizedE164 && currentYandexPhone && currentYandexPhone.phone !== normalizedE164) {
            // Phone changed in Yandex → deactivate old, create new
            await prisma.contactPhone.update({
                where: { id: currentYandexPhone.id },
                data: { isActive: false },
            });
            deactivated++;

            const newPhone = await prisma.contactPhone.create({
                data: {
                    contactId: existing.id,
                    phone: normalizedE164,
                    source: 'yandex',
                    isPrimary: true,
                },
            });
            created++;

            // Unset old primary, set new
            if (existing.primaryPhoneId === currentYandexPhone.id) {
                updates.primaryPhoneId = newPhone.id;
            }
        } else if (normalizedE164 && !currentYandexPhone) {
            // No yandex phone yet → create
            const newPhone = await prisma.contactPhone.create({
                data: {
                    contactId: existing.id,
                    phone: normalizedE164,
                    source: 'yandex',
                    isPrimary: !existing.primaryPhoneId,
                },
            });
            created++;
            if (!existing.primaryPhoneId) {
                updates.primaryPhoneId = newPhone.id;
            }
        }

        if (Object.keys(updates).length > 0) {
            await prisma.contact.update({ where: { id: existing.id }, data: updates });
        }

        return { action: (Object.keys(updates).length > 0 || deactivated > 0) ? 'updated' : 'noop', phonesDeactivated: deactivated, phonesCreated: created };
    }

    // ── Scenario 2: No Contact by yandexDriverId, but phone matches ───
    if (normalizedE164) {
        const phoneRecord = await prisma.contactPhone.findFirst({
            where: { phone: normalizedE164, isActive: true },
            include: { contact: true },
        });

        if (phoneRecord && !phoneRecord.contact.yandexDriverId) {
            // Link existing Contact to Yandex
            const nameUpdate = phoneRecord.contact.displayNameSource !== 'manual'
                ? { displayName: fullName, displayNameSource: 'yandex' as const }
                : {};

            await prisma.contact.update({
                where: { id: phoneRecord.contactId },
                data: {
                    yandexDriverId,
                    masterSource: 'yandex',
                    ...nameUpdate,
                },
            });

            // Create yandex_pro identity if not exists
            await prisma.contactIdentity.upsert({
                where: { channel_externalId: { channel: 'yandex_pro', externalId: yandexDriverId } },
                create: {
                    contactId: phoneRecord.contactId,
                    channel: 'yandex_pro',
                    externalId: yandexDriverId,
                    phoneId: phoneRecord.id,
                    source: 'yandex',
                    confidence: 1.0,
                },
                update: {},
            });

            console.log(`[sync] Linked Contact ${phoneRecord.contactId} to Yandex ${yandexDriverId} via phone ${normalizedE164}`);
            return { action: 'linked', phonesDeactivated: 0, phonesCreated: 0 };
        }
    }

    // ── Scenario 3: No match → create new Contact ─────────────────────
    const contact = await prisma.contact.create({
        data: {
            displayName: fullName,
            displayNameSource: 'yandex',
            masterSource: 'yandex',
            yandexDriverId,
        },
    });

    let newPhoneId: string | null = null;
    if (normalizedE164) {
        // Check if phone already belongs to another contact (edge case: phone conflict)
        const existingPhone = await prisma.contactPhone.findFirst({
            where: { phone: normalizedE164, isActive: true },
        });

        if (!existingPhone) {
            const newPhone = await prisma.contactPhone.create({
                data: {
                    contactId: contact.id,
                    phone: normalizedE164,
                    source: 'yandex',
                    isPrimary: true,
                },
            });
            newPhoneId = newPhone.id;

            await prisma.contact.update({
                where: { id: contact.id },
                data: { primaryPhoneId: newPhone.id },
            });
        } else {
            console.log(`[sync] Phone ${normalizedE164} already belongs to contact ${existingPhone.contactId}, skipping phone creation for new contact ${contact.id}`);
        }
    }

    // Create yandex_pro identity
    await prisma.contactIdentity.create({
        data: {
            contactId: contact.id,
            channel: 'yandex_pro',
            externalId: yandexDriverId,
            phoneId: newPhoneId,
            source: 'yandex',
            confidence: 1.0,
        },
    });

    return { action: 'created', phonesDeactivated: 0, phonesCreated: normalizedE164 ? 1 : 0 };
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
