import { loadEnvConfig } from '@next/env'
loadEnvConfig(process.cwd())
import { prisma } from '../src/lib/prisma'
import { syncCallToChat } from '../src/lib/freeswitch/EslClient'

/**
 * Backfill: walks every Call row with a contactId and ensures there's a
 * matching Chat{channel:'phone'} + Message{type:'call'} entry, so calls
 * show up in the "Тел" tab of the chat list alongside TG/MAX/WA messages.
 *
 * Idempotent — syncCallToChat skips a Call that already has its Message
 * (matched by metadata.callId).
 */
async function main() {
    const before = {
        chats: await prisma.chat.count({ where: { channel: 'phone' } }),
        msgs:  await prisma.message.count({ where: { type: 'call' } }),
    }
    console.log(`Before: phone_chats=${before.chats}, call_messages=${before.msgs}`)

    const calls = await prisma.call.findMany({
        where: { contactId: { not: null } },
        select: {
            id: true, fsUuid: true, contactId: true, driverId: true,
            direction: true, fromNumber: true, toNumber: true,
            status: true, durationSec: true, startedAt: true, endedAt: true,
        },
        orderBy: { startedAt: 'desc' },
    })
    console.log(`Scanning ${calls.length} calls with contactId…`)

    const skipReasons: Record<string, number> = {}
    let synced = 0
    let errors = 0

    for (const c of calls) {
        try {
            await syncCallToChat(c)
            synced++
        } catch (e: any) {
            errors++
            console.error(`[${c.id}] ${c.direction} ${c.fromNumber}→${c.toNumber}: ${e.message}`)
        }
    }

    const after = {
        chats: await prisma.chat.count({ where: { channel: 'phone' } }),
        msgs:  await prisma.message.count({ where: { type: 'call' } }),
    }
    console.log(`After:  phone_chats=${after.chats}, call_messages=${after.msgs}`)
    console.log(`Done: synced=${synced}, errors=${errors}`)

    // Also show any calls that DON'T have a contactId — those are why some
    // entries are missing entirely (ContactService.resolveByPhone didn't run
    // for very old calls before that code was added).
    const orphanCount = await prisma.call.count({ where: { contactId: null } })
    if (orphanCount > 0) {
        console.log(`Note: ${orphanCount} calls have no contactId (created before auto-create). They won't appear in any chat until contactId is filled.`)
    }

    await prisma.$disconnect()
}

main().catch(e => { console.error('FAILED:', e); process.exit(1) })
