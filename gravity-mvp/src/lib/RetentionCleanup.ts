import { prisma } from '@/lib/prisma'
import { opsLog } from '@/lib/opsLog'

/**
 * RetentionCleanup — bounded, idempotent data lifecycle cleanup.
 *
 * All timestamps compared in UTC (Prisma/Postgres default).
 * All queries: ORDER BY createdAt/sentAt ASC, LIMIT, oldest first.
 * Supports dry-run mode (count only, no delete).
 * Execution timeout: 30 seconds.
 */

const EXECUTION_TIMEOUT_MS = 30_000

export interface CleanupResult {
  dryRun: boolean
  durationMs: number
  timedOut: boolean
  deletedMessages: number
  purgedRetryMetadata: number
  deletedEvents: number
  deletedArchivedContacts: number
  skippedContacts: number
}

// Cumulative counters (in-memory, reset on restart)
let totalDeletedMessages = 0
let totalDeletedEvents = 0
let totalPurgedMetadata = 0
let totalDeletedContacts = 0

export function getCumulativeCounters() {
  return {
    totalDeletedMessages,
    totalDeletedEvents,
    totalPurgedMetadata,
    totalDeletedContacts,
  }
}

export class RetentionCleanup {

  /**
   * Run all cleanup tasks. Bounded, idempotent, timeout-protected.
   *
   * @param dryRun If true, count candidates but do not delete.
   */
  static async runAll(dryRun = false): Promise<CleanupResult> {
    const start = Date.now()
    const deadline = start + EXECUTION_TIMEOUT_MS

    const result: CleanupResult = {
      dryRun,
      durationMs: 0,
      timedOut: false,
      deletedMessages: 0,
      purgedRetryMetadata: 0,
      deletedEvents: 0,
      deletedArchivedContacts: 0,
      skippedContacts: 0,
    }

    const checkTimeout = () => {
      if (Date.now() > deadline) {
        result.timedOut = true
        return true
      }
      return false
    }

    try {
      // 1. Failed messages > 90 days
      if (!checkTimeout()) {
        result.deletedMessages += await this._cleanupFailedMessages(90, 200, dryRun)
      }

      // 2. Delivered/read messages > 12 months
      if (!checkTimeout()) {
        result.deletedMessages += await this._cleanupOldMessages(365, 200, dryRun)
      }

      // 3. Purge retry metadata on old failed messages > 30 days
      if (!checkTimeout()) {
        result.purgedRetryMetadata = await this._purgeRetryMetadata(30, 200, dryRun)
      }

      // 4. Old DriverEvent > 6 months
      if (!checkTimeout()) {
        result.deletedEvents += await this._cleanupTable('DriverEvent', 180, 100, dryRun)
      }

      // 5. Old CommunicationEvent > 6 months
      if (!checkTimeout()) {
        result.deletedEvents += await this._cleanupTable('CommunicationEvent', 180, 100, dryRun)
      }

      // 6. Old ApiLog > 30 days
      if (!checkTimeout()) {
        result.deletedEvents += await this._cleanupTable('ApiLog', 30, 100, dryRun)
      }

      // 7. Archived contacts > 12 months
      if (!checkTimeout()) {
        const contactResult = await this._cleanupArchivedContacts(365, 50, dryRun)
        result.deletedArchivedContacts = contactResult.deleted
        result.skippedContacts = contactResult.skipped
      }

    } catch (err: any) {
      opsLog('error', 'retention_cleanup_error', { error: err.message, dryRun })
    }

    result.durationMs = Date.now() - start

    // Update cumulative counters (only for real runs)
    if (!dryRun) {
      totalDeletedMessages += result.deletedMessages
      totalDeletedEvents += result.deletedEvents
      totalPurgedMetadata += result.purgedRetryMetadata
      totalDeletedContacts += result.deletedArchivedContacts
    }

    opsLog('info', 'retention_cleanup_complete', {
      dryRun,
      durationMs: result.durationMs,
      timedOut: result.timedOut,
      deletedMessages: result.deletedMessages,
      purgedRetryMetadata: result.purgedRetryMetadata,
      deletedEvents: result.deletedEvents,
      deletedArchivedContacts: result.deletedArchivedContacts,
      skippedContacts: result.skippedContacts,
    })

    return result
  }

  // ── Failed messages > N days ───────────────────────────────────────────

