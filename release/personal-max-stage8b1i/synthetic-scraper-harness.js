'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const https = require('node:https')
const net = require('node:net')
const tls = require('node:tls')
const Module = require('node:module')

const ALLOWED_MODES = new Set(['default-off', 'capture-only', 'retry-only', 'capture-and-drain', 'drain-only'])
const DEFAULT_OFF_FIELDS = Object.freeze([
  'selectedMode',
  'adapterEnabled',
  'frameHandled',
  'spoolPathCreated',
  'spoolPendingCount',
  'timerAttemptCount',
  'networkAttemptCount',
  'databaseAttemptCount',
  'activeAdapterFactoryCalled',
  'drainCreated',
  'chromiumLaunched',
  'maxContacted',
  'providerAction',
])

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

function harnessError(code) {
  return Object.assign(new Error(code), { code })
}

function selectedHarnessMode(environment) {
  const raw = environment.STAGE8B1I_HARNESS_MODE
  if (typeof raw !== 'string' || raw.length === 0) throw harnessError('STAGE8B1I_HARNESS_MODE_MISSING')
  if (!ALLOWED_MODES.has(raw)) throw harnessError('STAGE8B1I_HARNESS_MODE_INVALID')
  return raw
}

function requestHost(args) {
  try {
    const first = args[0]
    if (typeof first === 'string' || first instanceof URL) return new URL(first).hostname.toLowerCase()
    if (first && typeof first === 'object') return String(first.hostname || first.host || '').toLowerCase()
  } catch {}
  return ''
}

function createAttemptInstrumentation() {
  const attempts = {
    timer: 0,
    network: 0,
    database: 0,
    chromium: 0,
    max: 0,
    provider: 0,
  }
  const original = {
    setTimeout: global.setTimeout,
    setInterval: global.setInterval,
    fetch: global.fetch,
    httpRequest: http.request,
    httpGet: http.get,
    httpsRequest: https.request,
    httpsGet: https.get,
    netConnect: net.connect,
    netCreateConnection: net.createConnection,
    tlsConnect: tls.connect,
    moduleLoad: Module._load,
  }
  let installed = false

  const countNetwork = args => {
    attempts.network += 1
    const host = requestHost(args)
    if (/(^|\.)(max\.ru|oneme\.ru)$/.test(host)) attempts.max += 1
    if (/(^|\.)(max\.ru|oneme\.ru)$/.test(host)) attempts.provider += 1
  }
  const wrapNetwork = originalFunction => function instrumentedNetworkAttempt(...args) {
    countNetwork(args)
    return originalFunction.apply(this, args)
  }

  return {
    install() {
      if (installed) throw harnessError('STAGE8B1I_INSTRUMENTATION_REENTRY')
      installed = true
      global.setTimeout = function instrumentedSetTimeout(...args) {
        attempts.timer += 1
        return original.setTimeout.apply(this, args)
      }
      global.setInterval = function instrumentedSetInterval(...args) {
        attempts.timer += 1
        return original.setInterval.apply(this, args)
      }
      if (typeof original.fetch === 'function') global.fetch = wrapNetwork(original.fetch)
      http.request = wrapNetwork(original.httpRequest)
      http.get = wrapNetwork(original.httpGet)
      https.request = wrapNetwork(original.httpsRequest)
      https.get = wrapNetwork(original.httpsGet)
      net.connect = wrapNetwork(original.netConnect)
      net.createConnection = wrapNetwork(original.netCreateConnection)
      tls.connect = wrapNetwork(original.tlsConnect)
      Module._load = function instrumentedModuleLoad(request, parent, isMain) {
        if (/^(?:pg|pg-native|postgres|@prisma\/client)(?:\/|$)/.test(request)) attempts.database += 1
        if (/^(?:playwright|playwright-core|puppeteer|puppeteer-core)(?:\/|$)/.test(request)) attempts.chromium += 1
        if (/^(?:@?max-provider|provider-sdk)(?:\/|$)/.test(request)) attempts.provider += 1
        return original.moduleLoad.call(this, request, parent, isMain)
      }
    },
    restore() {
      if (!installed) return
      global.setTimeout = original.setTimeout
      global.setInterval = original.setInterval
      if (typeof original.fetch === 'function') global.fetch = original.fetch
      else delete global.fetch
      http.request = original.httpRequest
      http.get = original.httpGet
      https.request = original.httpsRequest
      https.get = original.httpsGet
      net.connect = original.netConnect
      net.createConnection = original.netCreateConnection
      tls.connect = original.tlsConnect
      Module._load = original.moduleLoad
      installed = false
    },
    snapshot() {
      return { ...attempts }
    },
  }
}

function loadProductDependencies() {
  const { createLiveCaptureAdapterFromEnvironment } = require('/app/capture/LiveCaptureAdapter.js')
  const { TransportInterceptor } = require('/app/transport/TransportInterceptor.js')
  return {
    createDisabledAdapterFromEnvironment: createLiveCaptureAdapterFromEnvironment,
    createActiveAdapterFromEnvironment: createLiveCaptureAdapterFromEnvironment,
    TransportInterceptor,
  }
}

async function drain(adapter, attempts) {
  for (let attempt = 0; attempt < attempts && adapter.getCaptureHealth().spoolPendingCount > 0; attempt += 1) {
    await adapter.drain.drainOnce()
    await sleep(50)
  }
}

