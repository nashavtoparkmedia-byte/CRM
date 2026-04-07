import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

export async function DELETE(
    _req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const { id } = await params
        await prisma.$executeRaw`DELETE FROM "HistoryImportJob" WHERE id = ${id}`
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

        await prisma.$executeRawUnsafe(
            `UPDATE "HistoryImportJob"
            SET
                status            = '${status}'::"AiImportStatus",
                "resultType"      = $1,
                "messagesImported"= $2,
                "chatsScanned"    = $3,
                "contactsFound"   = $4,
                "startedAt"       = $5,
                "finishedAt"      = $6,
                "coveredPeriodFrom" = $7,
                "coveredPeriodTo"   = $8
            WHERE id = $9`,
            resultType ?? null,
            messagesImported ?? 0,
            chatsScanned ?? 0,
            contactsFound ?? 0,
            startedAt ? new Date(startedAt) : null,
            finishedAt ? new Date(finishedAt) : null,
            realFrom,
            realTo,
            id
        )

        return NextResponse.json({ ok: true })
    } catch (e: any) {
        console.error('[API import-jobs PATCH]', e.message)
        return NextResponse.json({ error: e.message }, { status: 500 })
    }
}
