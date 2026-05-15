import { loadEnvConfig } from '@next/env'
loadEnvConfig(process.cwd())

import { processTranscribe } from '../src/lib/queue/transcribeWorker'
import { processAnalyze } from '../src/lib/queue/analyzeWorker'
import { prisma } from '../src/lib/prisma'

async function main() {
    const callId = process.argv[2]
    if (!callId) {
        console.error('Usage: tsx scripts/process-call.ts <callId>')
        process.exit(1)
    }

    const t0 = Date.now()

    console.log(`[${callId}] transcribe…`)
    await processTranscribe(callId)
    console.log(`[${callId}] transcribe done in ${Date.now() - t0}ms`)

    const t1 = Date.now()
    console.log(`[${callId}] analyze…`)
    await processAnalyze(callId)
    console.log(`[${callId}] analyze done in ${Date.now() - t1}ms`)

    const updated = await prisma.call.findUnique({
        where: { id: callId },
        select: { transcript: true, aiScore: true, aiSummary: true },
    })
    console.log(`[${callId}] result:`, {
        transcriptLen: updated?.transcript?.length ?? 0,
        aiScore: updated?.aiScore,
        aiSummary: updated?.aiSummary?.slice(0, 200),
    })

    await prisma.$disconnect()
}

main().catch(e => {
    console.error('FAILED:', e)
    process.exit(1)
})
