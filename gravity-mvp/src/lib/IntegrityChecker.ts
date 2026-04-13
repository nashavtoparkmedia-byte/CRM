import { prisma } from '@/lib/prisma'

/**
 * IntegrityChecker — bounded, read-only data integrity validation.
 *
 * Reports issues but does NOT auto-fix.
 * All queries are bounded (LIMIT, date ranges) to stay fast.
 * Results persisted to integrity_check_log for historical tracking.
 */

export interface IntegrityIssue {
  type: string
  severity: 'info' | 'warning' | 'critical'
  count: number
  sampleIds: string[]
}

export interface IntegrityReport {
  checkedAt: Date
  durationMs: number
  issues: IntegrityIssue[]
}

const SAMPLE_LIMIT = 5

let logTableEnsured = false

async function ensureLogTable(): Promise<void> {
  if (logTableEnsured) return
  try {
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS integrity_check_log (
        id SERIAL PRIMARY KEY,
        checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        duration_ms INT NOT NULL DEFAULT 0,
        total_issues INT NOT NULL DEFAULT 0,
        critical_issues INT NOT NULL DEFAULT 0,
        warning_issues INT NOT NULL DEFAULT 0,
        details JSONB
      )
    `)
    await prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS idx_integrity_check_log_time
      ON integrity_check_log (checked_at DESC)
    `)
    logTableEnsured = true
  } catch { /* non-blocking */ }
}

