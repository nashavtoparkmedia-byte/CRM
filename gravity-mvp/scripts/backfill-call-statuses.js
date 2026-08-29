/**
 * Backfill historical Call rows + phone-chat Message rows to the new
 * direction-aware status taxonomy:
 *
 *   1) Re-map Call.status based on (hangupCause, durationSec, direction).
 *      Mainly upgrades old ORIGINATOR_CANCEL outbound rows from 'no_answer'
 *      to 'cancelled', and inbound NORMAL_CLEARING-without-billsec from
 *      'no_answer' to 'missed'.
 *   2) Recompute Message.content for every phone-chat call-type message
 *      via callStatusLabel(direction, status, durationSec). Also stamps
 *      metadata.status so the UI's new code path uses it directly.
 *
 * Idempotent. Safe to re-run.
 */
/* eslint-disable @typescript-eslint/no-require-imports */
const { loadEnvConfig } = require('@next/env')
loadEnvConfig(process.cwd())
const { updateCallStatusV1 } = require('../src/modules/calling/public/v1/legacy-prisma-call-status-maintenance-adapter')
const { updateCallMessageV1 } = require('../src/modules/messaging/public/v1/legacy-prisma-call-message-maintenance-adapter')
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

// Re-implement the lib here to avoid pulling tsx for a one-off script.
// Keep in sync with src/lib/calls/status.ts.
function mapHangupCauseToStatus(cause, billsec, direction) {
    if (billsec > 0) return 'completed'
    switch (cause) {
        case 'ORIGINATOR_CANCEL':
            return direction === 'outbound' ? 'cancelled' : 'missed'
        case 'NO_ANSWER':
        case 'NO_USER_RESPONSE':
        case 'ALLOTTED_TIMEOUT':
        case 'RECOVERY_ON_TIMER_EXPIRE':
        case 'NORMAL_CLEARING':
            return direction === 'outbound' ? 'no_answer' : 'missed'
        case 'USER_BUSY':
            return 'busy'
        case 'CALL_REJECTED':
        case 'NORMAL_TEMPORARY_FAILURE':
            return 'rejected'
        default:
            return 'failed'
    }
}

function callStatusLabel(direction, status, durationSec) {
    const sec = durationSec ?? 0
    if (status === 'completed' && sec > 0) {
        const mm = Math.floor(sec / 60).toString().padStart(2, '0')
        const ss = (sec % 60).toString().padStart(2, '0')
        return direction === 'inbound' ? `Входящий · ${mm}:${ss}` : `Исходящий · ${mm}:${ss}`
    }
    if (status === 'ringing') return direction === 'inbound' ? 'Входящий вызов' : 'Идёт дозвон…'
    if (status === 'active')  return direction === 'inbound' ? 'Входящий, идёт разговор' : 'Исходящий, идёт разговор'
    if (direction === 'inbound') {
        switch (status) {
            case 'missed':    return 'Пропущенный звонок'
            case 'rejected':  return 'Отклонён'
            case 'busy':      return 'Линия занята'
            case 'no_answer': return 'Пропущенный звонок'
            case 'cancelled': return 'Пропущенный звонок'
            case 'failed':    return 'Не удалось'
            case 'completed': return 'Входящий'
        }
    } else {
        switch (status) {
            case 'no_answer': return 'Без ответа'
            case 'cancelled': return 'Отменён'
            case 'busy':      return 'Занято'
            case 'rejected':  return 'Отклонён абонентом'
            case 'missed':    return 'Без ответа'
            case 'failed':    return 'Не удалось'
            case 'completed': return 'Исходящий'
        }
    }
    return 'Звонок'
}

async function main() {
    console.log('=== Step 1: re-map Call.status from (cause, billsec, direction) ===')
    const calls = await prisma.call.findMany({
        select: { id: true, direction: true, status: true, durationSec: true, hangupCause: true },
    })
    console.log(`Total Call rows: ${calls.length}`)

    let updatedCalls = 0
    for (const c of calls) {
        if (!c.hangupCause) continue // can't re-derive; leave as-is
        const billsec = c.durationSec ?? 0
        const target = mapHangupCauseToStatus(c.hangupCause, billsec, c.direction)
        if (target !== c.status) {
            await updateCallStatusV1(c.id, target)
            console.log(`  ${c.id.slice(-8)} ${c.direction.padEnd(8)} cause=${c.hangupCause.padEnd(22)} ${c.status} → ${target}`)
            updatedCalls++
        }
    }
    console.log(`Updated ${updatedCalls} Call rows.\n`)

    console.log('=== Step 2: recompute Message.content for call-type messages in phone chats ===')
    const callMessages = await prisma.message.findMany({
        where: { type: 'call' },
        select: { id: true, chatId: true, direction: true, content: true, metadata: true },
    })
    console.log(`Total call-type messages: ${callMessages.length}`)

    let updatedMsgs = 0
    for (const m of callMessages) {
        const meta = (m.metadata ?? {})
        const callId = meta.callId
        if (!callId) continue
        const call = await prisma.call.findUnique({
            where: { id: callId },
            select: { direction: true, status: true, durationSec: true },
        })
        if (!call) continue

        const newContent = callStatusLabel(call.direction, call.status, call.durationSec)
        const newMeta = {
            ...meta,
            callId,
            status: call.status,
            durationSec: call.durationSec ?? null,
        }

        if (m.content !== newContent || meta.status !== call.status || (meta.durationSec ?? null) !== (call.durationSec ?? null)) {
            await updateCallMessageV1(m.id, newContent, newMeta)
            updatedMsgs++
        }
    }
    console.log(`Updated ${updatedMsgs} Message rows.\n`)

    console.log('=== Done ===')
    await prisma.$disconnect()
}
main().catch(e => { console.error(e); process.exit(1) })
