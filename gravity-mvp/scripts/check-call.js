const { loadEnvConfig } = require('@next/env')
loadEnvConfig(process.cwd())
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

async function main() {
    const callId = process.argv[2] ?? 'cmp6u3uki000dvppsp2g8u8mp'
    const call = await prisma.call.findUnique({ where: { id: callId } })
    if (!call) {
        const recent = await prisma.call.findMany({
            orderBy: { startedAt: 'desc' },
            take: 5,
            select: { id: true, fsUuid: true, direction: true, status: true, toNumber: true, durationSec: true, hangupCause: true, recordingPath: true, startedAt: true, endedAt: true },
        })
        console.log('NOT FOUND, recent 5:', JSON.stringify(recent, null, 2))
    } else {
        const { transcript, aiSummary, ...rest } = call
        console.log(JSON.stringify({ ...rest, transcript: transcript ? `<${transcript.length} chars>` : null, aiSummary: aiSummary ? `<${aiSummary.length} chars>` : null }, null, 2))
    }
    await prisma.$disconnect()
}

main().catch(e => { console.error(e); process.exit(1) })