async function persistReport(report: IntegrityReport): Promise<void> {
  try {
    await ensureLogTable()
    const criticalCount = report.issues.filter(i => i.severity === 'critical').length
    const warningCount = report.issues.filter(i => i.severity === 'warning').length
    await prisma.$executeRawUnsafe(
      `INSERT INTO integrity_check_log (checked_at, duration_ms, total_issues, critical_issues, warning_issues, details)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      report.checkedAt,
      report.durationMs,
      report.issues.length,
      criticalCount,
      warningCount,
      JSON.stringify(report.issues)
    )
  } catch { /* non-blocking */ }
}

export class IntegrityChecker {

  static async runAll(): Promise<IntegrityReport> {
    const start = Date.now()
    const issues: IntegrityIssue[] = []

    await Promise.all([
      this.checkOrphanedChats(issues),
      this.checkStaleOpenChats(issues),
      this.checkInconsistentUnread(issues),
      this.checkArchivedWithActiveChats(issues),
      this.checkOrphanedTasks(issues),
      this.checkTasksWithoutEvents(issues),
      this.checkDuplicateTaskEvents(issues),
    ])

    const report: IntegrityReport = {
      checkedAt: new Date(),
      durationMs: Date.now() - start,
      issues,
    }

    // Persist report — fire and forget
    persistReport(report).catch(() => {})

    return report
  }

  /**
   * Chats with contactId pointing to an archived Contact.
   */
  private static async checkOrphanedChats(issues: IntegrityIssue[]): Promise<void> {
    try {
      const rows = await prisma.$queryRaw<Array<{ id: string }>>`
        SELECT ch.id FROM "Chat" ch
        JOIN "Contact" c ON c.id = ch."contactId"
        WHERE c."isArchived" = true
          AND ch.status != 'resolved'
        LIMIT ${SAMPLE_LIMIT + 1}
      `
      if (rows.length > 0) {
        issues.push({
          type: 'orphaned_chat_archived_contact',
          severity: 'warning',
          count: rows.length > SAMPLE_LIMIT ? rows.length : rows.length,
          sampleIds: rows.slice(0, SAMPLE_LIMIT).map(r => r.id),
        })
      }
    } catch { /* non-blocking */ }
  }

  /**
   * Chats stuck in 'open' with no messages for >7 days.
   */
  private static async checkStaleOpenChats(issues: IntegrityIssue[]): Promise<void> {
    try {
      const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
      const rows = await prisma.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM "Chat"
        WHERE status = 'open'
          AND ("lastMessageAt" IS NULL OR "lastMessageAt" < ${cutoff})
        LIMIT ${SAMPLE_LIMIT + 1}
      `
      if (rows.length > 0) {
        issues.push({
          type: 'stale_open_chat',
          severity: 'info',
          count: rows.length,
          sampleIds: rows.slice(0, SAMPLE_LIMIT).map(r => r.id),
        })
      }
    } catch { /* non-blocking */ }
  }

  /**
   * Chats where unreadCount > 0 but no inbound messages after lastOutboundAt.
   */
  private static async checkInconsistentUnread(issues: IntegrityIssue[]): Promise<void> {
    try {
      const rows = await prisma.$queryRaw<Array<{ id: string }>>`
        SELECT ch.id FROM "Chat" ch
        WHERE ch."unreadCount" > 0
          AND ch."lastOutboundAt" IS NOT NULL
          AND (ch."lastInboundAt" IS NULL OR ch."lastInboundAt" < ch."lastOutboundAt")
        LIMIT ${SAMPLE_LIMIT + 1}
      `
      if (rows.length > 0) {
        issues.push({
          type: 'inconsistent_unread_count',
          severity: 'warning',
          count: rows.length,
          sampleIds: rows.slice(0, SAMPLE_LIMIT).map(r => r.id),
        })
      }
    } catch { /* non-blocking */ }
  }

  /**
   * Archived contacts that still have active (non-resolved) chats with recent messages.
   */
  private static async checkArchivedWithActiveChats(issues: IntegrityIssue[]): Promise<void> {
    try {
      const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) // 30 days
      const rows = await prisma.$queryRaw<Array<{ id: string }>>`
        SELECT DISTINCT c.id FROM "Contact" c
        JOIN "Chat" ch ON ch."contactId" = c.id
        WHERE c."isArchived" = true
          AND ch.status != 'resolved'
          AND ch."lastMessageAt" > ${cutoff}
        LIMIT ${SAMPLE_LIMIT + 1}
      `
      if (rows.length > 0) {
        issues.push({
          type: 'archived_contact_active_chats',
          severity: 'critical',
          count: rows.length,
          sampleIds: rows.slice(0, SAMPLE_LIMIT).map(r => r.id),
        })
      }
    } catch { /* non-blocking */ }
  }

  /**
   * Tasks assigned to non-existent users (orphaned tasks).
   */
  private static async checkOrphanedTasks(issues: IntegrityIssue[]): Promise<void> {
    try {
      const rows = await prisma.$queryRaw<Array<{ id: string }>>`
        SELECT t.id FROM "Task" t
        LEFT JOIN "User" u ON u.id = t."assigneeId"
        WHERE t."assigneeId" IS NOT NULL
          AND u.id IS NULL
          AND t.status NOT IN ('closed', 'cancelled')
        LIMIT ${SAMPLE_LIMIT + 1}
      `
      if (rows.length > 0) {
        issues.push({
          type: 'orphaned_task_missing_assignee',
          severity: 'warning',
          count: rows.length,
          sampleIds: rows.slice(0, SAMPLE_LIMIT).map(r => r.id),
        })
      }
    } catch { /* non-blocking */ }
  }

  /**
   * Open/in-progress tasks with no TaskEvent records (missing audit trail).
   */
  private static async checkTasksWithoutEvents(issues: IntegrityIssue[]): Promise<void> {
    try {
      const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) // 7 days
      const rows = await prisma.$queryRaw<Array<{ id: string }>>`
        SELECT t.id FROM "Task" t
        LEFT JOIN "TaskEvent" te ON te."taskId" = t.id
        WHERE t.status IN ('open', 'in_progress')
          AND t."createdAt" < ${cutoff}
          AND te.id IS NULL
        LIMIT ${SAMPLE_LIMIT + 1}
      `
      if (rows.length > 0) {
        issues.push({
          type: 'task_without_events',
          severity: 'info',
          count: rows.length,
          sampleIds: rows.slice(0, SAMPLE_LIMIT).map(r => r.id),
        })
      }
    } catch { /* non-blocking */ }
  }

  /**
   * Duplicate task events (same task, same type, same timestamp — within 1 minute).
   */
  private static async checkDuplicateTaskEvents(issues: IntegrityIssue[]): Promise<void> {
    try {
      const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000) // 24 hours
      const rows = await prisma.$queryRaw<Array<{ id: string }>>`
        SELECT MIN(te.id) as id
        FROM "TaskEvent" te
        WHERE te."createdAt" > ${cutoff}
        GROUP BY te."taskId", te.type, date_trunc('minute', te."createdAt")
        HAVING COUNT(*) > 1
        LIMIT ${SAMPLE_LIMIT + 1}
      `
      if (rows.length > 0) {
        issues.push({
          type: 'duplicate_task_events',
          severity: 'warning',
          count: rows.length,
          sampleIds: rows.slice(0, SAMPLE_LIMIT).map(r => r.id),
        })
      }
    } catch { /* non-blocking */ }
  }

  /**
   * Get recent integrity check history (for dashboard).
   */
  static async getRecentReports(limit: number = 10): Promise<IntegrityReportSummary[]> {
    try {
      await ensureLogTable()
      return await prisma.$queryRawUnsafe<IntegrityReportSummary[]>(
        `SELECT id, checked_at as "checkedAt", duration_ms as "durationMs",
                total_issues as "totalIssues", critical_issues as "criticalIssues",
                warning_issues as "warningIssues"
         FROM integrity_check_log
         ORDER BY checked_at DESC
         LIMIT $1`,
        limit
      )
    } catch {
      return []
    }
  }
}

export interface IntegrityReportSummary {
  id: number
  checkedAt: Date
  durationMs: number
  totalIssues: number
  criticalIssues: number
  warningIssues: number
}
