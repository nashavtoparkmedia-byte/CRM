import { prisma } from '@/lib/prisma'
import type { HistoryImportJobPersistencePortV1 } from './history-import-job-handler'

export const legacyPrismaHistoryImportJobPortV1: HistoryImportJobPersistencePortV1 = {
  async delete(jobId) {
    await prisma.$executeRawUnsafe('DELETE FROM "HistoryImportJob" WHERE id=$1', jobId)
  },

  async update(input) {
    await prisma.$executeRawUnsafe(
      'UPDATE "HistoryImportJob" SET status=$1::"AiImportStatus","resultType"=$2,"messagesImported"=$3,"chatsScanned"=$4,"contactsFound"=$5,"startedAt"=$6,"finishedAt"=$7,"coveredPeriodFrom"=$8,"coveredPeriodTo"=$9 WHERE id=$10',
      input.status,
      input.resultType,
      input.messagesImported,
      input.chatsScanned,
      input.contactsFound,
      input.startedAt,
      input.finishedAt,
      input.coveredPeriodFrom,
      input.coveredPeriodTo,
      input.jobId,
    )
  },

  async deleteForConnection(input) {
    await prisma.$executeRawUnsafe(
      'DELETE FROM "HistoryImportJob" WHERE $1=ANY(channels) AND "connectionId"=$2',
      input.channel,
      input.connectionId,
    )
  },

  async deleteForChannel(channel) {
    await prisma.$executeRawUnsafe(
      'DELETE FROM "HistoryImportJob" WHERE $1=ANY(channels)',
      channel,
    )
  },

  async patch(jobId, patch) {
    const updated = [
      patch.status,
      patch.resultType,
      patch.messagesImported,
      patch.chatsScanned,
      patch.contactsFound,
      patch.startedAt,
      patch.finishedAt,
      patch.coveredPeriodFrom,
      patch.coveredPeriodTo,
      patch.detailsJson,
    ].some((value) => value !== undefined)
    if (!updated) return { updated: false }

    await prisma.$executeRawUnsafe(
      'UPDATE "HistoryImportJob" SET status = CASE WHEN $1::boolean THEN $2::"AiImportStatus" ELSE status END, "resultType" = CASE WHEN $3::boolean THEN $4::text ELSE "resultType" END, "messagesImported" = CASE WHEN $5::boolean THEN $6::integer ELSE "messagesImported" END, "chatsScanned" = CASE WHEN $7::boolean THEN $8::integer ELSE "chatsScanned" END, "contactsFound" = CASE WHEN $9::boolean THEN $10::integer ELSE "contactsFound" END, "startedAt" = CASE WHEN $11::boolean THEN $12::timestamp(3) ELSE "startedAt" END, "finishedAt" = CASE WHEN $13::boolean THEN $14::timestamp(3) ELSE "finishedAt" END, "coveredPeriodFrom" = CASE WHEN $15::boolean THEN $16::timestamp(3) ELSE "coveredPeriodFrom" END, "coveredPeriodTo" = CASE WHEN $17::boolean THEN $18::timestamp(3) ELSE "coveredPeriodTo" END, "detailsJson" = CASE WHEN $19::boolean THEN $20::jsonb ELSE "detailsJson" END WHERE id = $21',
      patch.status !== undefined,
      patch.status === undefined ? null : patch.status,
      patch.resultType !== undefined,
      patch.resultType === undefined ? null : patch.resultType,
      patch.messagesImported !== undefined,
      patch.messagesImported === undefined ? null : patch.messagesImported,
      patch.chatsScanned !== undefined,
      patch.chatsScanned === undefined ? null : patch.chatsScanned,
      patch.contactsFound !== undefined,
      patch.contactsFound === undefined ? null : patch.contactsFound,
      patch.startedAt !== undefined,
      patch.startedAt === undefined ? null : patch.startedAt,
      patch.finishedAt !== undefined,
      patch.finishedAt === undefined ? null : patch.finishedAt,
      patch.coveredPeriodFrom !== undefined,
      patch.coveredPeriodFrom === undefined ? null : patch.coveredPeriodFrom,
      patch.coveredPeriodTo !== undefined,
      patch.coveredPeriodTo === undefined ? null : patch.coveredPeriodTo,
      patch.detailsJson !== undefined,
      patch.detailsJson === undefined ? null : JSON.stringify(patch.detailsJson),
      jobId,
    )
    return { updated: true }
  },

  async queue(input) {
    await prisma.$executeRawUnsafe(
      'INSERT INTO "HistoryImportJob" (id, channels, mode, "daysBack", "connectionId", status, "chatsScanned", "contactsFound", "messagesImported", "createdAt") VALUES ($1,$2::text[],$3::"AiImportMode",$4,$5,\'queued\'::"AiImportStatus",0,0,0,NOW())',
      input.jobId,
      input.channels,
      input.mode,
      input.daysBack,
      input.connectionId,
    )
  },

  async cancel(jobId) {
    await prisma.$executeRawUnsafe(
      'UPDATE "HistoryImportJob" SET status=\'failed\'::"AiImportStatus","resultType"=\'failed\',"finishedAt"=NOW() WHERE id=$1 AND status IN (\'queued\'::"AiImportStatus",\'running\'::"AiImportStatus")',
      jobId,
    )
  },
}
