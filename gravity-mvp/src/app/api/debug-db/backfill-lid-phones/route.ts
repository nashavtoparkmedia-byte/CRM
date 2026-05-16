import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getClient } from '@/lib/whatsapp/WhatsAppService'
import { normalizePhoneE164 } from '@/lib/phoneUtils'
import { ContactMergeService } from '@/lib/ContactMergeService'

/**
 * POST /api/debug-db/backfill-lid-phones
 *
 * One-shot backfill: walks every WhatsApp ContactIdentity whose externalId
 * looks like a LID (numeric, length > 12) and whose phoneId is NULL,
 * then asks the live WA Web client for the real phone number behind it
 * via `client.getChatById(...).getContact().number`.
 *
 * If WA returns a number:
 *   - If a ContactPhone already exists for that number on a DIFFERENT
 *     Contact, merge our LID-only Contact into that Contact (so all
 *     phones / identities / chats consolidate).
 *   - Otherwise create a ContactPhone on the current Contact, link the
 *     identity to it, and set it as primaryPhoneId. The next yandex-link
 *     cron tick will auto-attach to a Driver if Driver.phone matches.
 *
 * If WA returns nothing — identity stays as it is (no fabricated phone).
 *
 * Body: { dryRun?: boolean, limit?: number, throttleMs?: number }
 *   dryRun (default true): only log what would happen, don't mutate.
 *   limit  (default 0=all): process at most N identities.
 *   throttleMs (default 150): delay between WA client calls.
 */
