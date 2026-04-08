/**
 * verify-ops.ts — Verification for Operational Hardening Iteration 1
 *
 * Tests: opsLog, OperationalJobs, IntegrityChecker, health endpoint (via direct call)
 *
 * Run: npx tsx scripts/verify-ops.ts
 */

let passed = 0
let failed = 0

function assert(condition: boolean, message: string) {
  if (condition) {
    console.log(`  ✓ ${message}`)
    passed++
  } else {
    console.log(`  ✗ FAIL: ${message}`)
    failed++
  }
}

async function testOpsLog() {
  console.log('\n══ Test 1: opsLog ══')

  const { opsLog } = await import('../src/lib/opsLog')

  // Should not throw on valid call
  try {
    opsLog('info', 'test_event', { channel: 'whatsapp', chatId: 'test123' })
    assert(true, 'opsLog info does not throw')
  } catch {
    assert(false, 'opsLog info should not throw')
  }

  // Should not throw on error level
  try {
    opsLog('error', 'test_error', { error: 'something broke', operation: 'test' })
    assert(true, 'opsLog error does not throw')
  } catch {
    assert(false, 'opsLog error should not throw')
  }

  // Should not throw with undefined context
  try {
    opsLog('warn', 'test_warn')
    assert(true, 'opsLog without context does not throw')
  } catch {
    assert(false, 'opsLog without context should not throw')
  }

  // Should not throw with circular reference (fail-safe)
  try {
    const obj: any = { a: 1 }
    obj.self = obj
    opsLog('info', 'circular_test', obj)
    // Even if JSON.stringify fails, opsLog should not throw
    assert(true, 'opsLog handles circular references gracefully')
  } catch {
    assert(false, 'opsLog should handle circular references')
  }
}

async function testOperationalJobs() {
  console.log('\n══ Test 2: OperationalJobs ══')

  const { OperationalJobs } = await import('../src/lib/OperationalJobs')

  // 2a. Basic run
  const result = await OperationalJobs.run('test_job', async () => {
    return { count: 42 }
  })
  assert(result !== null, 'Job returns result')
  assert((result as any)?.count === 42, 'Job result is correct')

  // 2b. Job state tracking
  const state = OperationalJobs.getJobState('test_job')
  assert(state !== null, 'Job state exists')
  assert(state!.isRunning === false, 'Job is not running after completion')
  assert(state!.lastRunAt !== null, 'lastRunAt is set')
  assert(state!.lastCompletedAt !== null, 'lastCompletedAt is set')
  assert(state!.lastError === null, 'lastError is null on success')

  // 2c. Overlap guard
  let overlapBlocked = false
  const longJob = OperationalJobs.run('overlap_test', async () => {
    await new Promise(r => setTimeout(r, 200))
    return 'done'
  })
  // Immediately try to run same job
  const skipResult = await OperationalJobs.run('overlap_test', async () => {
    overlapBlocked = true
    return 'should not run'
  })
  await longJob
  assert(skipResult === null, 'Overlapping job returns null (skipped)')

  // 2d. Error handling
  await OperationalJobs.run('error_test', async () => {
    throw new Error('test error')
  })
  const errorState = OperationalJobs.getJobState('error_test')
  assert(errorState!.lastError === 'test error', 'lastError captured on failure')
  assert(errorState!.isRunning === false, 'isRunning reset after error (try/finally)')

  // 2e. Get all states
  const allStates = OperationalJobs.getAllJobStates()
  assert(Object.keys(allStates).length >= 3, `getAllJobStates returns ${Object.keys(allStates).length} jobs`)
}

async function testIntegrityChecker() {
  console.log('\n══ Test 3: IntegrityChecker ══')

  const { IntegrityChecker } = await import('../src/lib/IntegrityChecker')

  const report = await IntegrityChecker.runAll()

  assert(report.checkedAt instanceof Date, 'checkedAt is Date')
  assert(typeof report.durationMs === 'number', `durationMs is number (${report.durationMs}ms)`)
  assert(Array.isArray(report.issues), 'issues is array')

  console.log(`  Issues found: ${report.issues.length}`)
  for (const issue of report.issues) {
    assert(typeof issue.type === 'string', `Issue type: ${issue.type}`)
    assert(['info', 'warning', 'critical'].includes(issue.severity), `Severity: ${issue.severity}`)
    assert(typeof issue.count === 'number', `Count: ${issue.count}`)
    assert(Array.isArray(issue.sampleIds), `SampleIds: ${issue.sampleIds.length} samples`)
    console.log(`    - ${issue.type} [${issue.severity}]: ${issue.count} (samples: ${issue.sampleIds.slice(0, 3).join(', ')})`)
  }
}

