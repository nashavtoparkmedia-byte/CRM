/**
 * observe-24h.ts — 24-hour observation baseline collector.
 *
 * Polls /api/health every 15 minutes and logs a summary line.
 * After 24 hours, outputs a final report with min/max/avg for key metrics.
 *
 * Run: npx tsx scripts/observe-24h.ts
 * Stop: Ctrl+C (outputs partial report)
 */

const BASE_URL = process.env.HEALTH_URL || 'http://localhost:3002'
const POLL_INTERVAL_MS = 15 * 60 * 1000 // 15 minutes
const TOTAL_DURATION_MS = 24 * 60 * 60 * 1000 // 24 hours

interface Snapshot {
  ts: string
  status: string
  uptimeSeconds: number
  memoryRssMB: number
  heapUsedMB: number
  healthLatencyMs: number
  stuckCount: number
  retryPending: number
  watchdogUnhealthy: number
  degradedConnections: number
  integrityIssues: number
  totalMessages: number
  failedLast24h: number
}

const snapshots: Snapshot[] = []

async function collectSnapshot(): Promise<Snapshot | null> {
  const start = Date.now()
  try {
    const res = await fetch(`${BASE_URL}/api/health`, { signal: AbortSignal.timeout(10000) })
    const data = await res.json()
    const latency = Date.now() - start

    const snapshot: Snapshot = {
      ts: new Date().toISOString(),
      status: data.status || 'unknown',
      uptimeSeconds: data.uptimeSeconds || 0,
      memoryRssMB: data.runtime?.memoryMB?.rss || 0,
      heapUsedMB: data.runtime?.memoryMB?.heapUsed || 0,
      healthLatencyMs: latency,
      stuckCount: data.pipeline?.stuckCount || 0,
      retryPending: data.retry?.pendingRetryable || 0,
      watchdogUnhealthy: data.watchdog?.unhealthyCount || 0,
      degradedConnections: data.transport?.degradedConnections || 0,
      integrityIssues: data.integrity?.issues?.length || 0,
      totalMessages: data.pipeline?.totalMessages || 0,
      failedLast24h: data.pipeline?.failedLast24h || 0,
    }

    // Log summary line
    console.log(
      `[${snapshot.ts.substring(11, 19)}] ` +
      `status=${snapshot.status} ` +
      `rss=${snapshot.memoryRssMB}MB ` +
      `heap=${snapshot.heapUsedMB}MB ` +
      `latency=${snapshot.healthLatencyMs}ms ` +
      `stuck=${snapshot.stuckCount} ` +
      `retry=${snapshot.retryPending} ` +
      `wd=${snapshot.watchdogUnhealthy} ` +
      `degraded=${snapshot.degradedConnections} ` +
      `msgs=${snapshot.totalMessages}`
    )

    return snapshot
  } catch (e: any) {
    console.log(`[${new Date().toISOString().substring(11, 19)}] ERROR: ${e.message}`)
    return null
  }
}

function printReport() {
  if (snapshots.length === 0) {
    console.log('\nNo snapshots collected.')
    return
  }

  const nums = (key: keyof Snapshot) => snapshots.map(s => s[key] as number).filter(n => typeof n === 'number')
  const min = (arr: number[]) => Math.min(...arr)
  const max = (arr: number[]) => Math.max(...arr)
  const avg = (arr: number[]) => Math.round(arr.reduce((a, b) => a + b, 0) / arr.length)

  const statusCounts: Record<string, number> = {}
  for (const s of snapshots) {
    statusCounts[s.status] = (statusCounts[s.status] || 0) + 1
  }

  console.log('\n════════════════════════════════════════════════════════════')
  console.log('  24-Hour Observation Report')
  console.log('════════════════════════════════════════════════════════════')
  console.log(`  Duration: ${snapshots.length} samples over ${Math.round((Date.now() - new Date(snapshots[0].ts).getTime()) / 60000)} minutes`)
  console.log(`  Status distribution: ${Object.entries(statusCounts).map(([k, v]) => `${k}=${v}`).join(', ')}`)
  console.log()
  console.log('  Metric                  Min       Max       Avg')
  console.log('  ─────────────────────── ───────── ───────── ─────────')

  const metrics: Array<[string, keyof Snapshot]> = [
    ['Memory RSS (MB)', 'memoryRssMB'],
    ['Heap Used (MB)', 'heapUsedMB'],
    ['Health Latency (ms)', 'healthLatencyMs'],
    ['Stuck Messages', 'stuckCount'],
    ['Retry Pending', 'retryPending'],
    ['Watchdog Unhealthy', 'watchdogUnhealthy'],
    ['Degraded Connections', 'degradedConnections'],
    ['Integrity Issues', 'integrityIssues'],
    ['Total Messages', 'totalMessages'],
    ['Failed Last 24h', 'failedLast24h'],
  ]

  for (const [label, key] of metrics) {
    const values = nums(key)
    if (values.length === 0) continue
    console.log(`  ${label.padEnd(24)} ${String(min(values)).padStart(9)} ${String(max(values)).padStart(9)} ${String(avg(values)).padStart(9)}`)
  }

  // Memory growth
  if (snapshots.length >= 2) {
    const first = snapshots[0].memoryRssMB
    const last = snapshots[snapshots.length - 1].memoryRssMB
    const growth = last - first
    console.log()
    console.log(`  Memory growth: ${growth > 0 ? '+' : ''}${growth}MB (${first}MB → ${last}MB)`)
  }

  console.log('════════════════════════════════════════════════════════════')
}

async function main() {
  console.log('════════════════════════════════════════════════════════════')
  console.log('  24-Hour Observation — Starting')
  console.log(`  Polling ${BASE_URL}/api/health every ${POLL_INTERVAL_MS / 60000} minutes`)
  console.log(`  Press Ctrl+C for partial report`)
  console.log('════════════════════════════════════════════════════════════')

  // Handle graceful stop
  process.on('SIGINT', () => {
    console.log('\n\n  Interrupted — generating partial report...')
    printReport()
    process.exit(0)
  })

  // Initial snapshot
  const first = await collectSnapshot()
  if (first) snapshots.push(first)
  else {
    console.error('  Cannot reach health endpoint. Is server running?')
    process.exit(1)
  }

  // Polling loop
  const startedAt = Date.now()
  const interval = setInterval(async () => {
    const snapshot = await collectSnapshot()
    if (snapshot) snapshots.push(snapshot)

    // Auto-stop after 24 hours
    if (Date.now() - startedAt > TOTAL_DURATION_MS) {
      clearInterval(interval)
      printReport()
      process.exit(0)
    }
  }, POLL_INTERVAL_MS)
}

main()