export async function POST(req: NextRequest) {
    let body: any = {}
    try { body = await req.json() } catch { /* empty body is fine */ }

    const dryRun: boolean = body.dryRun !== false  // default true
    const limit: number = Number.isFinite(body.limit) && body.limit > 0 ? Number(body.limit) : 0
    const throttleMs: number = Number.isFinite(body.throttleMs) ? Number(body.throttleMs) : 150

    console.log(`[lid-backfill] start dryRun=${dryRun} limit=${limit || 'all'} throttleMs=${throttleMs}`)

    // 1. Pull candidates: LID-shaped identities (length > 12, numeric, phoneId NULL)
    //    that still have at least one Chat — without a Chat we can't reach the WA
    //    client because chat-id mapping is what `getChatById` needs.
    type Row = {
        identity_id: string
        contact_id: string
        external_id: string
        chat_id: string
        chat_external_id: string
        chat_metadata: any
    }
    const rows: Row[] = limit > 0
        ? await prisma.$queryRaw<Row[]>`
            SELECT ci.id AS identity_id,
                   ci."contactId" AS contact_id,
                   ci."externalId" AS external_id,
                   c.id AS chat_id,
                   c."externalChatId" AS chat_external_id,
                   c.metadata AS chat_metadata
            FROM "ContactIdentity" ci
            JOIN "Chat" c ON c."contactIdentityId" = ci.id
            WHERE ci.channel = 'whatsapp'
              AND ci."externalId" ~ '^[0-9]+$'
              AND length(ci."externalId") > 12
              AND ci."phoneId" IS NULL
            ORDER BY ci."createdAt" DESC
            LIMIT ${limit}
        `
        : await prisma.$queryRaw<Row[]>`
            SELECT ci.id AS identity_id,
                   ci."contactId" AS contact_id,
                   ci."externalId" AS external_id,
                   c.id AS chat_id,
                   c."externalChatId" AS chat_external_id,
                   c.metadata AS chat_metadata
            FROM "ContactIdentity" ci
            JOIN "Chat" c ON c."contactIdentityId" = ci.id
            WHERE ci.channel = 'whatsapp'
              AND ci."externalId" ~ '^[0-9]+$'
              AND length(ci."externalId") > 12
              AND ci."phoneId" IS NULL
            ORDER BY ci."createdAt" DESC
        `

    console.log(`[lid-backfill] candidates: ${rows.length}`)

    // 2. Resolve a WA client for each identity. We try the connectionId stashed
    //    in Chat.metadata first; if that's not present, fall back to scanning
    //    every active WA connection until one of them recognises the LID.
    // Filter by "has live Client in memory" — that's the real test of usability,
    // and avoids coupling to a specific WhatsAppConnectionStatus enum value.
    const allConns = await prisma.whatsAppConnection.findMany({ select: { id: true } })
    const allClientIds = allConns.map(c => c.id).filter(id => !!getClient(id))
    console.log(`[lid-backfill] active WA clients in memory: ${allClientIds.length}`)

    const counters = { scanned: 0, translated: 0, merged: 0, phoneCreated: 0, skipped_no_client: 0, skipped_no_number: 0, errors: 0 }
    const sample: any[] = []  // first 10 actions for visibility in response

    for (const row of rows) {
        counters.scanned++

        const metaConnId: string | null = row.chat_metadata?.connectionId || null
        const clientIdsToTry = (metaConnId && getClient(metaConnId)) ? [metaConnId] : allClientIds

        if (clientIdsToTry.length === 0) {
            counters.skipped_no_client++
            continue
        }

        let translatedNumber: string | null = null
        let clientUsed: string | null = null

        for (const connId of clientIdsToTry) {
            const client = getClient(connId)
            if (!client) continue
            try {
                // getChatById accepts the raw JID, e.g. "63068021227590@lid"
                const waChat = await (client as any).getChatById(row.chat_external_id)
                const waContact = await waChat?.getContact?.()
                const num = waContact?.number
                if (num && /^\d{10,15}$/.test(String(num))) {
                    translatedNumber = String(num)
                    clientUsed = connId
                    break
                }
            } catch (e: any) {
                // try the next client; not all of them know this chat
                continue
            }
        }

        if (!translatedNumber) {
            counters.skipped_no_number++
            continue
        }

        const normalized = normalizePhoneE164(translatedNumber)
        if (!normalized) {
            counters.errors++
            console.warn(`[lid-backfill] translated number "${translatedNumber}" failed E.164 normalization (LID ${row.external_id})`)
            continue
        }

        counters.translated++

        // 3. Decide action: merge into existing Contact-with-phone, or create phone on ours.
        const existingPhone = await prisma.contactPhone.findFirst({
            where: { phone: normalized, isActive: true },
            select: { id: true, contactId: true },
        })

        const action = existingPhone
            ? (existingPhone.contactId === row.contact_id ? 'link_existing_phone' : 'merge')
            : 'create_phone'

        if (sample.length < 10) {
            sample.push({
                identity_id: row.identity_id,
                lid: row.external_id,
                translated: normalized,
                contact_id: row.contact_id,
                action,
                target_contact_id: existingPhone?.contactId || null,
                client_used: clientUsed,
            })
        }

        if (dryRun) {
            console.log(`[lid-backfill] DRY ${action} LID=${row.external_id} → ${normalized} (contact=${row.contact_id})`)
        } else {
            try {
                if (action === 'merge') {
                    // Our LID-only Contact (source) → existing Contact owning the phone (target).
                    // mergeContactToContact archives source, moves identities/phones/chats/tasks
                    // to target, dedupes by (channel, externalId) / phone.
                    await ContactMergeService.mergeContactToContact(row.contact_id, existingPhone!.contactId, 'system:lid-backfill')
                    counters.merged++
                    console.log(`[lid-backfill] merged contact=${row.contact_id} → target=${existingPhone!.contactId} (LID ${row.external_id} → ${normalized})`)
                } else if (action === 'link_existing_phone') {
                    // Phone already on the same Contact (edge case) — just attach the identity.
                    await prisma.contactIdentity.update({
                        where: { id: row.identity_id },
                        data: { phoneId: existingPhone!.id },
                    })
                    counters.phoneCreated++  // counts as a successful attach
                } else {
                    // create_phone: own a new ContactPhone, set primary if empty, link identity.
                    const created = await prisma.contactPhone.create({
                        data: {
                            contactId: row.contact_id,
                            phone: normalized,
                            source: 'whatsapp',
                            isPrimary: true,
                        },
                    })
                    await prisma.contactIdentity.update({
                        where: { id: row.identity_id },
                        data: { phoneId: created.id },
                    })
                    await prisma.contact.update({
                        where: { id: row.contact_id },
                        data: { primaryPhoneId: created.id },
                    })
                    counters.phoneCreated++
                    console.log(`[lid-backfill] phone created contact=${row.contact_id} phone=${normalized} (LID ${row.external_id})`)
                }
            } catch (e: any) {
                counters.errors++
                console.warn(`[lid-backfill] action ${action} failed for identity=${row.identity_id}: ${e.message}`)
            }
        }

        if (counters.scanned % 20 === 0) {
            console.log(`[lid-backfill] progress ${counters.scanned}/${rows.length} translated=${counters.translated} merged=${counters.merged} phoneCreated=${counters.phoneCreated}`)
        }

        if (throttleMs > 0) {
            await new Promise(r => setTimeout(r, throttleMs))
        }
    }

    console.log(`[lid-backfill] done`, counters)

    return NextResponse.json({
        dryRun,
        ...counters,
        sample,
    })
}
