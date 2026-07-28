'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const { createLiveCaptureAdapterFromEnvironment } = require('/app/capture/LiveCaptureAdapter.js')
const { TransportInterceptor } = require('/app/transport/TransportInterceptor.js')

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

async function drain(adapter, attempts) {
  for (let attempt = 0; attempt < attempts && adapter.getCaptureHealth().spoolPendingCount > 0; attempt += 1) {
    await adapter.drain.drainOnce()
    await sleep(50)
  }
}

async function main() {
  const mode = process.env.STAGE8B1I_HARNESS_MODE || 'capture-and-drain'
  const disabledPath = '/tmp/personal-max-stage8b1i-disabled-spool'
  fs.rmSync(disabledPath, { recursive: true, force: true })
  const disabled = createLiveCaptureAdapterFromEnvironment({
    MAX_PERSONAL_ACCOUNT_ID: 'stage8b1i-disabled',
    MAX_PERSONAL_CAPTURE_SPOOL_PATH: disabledPath,
  })
  const disabledInterceptor = new TransportInterceptor(disabled)
  disabledInterceptor._handleFrame(JSON.stringify({ kind: 'message', direction: 'inbound', text: 'synthetic' }))
  assert.equal(disabled.getCaptureHealth().enabled, false)
  assert.equal(fs.existsSync(disabledPath), false)
  disabledInterceptor.detach()
  if (mode === 'default-off') {
    process.stdout.write(`${JSON.stringify({ defaultOffNoSpool: true, timers: false, network: false, database: false })}\n`)
    return
  }

  const adapter = createLiveCaptureAdapterFromEnvironment(process.env)
  assert.equal(adapter.getCaptureHealth().enabled, true)
  assert.ok(adapter.drain || mode === 'capture-only')
  const interceptor = new TransportInterceptor(adapter)
  const count = Number(process.env.STAGE8B1I_FRAME_COUNT || 0)
  const identical = Number(process.env.STAGE8B1I_IDENTICAL_COUNT || 0)
  assert.ok(Number.isSafeInteger(count) && count >= 0 && count <= 1000)
  assert.ok(Number.isSafeInteger(identical) && identical >= 0 && identical <= count)

  if (mode !== 'drain-only' && mode !== 'retry-only') {
    const identicalRaw = JSON.stringify({
      kind: 'message', direction: 'inbound', providerMessageId: 'stage8b1i-identical',
      protocolChatId: 'synthetic-chat', text: 'same synthetic text',
    })
    for (let index = 0; index < count; index += 1) {
      let raw
      if (index < identical) raw = identicalRaw
      else if (index === count - 2) raw = JSON.stringify({ kind: 'future_provider_shape', opaqueShapeCode: 'synthetic' })
      else if (index === count - 1) raw = 'stage8b1i-malformed-synthetic-frame'
      else raw = JSON.stringify({
        kind: 'message', direction: 'inbound', providerMessageId: `stage8b1i-${process.env.MAX_PERSONAL_ACCOUNT_ID}-${index}`,
        protocolChatId: `synthetic-${process.env.MAX_PERSONAL_ACCOUNT_ID}`, text: `synthetic-${index}`,
      })
      interceptor._handleFrame(raw)
    }
  }

  const capturedHealth = adapter.getCaptureHealth()
  assert.equal(capturedHealth.lostBeforeSpoolCount, 0)
  if (mode === 'capture-only') {
    assert.equal(capturedHealth.spoolPendingCount, count)
  } else {
    await drain(adapter, Number(process.env.STAGE8B1I_DRAIN_ATTEMPTS || 80))
  }
  const finalHealth = adapter.getCaptureHealth()
  if (mode !== 'capture-only' && mode !== 'retry-only') assert.equal(finalHealth.spoolPendingCount, 0)
  if (mode === 'retry-only') {
    assert.ok(finalHealth.spoolPendingCount > 0)
    assert.ok(finalHealth.retryCount > 0)
  }
  await interceptor.stopCaptureAndFlush(2000)
  interceptor.detach()
  process.stdout.write(`${JSON.stringify({
    defaultOffNoSpool: true,
    actualTransportHook: true,
    mode,
    framesCaptured: mode === 'drain-only' || mode === 'retry-only' ? 0 : count,
    identicalFrames: mode === 'drain-only' || mode === 'retry-only' ? 0 : identical,
    pendingBefore: capturedHealth.spoolPendingCount,
    pendingAfter: finalHealth.spoolPendingCount,
    acknowledged: finalHealth.acknowledgedCount,
    retryCount: finalHealth.retryCount,
    lostBeforeSpoolCount: finalHealth.lostBeforeSpoolCount,
    chromiumLaunched: false,
    maxContacted: false,
    providerAction: false,
  })}\n`)
}

main().catch(error => {
  process.stderr.write(`${JSON.stringify({ code: error?.code || 'SYNTHETIC_HARNESS_FAILED', name: error?.name || 'Error' })}\n`)
  process.exit(1)
})
