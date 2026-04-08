import { prisma } from '@/lib/prisma'

/**
 * IntegrityChecker — bounded, read-only data integrity validation.
 *
 * Reports issues but does NOT auto-fix.
 * All queries are bounded (LIMIT, date ranges) to stay fast.
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

export class IntegrityChecker {

  static async runAll(): Promise<IntegrityReport> {
    const start = Date.now()
    const issues: IntegrityIssue[] = []

    await Promise.all([
      this.checkOrphanedChats(issues),
      this.checkStaleOpenChats(issues),
      this.checkInconsistentUnread(issues),
      this.checkArchivedWithActiveChats(issues),
    ])

    return {
      checkedAt: new Date(),
      durationMs: Date.now() - start,
      issues,
    }
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
}
