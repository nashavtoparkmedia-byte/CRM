import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getAllEntries, getDegradedDuration, type ConnectionEntry } from '@/lib/TransportRegistry'
import { OperationalJobs } from '@/lib/OperationalJobs'
import { getCumulativeCounters } from '@/lib/RetentionCleanup'

const startedAt = Date.now()

/**
 * GET /api/health
 *
 * Unified system health snapshot. Read-only, bounded queries.
 * Returns: transport + pipeline + workflow + recovery + integrity + runtime metadata.
 */
export async function GET() {
  const now = new Date()
  let overallStatus: 'ok' | 'degraded' | 'error' = 'ok'
  const degradedReasons: string[] = []

  // ── Transport ──────────────────────────────────────────────────────────
  let transportSection: any = { whatsapp: { connections: [], readyCount: 0, totalCount: 0 }, telegram: { connections: [], readyCount: 0, totalCount: 0 } }
  try {
    const entries = getAllEntries()
    const format = (e: ConnectionEntry) => ({
      id: e.connectionId,
      channel: e.channel,
      instanceId: e.instanceId ? e.instanceId.substring(0, 8) : null,
      state: e.state,
      lastSeen: e.lastSeen?.toISOString() || null,
      lastError: e.lastError,
      retryAttempt: e.retryAttempt,
      uptimeMs: e.readyAt ? now.getTime() - e.readyAt.getTime() : null,
    })

    const wa = entries.filter(e => e.channel === 'whatsapp')
    const tg = entries.filter(e => e.channel === 'telegram')

    // Compute degradation metrics
    const degradedConnections = entries.filter(e => e.state !== 'ready' && e.state !== 'stopped')
    const degradedDurations = degradedConnections.map(e => getDegradedDuration(e.connectionId) || 0)
    const maxDegradedMs = degradedDurations.length > 0 ? Math.max(...degradedDurations) : 0

    transportSection = {
      whatsapp: {
        connections: wa.map(format),
        readyCount: wa.filter(e => e.state === 'ready').length,
        totalCount: wa.length,
      },
      telegram: {
        connections: tg.map(format),
        readyCount: tg.filter(e => e.state === 'ready').length,
        totalCount: tg.length,
      },
      degradedConnections: degradedConnections.length,
      maxDegradedMs,
    }

    // Degraded if any reconnecting/failed
    const hasFailedTransport = entries.some(e => e.state === 'failed')
    const hasReconnecting = entries.some(e => e.state === 'reconnecting')
    if (hasFailedTransport) {
      degradedReasons.push('transport_failed')
    }
    if (hasReconnecting) {
      degradedReasons.push('transport_reconnecting')
    }
    // Prolonged degradation (>5 min)
    if (maxDegradedMs > 5 * 60 * 1000) {
      degradedReasons.push('prolonged_transport_degradation')
    }
  } catch {
    overallStatus = 'error'
    degradedReasons.push('transport_unavailable')
  }

  // ── Pipeline stats (bounded) ───────────────────────────────────────────
  let pipelineSection: any = { totalMessages: 0, sentLast24h: 0, failedLast24h: 0, stuckCount: 0 }
  try {
    const cutoff24h = new Date(now.getTime() - 24 * 60 * 60 * 1000)
    const cutoffStuck = new Date(now.getTime() - 5 * 60 * 1000)

    const stats = await prisma.$queryRaw<any[]>`
      SELECT
        (SELECT count(*)::int FROM "Message") as "totalMessages",
        (SELECT count(*)::int FROM "Message" WHERE direction = 'outbound' AND status = 'sent' AND "sentAt" > ${cutoff24h}) as "sentLast24h",
        (SELECT count(*)::int FROM "Message" WHERE status = 'failed' AND "sentAt" > ${cutoff24h}) as "failedLast24h",
        (SELECT count(*)::int FROM "Message" WHERE direction = 'outbound' AND status = 'sent' AND "sentAt" < ${cutoffStuck}) as "stuckCount"
    `
    pipelineSection = stats[0]

    if (pipelineSection.stuckCount > 0) {
      degradedReasons.push('stuck_messages')
    }
  } catch {
    overallStatus = 'error'
    degradedReasons.push('database_access_failure')
  }

  // ── Workflow stats (bounded) ───────────────────────────────────────────
  let workflowSection: any = { totalChats: 0, byStatus: {}, unassignedNeedingAttention: 0, requiresResponseCount: 0 }
  try {
    const wfStats = await prisma.$queryRaw<any[]>`
      SELECT
        count(*)::int as "totalChats",
        count(*) FILTER (WHERE status = 'new')::int as "statusNew",
        count(*) FILTER (WHERE status = 'open')::int as "statusOpen",
        count(*) FILTER (WHERE status = 'waiting_customer')::int as "statusWaitingCustomer",
        count(*) FILTER (WHERE status = 'waiting_internal')::int as "statusWaitingInternal",
        count(*) FILTER (WHERE status = 'resolved')::int as "statusResolved",
        count(*) FILTER (WHERE "assignedToUserId" IS NULL AND status != 'resolved' AND ("unreadCount" > 0 OR "requiresResponse" = true))::int as "unassignedNeedingAttention",
        count(*) FILTER (WHERE "requiresResponse" = true)::int as "requiresResponseCount"
      FROM "Chat"
    `
    const s = wfStats[0]
    workflowSection = {
      totalChats: s.totalChats,
      byStatus: {
        new: s.statusNew,
        open: s.statusOpen,
        waiting_customer: s.statusWaitingCustomer,
        waiting_internal: s.statusWaitingInternal,
        resolved: s.statusResolved,
      },
      unassignedNeedingAttention: s.unassignedNeedingAttention,
      requiresResponseCount: s.requiresResponseCount,
    }
  } catch {
    // Non-critical — degraded not error
  }

  // ── Recovery job state ─────────────────────────────────────────────────
  const recoveryState = OperationalJobs.getJobState('recovery')
  const recoverySection = {
    lastRunAt: recoveryState?.lastRunAt?.toISOString() || null,
    lastCompletedAt: recoveryState?.lastCompletedAt?.toISOString() || null,
    recoveredCount: (recoveryState?.lastResult as any)?.count ?? 0,
    isRunning: recoveryState?.isRunning ?? false,
    lastError: recoveryState?.lastError || null,
  }

  if (recoveryState?.lastError) {
    overallStatus = 'error'
    degradedReasons.push('recovery_job_crashed')
  }

  // ── Integrity check state ──────────────────────────────────────────────
  const integrityState = OperationalJobs.getJobState('integrity')
  const integrityReport = integrityState?.lastResult as any
  const integritySection = {
    lastRunAt: integrityState?.lastRunAt?.toISOString() || null,
    isRunning: integrityState?.isRunning ?? false,
    issues: integrityReport?.issues || [],
  }

  if (integrityReport?.issues?.some((i: any) => i.severity === 'critical')) {
    degradedReasons.push('integrity_critical')
  } else if (integrityReport?.issues?.some((i: any) => i.severity === 'warning')) {
    degradedReasons.push('integrity_warning')
  }

  // ── Retry job state ─────────────────────────────────────────────────────
  const retryState = OperationalJobs.getJobState('message_retry')
  const retryResult = retryState?.lastResult as any
  let pendingRetryable = 0
  try {
    const pending = await prisma.$queryRaw<Array<{ count: number }>>`
      SELECT count(*)::int as count FROM "Message"
      WHERE status = 'failed' AND direction = 'outbound'
        AND (metadata->>'retryable')::text = 'true'
        AND COALESCE((metadata->>'retryAttempt')::int, 0) < COALESCE((metadata->>'maxRetries')::int, 3)
        AND "sentAt" > NOW() - INTERVAL '24 hours'
    `
    pendingRetryable = pending[0]?.count || 0
  } catch { /* non-critical */ }

  const retrySection = {
    lastRunAt: retryState?.lastRunAt?.toISOString() || null,
    isRunning: retryState?.isRunning ?? false,
    retriedCount: retryResult?.retriedCount ?? 0,
    pendingRetryable,
    lastError: retryState?.lastError || null,
  }

  // ── Watchdog state ─────────────────────────────────────────────────────
  const watchdogState = OperationalJobs.getJobState('wa_watchdog')
  const watchdogResult = watchdogState?.lastResult as any
  const watchdogSection = {
    lastRunAt: watchdogState?.lastRunAt?.toISOString() || null,
    isRunning: watchdogState?.isRunning ?? false,
    checkedCount: watchdogResult?.checkedCount ?? 0,
    unhealthyCount: watchdogResult?.unhealthyCount ?? 0,
  }

  // ── Lifecycle / cleanup state ────────────────────────────────────────────
  const cleanupState = OperationalJobs.getJobState('retention_cleanup')
  const cleanupResult = cleanupState?.lastResult as any
  const cumulative = getCumulativeCounters()

  const lifecycleSection = {
    lastCleanupAt: cleanupState?.lastRunAt?.toISOString() || null,
    isRunning: cleanupState?.isRunning ?? false,
    lastCleanupDurationMs: cleanupResult?.durationMs ?? null,
    lastCleanupStatus: cleanupResult?.timedOut ? 'timed_out' : cleanupResult ? 'completed' : null,
    dryRun: cleanupResult?.dryRun ?? null,
    deletedMessagesLastRun: (cleanupResult?.deletedMessages ?? 0),
    purgedMetadataLastRun: (cleanupResult?.purgedRetryMetadata ?? 0),
    deletedEventsLastRun: (cleanupResult?.deletedEvents ?? 0),
    deletedContactsLastRun: (cleanupResult?.deletedArchivedContacts ?? 0),
    deletedMessagesTotal: cumulative.totalDeletedMessages,
    deletedEventsTotal: cumulative.totalDeletedEvents,
    purgedMetadataTotal: cumulative.totalPurgedMetadata,
    deletedContactsTotal: cumulative.totalDeletedContacts,
  }

  // ── Runtime resources ───────────────────────────────────────────────────
  const mem = process.memoryUsage()
  const runtime = {
    memoryMB: {
      rss: Math.round(mem.rss / 1024 / 1024),
      heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
      heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
      external: Math.round(mem.external / 1024 / 1024),
    },
    healthLatencyMs: Date.now() - now.getTime(),
  }

  // ── Overall status aggregation ─────────────────────────────────────────
  if (overallStatus !== 'error' && degradedReasons.length > 0) {
    overallStatus = 'degraded'
  }

  return NextResponse.json({
    status: overallStatus,
    degradedReasons: degradedReasons.length > 0 ? degradedReasons : undefined,
    timestamp: now.toISOString(),
    uptimeSeconds: Math.floor((now.getTime() - startedAt) / 1000),
    environment: process.env.NODE_ENV || 'unknown',
    version: process.env.APP_VERSION || 'unknown',
    transport: transportSection,
    pipeline: pipelineSection,
    workflow: workflowSection,
    recovery: recoverySection,
    retry: retrySection,
    watchdog: watchdogSection,
    integrity: integritySection,
    lifecycle: lifecycleSection,
    runtime,
  })
}