  private static async _cleanupFailedMessages(ageDays: number, limit: number, dryRun: boolean): Promise<number> {
    const rows = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "Message"
      WHERE status = 'failed'
        AND "sentAt" < (NOW() AT TIME ZONE 'UTC') - CAST(${ageDays + ' days'} AS INTERVAL)
      ORDER BY "sentAt" ASC
      LIMIT ${limit}
    `
    if (dryRun || rows.length === 0) return rows.length

    const ids = rows.map(r => r.id)
    // Cascade: MessageAttachment + MessageEventLog deleted automatically
    await prisma.$executeRaw`DELETE FROM "Message" WHERE id = ANY(${ids}::text[])`
    return ids.length
  }

  // ── Old delivered/read messages > N days ────────────────────────────────

  private static async _cleanupOldMessages(ageDays: number, limit: number, dryRun: boolean): Promise<number> {
    const rows = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "Message"
      WHERE status IN ('delivered', 'read')
        AND "sentAt" < (NOW() AT TIME ZONE 'UTC') - CAST(${ageDays + ' days'} AS INTERVAL)
      ORDER BY "sentAt" ASC
      LIMIT ${limit}
    `
    if (dryRun || rows.length === 0) return rows.length

    const ids = rows.map(r => r.id)
    await prisma.$executeRaw`DELETE FROM "Message" WHERE id = ANY(${ids}::text[])`
    return ids.length
  }

  // ── Purge retry metadata on old failed (terminal) messages ─────────────

  private static async _purgeRetryMetadata(ageDays: number, limit: number, dryRun: boolean): Promise<number> {
    const rows = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "Message"
      WHERE status = 'failed'
        AND metadata IS NOT NULL
        AND (metadata->>'retryable') IS NOT NULL
        AND "sentAt" < (NOW() AT TIME ZONE 'UTC') - CAST(${ageDays + ' days'} AS INTERVAL)
      ORDER BY "sentAt" ASC
      LIMIT ${limit}
    `
    if (dryRun || rows.length === 0) return rows.length

    const ids = rows.map(r => r.id)
    // Strip retry fields, keep error for audit
    await prisma.$executeRaw`
      UPDATE "Message"
      SET metadata = jsonb_build_object('error', metadata->>'error', 'cleaned', true)
      WHERE id = ANY(${ids}::text[])
    `
    return ids.length
  }

  // ── Generic table cleanup by createdAt ─────────────────────────────────

  private static async _cleanupTable(tableName: string, ageDays: number, limit: number, dryRun: boolean): Promise<number> {
    // Safe table names (no SQL injection — hardcoded in caller)
    const rows = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT id FROM "${tableName}" WHERE "createdAt" < (NOW() AT TIME ZONE 'UTC') - CAST($1 AS INTERVAL) ORDER BY "createdAt" ASC LIMIT $2`,
      `${ageDays} days`,
      limit,
    )
    if (dryRun || rows.length === 0) return rows.length

    const ids = rows.map(r => r.id)
    await prisma.$executeRawUnsafe(
      `DELETE FROM "${tableName}" WHERE id = ANY($1::text[])`,
      ids,
    )
    return ids.length
  }

  // ── Archived contacts > N days (with safety checks) ────────────────────

  private static async _cleanupArchivedContacts(ageDays: number, limit: number, dryRun: boolean): Promise<{ deleted: number; skipped: number }> {
    // Find archived contacts old enough
    const candidates = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "Contact"
      WHERE "isArchived" = true
        AND "updatedAt" < (NOW() AT TIME ZONE 'UTC') - CAST(${ageDays + ' days'} AS INTERVAL)
      ORDER BY "updatedAt" ASC
      LIMIT ${limit}
    `

    if (candidates.length === 0) return { deleted: 0, skipped: 0 }

    let deleted = 0
    let skipped = 0

    for (const { id } of candidates) {
      // Safety check: no active chats, no recent messages, no merge history
      const deps = await prisma.$queryRaw<Array<{ activeChats: number; recentMessages: number; merges: number }>>`
        SELECT
          (SELECT count(*)::int FROM "Chat" WHERE "contactId" = ${id} AND status != 'resolved') as "activeChats",
          (SELECT count(*)::int FROM "Message" m
           JOIN "Chat" c ON c.id = m."chatId"
           WHERE c."contactId" = ${id}
             AND m."sentAt" > (NOW() AT TIME ZONE 'UTC') - INTERVAL '30 days') as "recentMessages",
          (SELECT count(*)::int FROM "ContactMerge" WHERE "survivorId" = ${id} OR "mergedId" = ${id}) as "merges"
      `

      const dep = deps[0]
      if (dep.activeChats > 0 || dep.recentMessages > 0 || dep.merges > 0) {
        skipped++
        continue
      }

      if (!dryRun) {
        // Cascade: ContactPhone, ContactIdentity deleted automatically
        // Must first unlink chats and tasks
        await prisma.$executeRaw`UPDATE "Chat" SET "contactId" = NULL, "contactIdentityId" = NULL WHERE "contactId" = ${id}`
        await prisma.$executeRaw`UPDATE "tasks" SET "contactId" = NULL WHERE "contactId" = ${id}`
        await prisma.$executeRaw`DELETE FROM "Contact" WHERE id = ${id}`
      }
      deleted++
    }

    return { deleted, skipped }
  }
}