async function runHarness(options = {}) {
  const environment = options.environment || process.env
  const mode = selectedHarnessMode(environment)
  const instrumentation = options.instrumentation || createAttemptInstrumentation()
  instrumentation.install()
  try {
    const dependencies = options.dependencies || loadProductDependencies()
    const disabledPath = options.disabledPath || '/tmp/personal-max-stage8b1i-disabled-spool'
    fs.rmSync(disabledPath, { recursive: true, force: true })
    const disabled = dependencies.createDisabledAdapterFromEnvironment({
      MAX_PERSONAL_ACCOUNT_ID: 'stage8b1i-disabled',
      MAX_PERSONAL_CAPTURE_SPOOL_PATH: disabledPath,
    })
    let frameAttemptCount = 0
    const capturePhysicalFrame = disabled.capturePhysicalFrame.bind(disabled)
    disabled.capturePhysicalFrame = (...args) => {
      frameAttemptCount += 1
      return capturePhysicalFrame(...args)
    }
    const disabledInterceptor = new dependencies.TransportInterceptor(disabled)
    disabledInterceptor._handleFrame(JSON.stringify({ kind: 'message', direction: 'inbound', text: 'synthetic' }))
    const disabledHealth = disabled.getCaptureHealth()
    disabledInterceptor.detach()
    let activeAdapterFactoryCallCount = 0

    if (mode === 'default-off') {
      const observed = instrumentation.snapshot()
      return {
        selectedMode: mode,
        adapterEnabled: disabledHealth.enabled,
        frameHandled: frameAttemptCount === 1,
        spoolPathCreated: fs.existsSync(disabledPath),
        spoolPendingCount: disabledHealth.spoolPendingCount,
        timerAttemptCount: observed.timer,
        networkAttemptCount: observed.network,
        databaseAttemptCount: observed.database,
        activeAdapterFactoryCalled: activeAdapterFactoryCallCount > 0,
        drainCreated: disabled.drain != null,
        chromiumLaunched: observed.chromium > 0,
        maxContacted: observed.max > 0,
        providerAction: observed.provider > 0,
      }
    }

    const adapter = (() => {
      activeAdapterFactoryCallCount += 1
      return dependencies.createActiveAdapterFromEnvironment(environment)
    })()
    assert.equal(adapter.getCaptureHealth().enabled, true)
    assert.ok(adapter.drain || mode === 'capture-only')
    const interceptor = new dependencies.TransportInterceptor(adapter)
    const count = Number(environment.STAGE8B1I_FRAME_COUNT || 0)
    const identical = Number(environment.STAGE8B1I_IDENTICAL_COUNT || 0)
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
          kind: 'message', direction: 'inbound', providerMessageId: `stage8b1i-${environment.MAX_PERSONAL_ACCOUNT_ID}-${index}`,
          protocolChatId: `synthetic-${environment.MAX_PERSONAL_ACCOUNT_ID}`, text: `synthetic-${index}`,
        })
        interceptor._handleFrame(raw)
      }
    }

    const capturedHealth = adapter.getCaptureHealth()
    assert.equal(capturedHealth.lostBeforeSpoolCount, 0)
    if (mode === 'capture-only') {
      assert.equal(capturedHealth.spoolPendingCount, count)
    } else {
      await drain(adapter, Number(environment.STAGE8B1I_DRAIN_ATTEMPTS || 80))
    }
    const finalHealth = adapter.getCaptureHealth()
    if (mode !== 'capture-only' && mode !== 'retry-only') assert.equal(finalHealth.spoolPendingCount, 0)
    if (mode === 'retry-only') {
      assert.ok(finalHealth.spoolPendingCount > 0)
      assert.ok(finalHealth.retryCount > 0)
    }
    await interceptor.stopCaptureAndFlush(2000)
    interceptor.detach()
    const observed = instrumentation.snapshot()
    return {
      actualTransportHook: true,
      mode,
      framesCaptured: mode === 'drain-only' || mode === 'retry-only' ? 0 : count,
      identicalFrames: mode === 'drain-only' || mode === 'retry-only' ? 0 : identical,
      pendingBefore: capturedHealth.spoolPendingCount,
      pendingAfter: finalHealth.spoolPendingCount,
      acknowledged: finalHealth.acknowledgedCount,
      retryCount: finalHealth.retryCount,
      lostBeforeSpoolCount: finalHealth.lostBeforeSpoolCount,
      timerAttemptCount: observed.timer,
      networkAttemptCount: observed.network,
      databaseAttemptCount: observed.database,
      activeAdapterFactoryCalled: activeAdapterFactoryCallCount > 0,
      drainCreated: adapter.drain != null,
      chromiumLaunched: observed.chromium > 0,
      maxContacted: observed.max > 0,
      providerAction: observed.provider > 0,
    }
  } finally {
    instrumentation.restore()
  }
}

if (require.main === module) {
  runHarness().then(result => {
    process.stdout.write(`${JSON.stringify(result)}\n`)
  }).catch(error => {
    process.stderr.write(`${JSON.stringify({ code: error?.code || 'SYNTHETIC_HARNESS_FAILED', name: error?.name || 'Error' })}\n`)
    process.exit(1)
  })
}

module.exports = {
  ALLOWED_MODES,
  DEFAULT_OFF_FIELDS,
  createAttemptInstrumentation,
  runHarness,
  selectedHarnessMode,
}
