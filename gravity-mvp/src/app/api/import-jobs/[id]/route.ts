import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { DELETE_HISTORY_IMPORT_JOB_COMMAND_V1, UPDATE_HISTORY_IMPORT_JOB_COMMAND_V1 } from '@/contracts/messaging/v1'
import { deleteHistoryImportJobV1, updateHistoryImportJobV1 } from '@/modules/messaging/public/v1'

export async function DELETE(
    _req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const { id } = await params
        await deleteHistoryImportJobV1({ contract: DELETE_HISTORY_IMPORT_JOB_COMMAND_V1, jobId: id })
        return NextResponse.json({ ok: true })
    } catch (e: any) {
        return NextResponse.json({ error: e.message }, { status: 500 })
    }
}

export async function PATCH(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const body = await req.json()
        const { id } = await params

        const {
            status,
            resultType,
            messagesImported,
            chatsScanned,
            contactsFound,
            startedAt,
            finishedAt,
            coveredPeriodFrom,
            coveredPeriodTo,
        } = body

        const validStatuses = ['queued', 'running', 'completed', 'partial', 'failed']
        if (!validStatuses.includes(status)) throw new Error(`Invalid status: ${status}`)

        // Пересчитываем период из реальных sentAt в БД (MAX history API не возвращает timestamps)
        let realFrom: Date | null = coveredPeriodFrom ? new Date(coveredPeriodFrom) : null
        let realTo:   Date | null = coveredPeriodTo   ? new Date(coveredPeriodTo)   : null

        try {
            const dateRange = await prisma.$queryRaw<{ min_date: Date | null, max_date: Date | null }[]>`
                SELECT MIN("sentAt") AS min_date, MAX("sentAt") AS max_date
                FROM "Message"
                WHERE channel = 'max'
                  AND "sentAt" < NOW() - INTERVAL '10 minutes'
            `
            if (dateRange[0]?.min_date) realFrom = dateRange[0].min_date
            if (dateRange[0]?.max_date) realTo   = dateRange[0].max_date
        } catch {}

        await updateHistoryImportJobV1({ contract: UPDATE_HISTORY_IMPORT_JOB_COMMAND_V1, jobId: id, status, resultType: resultType ?? null, messagesImported: messagesImported ?? 0, chatsScanned: chatsScanned ?? 0, contactsFound: contactsFound ?? 0, startedAt: startedAt ? new Date(startedAt) : null, finishedAt: finishedAt ? new Date(finishedAt) : null, coveredPeriodFrom: realFrom, coveredPeriodTo: realTo })

        return NextResponse.json({ ok: true })
    } catch (e: any) {
        console.error('[API import-jobs PATCH]', e.message)
        return NextResponse.json({ error: e.message }, { status: 500 })
    }
}
