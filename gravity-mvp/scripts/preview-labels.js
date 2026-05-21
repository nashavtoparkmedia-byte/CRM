const { loadEnvConfig } = require('@next/env')
loadEnvConfig(process.cwd())
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

function callStatusLabel(direction, status, durationSec) {
    const sec = durationSec ?? 0
    if (status === 'completed' && sec > 0) {
        const mm = Math.floor(sec / 60).toString().padStart(2, '0')
        const ss = (sec % 60).toString().padStart(2, '0')
        return direction === 'inbound' ? `Входящий · ${mm}:${ss}` : `Исходящий · ${mm}:${ss}`
    }
    if (direction === 'inbound') {
        if (status === 'missed' || status === 'no_answer' || status === 'cancelled') return 'Пропущенный звонок'
        if (status === 'rejected') return 'Отклонён'
        if (status === 'busy') return 'Линия занята'
        if (status === 'failed') return 'Не удалось'
        return 'Входящий'
    } else {
        if (status === 'no_answer' || status === 'missed') return 'Без ответа'
        if (status === 'cancelled') return 'Отменён'
        if (status === 'busy') return 'Занято'
        if (status === 'rejected') return 'Отклонён абонентом'
        if (status === 'failed') return 'Не удалось'
        return 'Исходящий'
    }
}

async function main() {
    const chat = await prisma.chat.findFirst({ where: { channel: 'phone' } })
    if (!chat) { console.log('No phone chat'); process.exit(0) }
    
    const msgs = await prisma.message.findMany({
        where: { chatId: chat.id, type: 'call' },
        orderBy: { createdAt: 'desc' },
        take: 15,
    })
    
    console.log('Last 15 phone-call messages — preview of new UI labels:\n')
    for (const m of msgs) {
        const meta = m.metadata ?? {}
        const callId = meta.callId
        const call = callId ? await prisma.call.findUnique({ where: { id: callId }, select: { direction: true, status: true, durationSec: true, hangupCause: true } }) : null
        if (!call) continue
        const label = callStatusLabel(call.direction, call.status, call.durationSec)
        const time = m.sentAt?.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) ?? ''
        const cause = call.hangupCause ?? 'unknown'
        console.log(`  ${time}  ${call.direction.padEnd(8)}  status=${call.status.padEnd(10)}  cause=${cause.padEnd(22)}  → "${label}"`)
    }
    await prisma.$disconnect()
}
main().catch(e => { console.error(e); process.exit(1) })