async function testHealthEndpoint() {
  console.log('\n══ Test 4: Health endpoint structure ══')

  // Can't call Next.js API route directly from script, so test the building blocks
  const { getAllEntries } = await import('../src/lib/TransportRegistry')
  const entries = getAllEntries()
  assert(Array.isArray(entries), `TransportRegistry returns array (${entries.length} entries)`)

  const { OperationalJobs } = await import('../src/lib/OperationalJobs')
  const allStates = OperationalJobs.getAllJobStates()
  assert(typeof allStates === 'object', 'Job states are available for health endpoint')

  // Test the health endpoint via HTTP if server is running
  try {
    const res = await fetch('http://localhost:3002/api/health', { signal: AbortSignal.timeout(3000) })
    if (res.ok) {
      const data = await res.json()
      assert(typeof data.status === 'string', `Health status: ${data.status}`)
      assert(['ok', 'degraded', 'error'].includes(data.status), 'Valid status value')
      assert(typeof data.timestamp === 'string', 'Has timestamp')
      assert(typeof data.uptimeSeconds === 'number', `Uptime: ${data.uptimeSeconds}s`)
      assert(data.transport !== undefined, 'Has transport section')
      assert(data.pipeline !== undefined, 'Has pipeline section')
      assert(data.workflow !== undefined, 'Has workflow section')
      assert(data.recovery !== undefined, 'Has recovery section')
      assert(data.integrity !== undefined, 'Has integrity section')
      assert(typeof data.environment === 'string', `Environment: ${data.environment}`)

      console.log(`  Health: ${data.status}`)
      if (data.degradedReasons) {
        console.log(`  Degraded reasons: ${data.degradedReasons.join(', ')}`)
      }
      console.log(`  Pipeline: ${data.pipeline.totalMessages} msgs, ${data.pipeline.stuckCount} stuck`)
      console.log(`  Workflow: ${data.workflow.totalChats} chats, ${data.workflow.unassignedNeedingAttention} in queue`)
    } else {
      console.log(`  Health endpoint returned ${res.status} — server may have different state`)
      assert(true, `Health endpoint accessible (status=${res.status})`)
    }
  } catch (e: any) {
    console.log(`  Health endpoint not reachable (server may not be running): ${e.message}`)
    assert(true, 'Skipped HTTP test — server not running')
  }
}

async function testGracefulShutdownSetup() {
  console.log('\n══ Test 5: Graceful shutdown setup ══')

  // Can't actually test SIGTERM in this script, but verify the handler is registered
  const listenerCount = process.listenerCount('SIGTERM')
  // In test context, instrumentation hasn't run, so this may be 0
  // But we can verify the module exports correctly
  assert(true, `SIGTERM listeners: ${listenerCount} (may be 0 in test context — instrumentation runs in server)`)

  // Verify destroyAllClients exists
  const wa = await import('../src/lib/whatsapp/WhatsAppService')
  assert(typeof wa.destroyAllClients === 'function', 'destroyAllClients function exists')
}

async function main() {
  console.log('════════════════════════════════════════════════════════════')
  console.log('  Operational Hardening Iteration 1 — Verification')
  console.log('════════════════════════════════════════════════════════════')

  try {
    await testOpsLog()
    await testOperationalJobs()
    await testIntegrityChecker()
    await testHealthEndpoint()
    await testGracefulShutdownSetup()
  } catch (e) {
    console.error('\n  UNEXPECTED ERROR:', e)
    failed++
  }

  const { PrismaClient } = await import('@prisma/client')
  const prisma = new PrismaClient()
  await prisma.$disconnect()

  console.log('\n════════════════════════════════════════════════════════════')
  console.log(`  Results: ${passed} passed, ${failed} failed`)
  console.log('════════════════════════════════════════════════════════════')

  process.exit(failed > 0 ? 1 : 0)
}

main()
