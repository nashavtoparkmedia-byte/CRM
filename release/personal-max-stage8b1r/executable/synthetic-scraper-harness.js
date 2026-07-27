'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const { createLiveCaptureAdapterFromEnvironment } = require('/app/capture/LiveCaptureAdapter.js')
const { TransportInterceptor } = require('/app/transport/TransportInterceptor.js')

async function main() {
  const holdBeforeExit = async () => {
    const holdMs = Number(process.env.STAGE8B1R_HOLD_MS || 0)
    if (Number.isSafeInteger(holdMs) && holdMs > 0 && holdMs <= 10_000) {
      await new Promise(resolve => setTimeout(resolve, holdMs))
    }
  }
  const disabledPath = '/tmp/stage8b1r-disabled-spool'
  fs.rmSync(disabledPath, { recursive: true, force: true })
  const disabled = createLiveCaptureAdapterFromEnvironment({
    MAX_PERSONAL_ACCOUNT_ID: 'stage8b1r',
    MAX_PERSONAL_CAPTURE_SPOOL_PATH: disabledPath,
  })
  const disabledInterceptor = new TransportInterceptor(disabled)
  disabledInterceptor._handleFrame(JSON.stringify({ type: 'synthetic-default-off' }))
  assert.equal(disabled.getCaptureHealth().enabled, false)
  assert.equal(fs.existsSync(disabledPath), false)
  disabledInterceptor.detach()

  const enabled = createLiveCaptureAdapterFromEnvironment(process.env)
  assert.equal(enabled.getCaptureHealth().enabled, true)
  const interceptor = new TransportInterceptor(enabled)
  const drainOnly = process.env.STAGE8B1R_DRAIN_ONLY === '1'
  const captureOnly = process.env.STAGE8B1R_CAPTURE_ONLY === '1'
  if (!drainOnly) {
    interceptor._handleFrame(JSON.stringify({
      type: 'synthetic-stage8b1r',
      eventType: 'message',
      payload: { marker: 'non-provider-synthetic-only' },
    }))
  }

  if (captureOnly) {
    const pendingHealth = enabled.getCaptureHealth()
    assert.ok(pendingHealth.spoolPendingCount >= 1)
    interceptor.detach()
    await holdBeforeExit()
    process.stdout.write(`${JSON.stringify({
      defaultOffNoSideEffects: true,
      actualTransportHook: true,
      captureOnly: true,
      pendingCount: pendingHealth.spoolPendingCount,
      chromiumLaunched: false,
      providerContactPossible: false,
    })}\n`)
    return
  }

  const deadline = Date.now() + 15_000
  while (Date.now() < deadline && enabled.getCaptureHealth().spoolPendingCount !== 0) {
    await enabled.drain.drainOnce()
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  const health = enabled.getCaptureHealth()
  assert.equal(health.spoolPendingCount, 0)
  assert.equal(health.lostBeforeSpoolCount, 0)
  assert.ok(health.acknowledgedCount >= 1)
  const flushed = await interceptor.stopCaptureAndFlush(2_000)
  interceptor.detach()
  await holdBeforeExit()
  process.stdout.write(`${JSON.stringify({
    defaultOffNoSideEffects: true,
    actualTransportHook: true,
    drainOnly,
    acknowledgedCount: health.acknowledgedCount,
    lostBeforeSpoolCount: health.lostBeforeSpoolCount,
    flushed: flushed !== null,
    chromiumLaunched: false,
    providerContactPossible: false,
  })}\n`)
}

main().catch(error => {
  process.stderr.write(`${JSON.stringify({ code: error?.code || 'HARNESS_FAILED', name: error?.name || 'Error' })}\n`)
  process.exit(1)
})
