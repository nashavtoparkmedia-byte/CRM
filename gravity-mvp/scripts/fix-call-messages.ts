import { loadEnvConfig } from '@next/env'
loadEnvConfig(process.cwd())
import { prisma } from '../src/lib/prisma'
import { deleteCallMessagesV1 } from '../src/modules/messaging/public/v1/legacy-prisma-call-message-cleanup-adapter.js'
import { syncCallToChat } from '../src/lib/freeswitch/EslClient'

/**
 * Recovery: delete call-type messages whose metadata was clobbered by
 * MessageService.recoverStuckMessages (they have `metadata.error` and lost
 * callId/disposition/durationSec), then re-sync them from Call rows via
 * syncCallToChat — which writes them fresh with status='delivered' and the
 * correct metadata. MessageService is now patched to skip type='call', so
 * this won't recur.
 */
async function main() {
    // 1. Wipe all call-messages — corrupted ones lost their metadata.callId
    //    so syncCallToChat's idempotency check wouldn't recognise them as
    //    duplicates anyway. Easier to delete everything and let the backfill
    //    write fresh rows with the correct metadata and status='delivered'.
    const deleted = await deleteCallMessagesV1()
    console.log(`Deleted ${deleted.count} call-messages, now re-syncing from Call rows…`)

    // 3. Re-run backfill from Call rows.
    const calls = await prisma.call.findMany({
        where: { contactId: { not: null } },
        select: {
            id: true, fsUuid: true, contactId: true, driverId: true,
            direction: true, fromNumber: true, toNumber: true,
            status: true, durationSec: true, startedAt: true, endedAt: true,
        },
        orderBy: { startedAt: 'desc' },
    })
    console.log(`Re-syncing ${calls.length} calls…`)
    let synced = 0
    for (const c of calls) {
        try {
            await syncCallToChat(c)
            synced++
        } catch (e: any) {
            console.error(`[${c.id}] ${e.message}`)
        }
    }

    const after = await prisma.message.count({ where: { type: 'call' } })
    console.log(`Done. call-messages now in DB: ${after} (re-synced ${synced} calls)`)
    await prisma.$disconnect()
}

main().catch(e => { console.error(e); process.exit(1) })
