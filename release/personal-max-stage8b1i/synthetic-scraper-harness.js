'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const https = require('node:https')
const net = require('node:net')
const tls = require('node:tls')
const Module = require('node:module')

const PINNED_APP_ROOT = '/app'
const ALLOWED_MODES = new Set(['default-off', 'capture-only', 'retry-only', 'capture-and-drain', 'drain-only'])
const FAILURE_STAGES = new Set([
  'NONE', 'MODE_SELECTION', 'INSTRUMENTATION_INSTALL', 'PRODUCT_DEPENDENCY_LOAD',
  'DISABLED_ADAPTER_CREATE', 'DISABLED_ADAPTER_CONTRACT', 'INTERCEPTOR_CONSTRUCT',
  'FRAME_DISPATCH', 'HEALTH_READ', 'INTERCEPTOR_DETACH', 'ACTIVE_ADAPTER_CREATE',
  'ACTIVE_EXECUTION', 'INSTRUMENTATION_RESTORE', 'RESULT_SERIALIZATION', 'INTERNAL',
])
const FAILURE_CODES = new Set([
  'NONE', 'MODE_MISSING', 'MODE_INVALID', 'INSTRUMENTATION_INSTALL_FAILED',
  'LIVE_CAPTURE_MODULE_MISSING', 'TRANSPORT_INTERCEPTOR_MODULE_MISSING',
  'PRODUCT_DEPENDENCY_LOAD_FAILED', 'LIVE_CAPTURE_EXPORT_MISSING', 'TRANSPORT_INTERCEPTOR_EXPORT_MISSING',
  'DISABLED_ADAPTER_CREATE_FAILED', 'CAPTURE_PHYSICAL_FRAME_MISSING', 'GET_CAPTURE_HEALTH_MISSING',
  'INTERCEPTOR_CONSTRUCT_FAILED', 'HANDLE_FRAME_MISSING', 'INTERCEPTOR_HEALTH_MISSING',
  'DETACH_MISSING', 'FRAME_DISPATCH_FAILED', 'HEALTH_READ_FAILED', 'DETACH_FAILED',
  'ACTIVE_ADAPTER_CREATE_FAILED', 'ACTIVE_ADAPTER_INVALID', 'ACTIVE_EXECUTION_FAILED',
  'INSTRUMENTATION_RESTORE_FAILED', 'CONSOLE_RESTORE_FAILED', 'RESULT_SERIALIZATION_FAILED',
  'INTERNAL_FAILURE',
])
const ENVELOPE_FIELDS = Object.freeze([
  'schemaVersion', 'status', 'selectedMode', 'failureStage', 'failureCode',
  'productDependencySource', 'moduleLoadCompleted', 'liveCaptureExportType', 'transportInterceptorExportType',
  'instrumentationInstalled', 'instrumentationRestored', 'disabledFactoryCalled', 'disabledAdapterCreated',
  'capturePhysicalFrameCallable', 'getCaptureHealthCallable', 'interceptorConstructed',
  'frameDispatchAttempted', 'frameDispatchCompleted', 'healthReadCompleted', 'detachCompleted', 'resultSerialized',
  'suppressedLogCount', 'suppressedWarnCount', 'suppressedErrorCount',
  'adapterEnabled', 'frameHandled', 'spoolPathCreated', 'spoolPendingCount',
  'timerAttemptCount', 'networkAttemptCount', 'databaseAttemptCount', 'activeAdapterFactoryCalled',
  'drainCreated', 'chromiumLaunched', 'maxContacted', 'providerAction',
  'actualTransportHook', 'framesCaptured', 'identicalFrames', 'pendingBefore', 'pendingAfter',
  'acknowledged', 'retryCount', 'lostBeforeSpoolCount',
])
const DEFAULT_OFF_FIELDS = ENVELOPE_FIELDS
const ORIGINAL_STDOUT_WRITE = process.stdout.write.bind(process.stdout)
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

function harnessError(stage, code) {
  return Object.assign(new Error(code), { code, safeStage: stage, safeCode: code })
}

function selectedHarnessMode(environment) {
  const raw = environment.STAGE8B1I_HARNESS_MODE
  if (typeof raw !== 'string' || raw.length === 0) throw harnessError('MODE_SELECTION', 'MODE_MISSING')
  if (!ALLOWED_MODES.has(raw)) throw harnessError('MODE_SELECTION', 'MODE_INVALID')
  return raw
}

function baseEnvelope() {
  return {
    schemaVersion: 1,
    status: 'FAIL',
    selectedMode: 'NOT_SELECTED',
    failureStage: 'INTERNAL',
    failureCode: 'INTERNAL_FAILURE',
    productDependencySource: 'NOT_LOADED',
    moduleLoadCompleted: false,
    liveCaptureExportType: 'not_observed',
    transportInterceptorExportType: 'not_observed',
    instrumentationInstalled: false,
    instrumentationRestored: false,
    disabledFactoryCalled: false,
    disabledAdapterCreated: false,
    capturePhysicalFrameCallable: false,
    getCaptureHealthCallable: false,
    interceptorConstructed: false,
    frameDispatchAttempted: false,
    frameDispatchCompleted: false,
    healthReadCompleted: false,
    detachCompleted: false,
    resultSerialized: false,
    suppressedLogCount: 0,
    suppressedWarnCount: 0,
    suppressedErrorCount: 0,
    adapterEnabled: false,
    frameHandled: false,
    spoolPathCreated: false,
    spoolPendingCount: 0,
    timerAttemptCount: 0,
    networkAttemptCount: 0,
    databaseAttemptCount: 0,
    activeAdapterFactoryCalled: false,
    drainCreated: false,
    chromiumLaunched: false,
    maxContacted: false,
    providerAction: false,
    actualTransportHook: false,
    framesCaptured: 0,
    identicalFrames: 0,
    pendingBefore: 0,
    pendingAfter: 0,
    acknowledged: 0,
    retryCount: 0,
    lostBeforeSpoolCount: 0,
  }
}

function createConsoleSuppression() {
  const original = { log: console.log, warn: console.warn, error: console.error }
  const counts = { log: 0, warn: 0, error: 0 }
  let installed = false
  return {
    install() {
      installed = true
      console.log = () => { counts.log += 1 }
      console.warn = () => { counts.warn += 1 }
      console.error = () => { counts.error += 1 }
    },
    restore() {
      if (!installed) return
      console.log = original.log
      console.warn = original.warn
      console.error = original.error
      installed = false
    },
    snapshot: () => ({ ...counts }),
  }
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
  const attempts = { timer: 0, network: 0, database: 0, chromium: 0, max: 0, provider: 0 }
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
  const restore = () => {
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
  }
  return {
    install() {
      if (installed) throw harnessError('INSTRUMENTATION_INSTALL', 'INSTRUMENTATION_INSTALL_FAILED')
      try {
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
      } catch {
        try { restore() } catch {}
        throw harnessError('INSTRUMENTATION_INSTALL', 'INSTRUMENTATION_INSTALL_FAILED')
      }
    },
    restore() { if (installed) restore() },
    snapshot: () => ({ ...attempts }),
  }
}

function loadProductDependencies(appRoot = PINNED_APP_ROOT) {
  const livePath = path.join(appRoot, 'capture', 'LiveCaptureAdapter.js')
  const transportPath = path.join(appRoot, 'transport', 'TransportInterceptor.js')
  if (!fs.existsSync(livePath)) throw harnessError('PRODUCT_DEPENDENCY_LOAD', 'LIVE_CAPTURE_MODULE_MISSING')
  if (!fs.existsSync(transportPath)) throw harnessError('PRODUCT_DEPENDENCY_LOAD', 'TRANSPORT_INTERCEPTOR_MODULE_MISSING')
  let liveCaptureModule
  let transportModule
  try {
    liveCaptureModule = require(livePath)
    transportModule = require(transportPath)
  } catch {
    throw harnessError('PRODUCT_DEPENDENCY_LOAD', 'PRODUCT_DEPENDENCY_LOAD_FAILED')
  }
  if (typeof liveCaptureModule.createLiveCaptureAdapterFromEnvironment !== 'function') {
    throw harnessError('PRODUCT_DEPENDENCY_LOAD', 'LIVE_CAPTURE_EXPORT_MISSING')
  }
  if (typeof transportModule.TransportInterceptor !== 'function') {
    throw harnessError('PRODUCT_DEPENDENCY_LOAD', 'TRANSPORT_INTERCEPTOR_EXPORT_MISSING')
  }
  return {
    createDisabledAdapterFromEnvironment: liveCaptureModule.createLiveCaptureAdapterFromEnvironment,
    createActiveAdapterFromEnvironment: liveCaptureModule.createLiveCaptureAdapterFromEnvironment,
    TransportInterceptor: transportModule.TransportInterceptor,
  }
}

async function drain(adapter, attempts) {
  for (let attempt = 0; attempt < attempts && adapter.getCaptureHealth().spoolPendingCount > 0; attempt += 1) {
    await adapter.drain.drainOnce()
    await sleep(50)
  }
}

function markFailure(result, error) {
  if (result.status === 'FAIL' && result.failureCode !== 'INTERNAL_FAILURE') return
  result.status = 'FAIL'
  result.failureStage = FAILURE_STAGES.has(error?.safeStage) ? error.safeStage : 'INTERNAL'
  result.failureCode = FAILURE_CODES.has(error?.safeCode) ? error.safeCode : 'INTERNAL_FAILURE'
}

async function runHarness(options = {}) {
  const environment = options.environment || process.env
  const result = baseEnvelope()
  const instrumentation = options.instrumentation || createAttemptInstrumentation()
  const suppression = options.consoleSuppression || createConsoleSuppression()
  let interceptor = null
  let instrumentationAttempted = false
  let suppressionInstalled = false
  try {
    result.selectedMode = selectedHarnessMode(environment)
    suppression.install()
    suppressionInstalled = true
    instrumentationAttempted = true
    try {
      instrumentation.install()
      result.instrumentationInstalled = true
    } catch {
      throw harnessError('INSTRUMENTATION_INSTALL', 'INSTRUMENTATION_INSTALL_FAILED')
    }

    let dependencies
    if (options.dependencies) {
      dependencies = options.dependencies
      result.productDependencySource = 'INJECTED_TEST_DEPENDENCIES'
    } else {
      const appRoot = options.appRoot || PINNED_APP_ROOT
      result.productDependencySource = appRoot === PINNED_APP_ROOT ? 'PINNED_APP_ROOT' : 'OFFLINE_CHECKOUT_ROOT'
      dependencies = loadProductDependencies(appRoot)
    }
    result.liveCaptureExportType = typeof dependencies.createDisabledAdapterFromEnvironment
    result.transportInterceptorExportType = typeof dependencies.TransportInterceptor
    if (result.liveCaptureExportType !== 'function') {
      throw harnessError('PRODUCT_DEPENDENCY_LOAD', 'LIVE_CAPTURE_EXPORT_MISSING')
    }
    if (result.transportInterceptorExportType !== 'function') {
      throw harnessError('PRODUCT_DEPENDENCY_LOAD', 'TRANSPORT_INTERCEPTOR_EXPORT_MISSING')
    }
    result.moduleLoadCompleted = true

    const disabledPath = options.disabledPath || '/tmp/personal-max-stage8b1i-disabled-spool'
    fs.rmSync(disabledPath, { recursive: true, force: true })
    let disabled
    result.disabledFactoryCalled = true
    try {
      disabled = dependencies.createDisabledAdapterFromEnvironment({
        MAX_PERSONAL_ACCOUNT_ID: 'stage8b1i-disabled',
        MAX_PERSONAL_CAPTURE_SPOOL_PATH: disabledPath,
      })
    } catch {
      throw harnessError('DISABLED_ADAPTER_CREATE', 'DISABLED_ADAPTER_CREATE_FAILED')
    }
    result.disabledAdapterCreated = disabled !== null && typeof disabled === 'object'
    result.capturePhysicalFrameCallable = typeof disabled?.capturePhysicalFrame === 'function'
    result.getCaptureHealthCallable = typeof disabled?.getCaptureHealth === 'function'
    if (!result.capturePhysicalFrameCallable) {
      throw harnessError('DISABLED_ADAPTER_CONTRACT', 'CAPTURE_PHYSICAL_FRAME_MISSING')
    }
    if (!result.getCaptureHealthCallable) {
      throw harnessError('DISABLED_ADAPTER_CONTRACT', 'GET_CAPTURE_HEALTH_MISSING')
    }
    let frameAttemptCount = 0
    const capturePhysicalFrame = disabled.capturePhysicalFrame.bind(disabled)
    disabled.capturePhysicalFrame = (...args) => {
      frameAttemptCount += 1
      return capturePhysicalFrame(...args)
    }

    try {
      interceptor = new dependencies.TransportInterceptor(disabled)
      result.interceptorConstructed = true
    } catch {
      throw harnessError('INTERCEPTOR_CONSTRUCT', 'INTERCEPTOR_CONSTRUCT_FAILED')
    }
    if (typeof interceptor?._handleFrame !== 'function') {
      throw harnessError('INTERCEPTOR_CONSTRUCT', 'HANDLE_FRAME_MISSING')
    }
    if (typeof interceptor?.getCaptureHealth !== 'function') {
      throw harnessError('INTERCEPTOR_CONSTRUCT', 'INTERCEPTOR_HEALTH_MISSING')
    }
    if (typeof interceptor?.detach !== 'function') {
      throw harnessError('INTERCEPTOR_CONSTRUCT', 'DETACH_MISSING')
    }
    result.frameDispatchAttempted = true
    try {
      interceptor._handleFrame(JSON.stringify({ kind: 'message', direction: 'inbound', text: 'synthetic' }))
      result.frameDispatchCompleted = true
    } catch {
      throw harnessError('FRAME_DISPATCH', 'FRAME_DISPATCH_FAILED')
    }
    let disabledHealth
    try {
      disabledHealth = interceptor.getCaptureHealth()
      result.healthReadCompleted = true
    } catch {
      throw harnessError('HEALTH_READ', 'HEALTH_READ_FAILED')
    }
    try {
      interceptor.detach()
      interceptor = null
      result.detachCompleted = true
    } catch {
      throw harnessError('INTERCEPTOR_DETACH', 'DETACH_FAILED')
    }

    result.adapterEnabled = disabledHealth.enabled
    result.frameHandled = frameAttemptCount === 1
    result.spoolPathCreated = fs.existsSync(disabledPath)
    result.spoolPendingCount = disabledHealth.spoolPendingCount
    result.drainCreated = disabled.drain != null
    result.actualTransportHook = result.frameDispatchCompleted

    if (result.selectedMode !== 'default-off') {
      let adapter
      result.activeAdapterFactoryCalled = true
      try { adapter = dependencies.createActiveAdapterFromEnvironment(environment) } catch {
        throw harnessError('ACTIVE_ADAPTER_CREATE', 'ACTIVE_ADAPTER_CREATE_FAILED')
      }
      if (adapter?.getCaptureHealth?.().enabled !== true || (!adapter.drain && result.selectedMode !== 'capture-only')) {
        throw harnessError('ACTIVE_ADAPTER_CREATE', 'ACTIVE_ADAPTER_INVALID')
      }
      try {
        interceptor = new dependencies.TransportInterceptor(adapter)
        const count = Number(environment.STAGE8B1I_FRAME_COUNT || 0)
        const identical = Number(environment.STAGE8B1I_IDENTICAL_COUNT || 0)
        assert.ok(Number.isSafeInteger(count) && count >= 0 && count <= 1000)
        assert.ok(Number.isSafeInteger(identical) && identical >= 0 && identical <= count)
        if (result.selectedMode !== 'drain-only' && result.selectedMode !== 'retry-only') {
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
              kind: 'message', direction: 'inbound',
              providerMessageId: `stage8b1i-${environment.MAX_PERSONAL_ACCOUNT_ID}-${index}`,
              protocolChatId: `synthetic-${environment.MAX_PERSONAL_ACCOUNT_ID}`, text: `synthetic-${index}`,
            })
            interceptor._handleFrame(raw)
          }
        }
        const capturedHealth = adapter.getCaptureHealth()
        assert.equal(capturedHealth.lostBeforeSpoolCount, 0)
        if (result.selectedMode === 'capture-only') assert.equal(capturedHealth.spoolPendingCount, count)
        else await drain(adapter, Number(environment.STAGE8B1I_DRAIN_ATTEMPTS || 80))
        const finalHealth = adapter.getCaptureHealth()
        if (result.selectedMode !== 'capture-only' && result.selectedMode !== 'retry-only') {
          assert.equal(finalHealth.spoolPendingCount, 0)
        }
        if (result.selectedMode === 'retry-only') {
          assert.ok(finalHealth.spoolPendingCount > 0)
          assert.ok(finalHealth.retryCount > 0)
        }
        await interceptor.stopCaptureAndFlush(2000)
        interceptor.detach()
        interceptor = null
        result.actualTransportHook = true
        result.framesCaptured = result.selectedMode === 'drain-only' || result.selectedMode === 'retry-only' ? 0 : count
        result.identicalFrames = result.selectedMode === 'drain-only' || result.selectedMode === 'retry-only' ? 0 : identical
        result.pendingBefore = capturedHealth.spoolPendingCount
        result.pendingAfter = finalHealth.spoolPendingCount
        result.acknowledged = finalHealth.acknowledgedCount
        result.retryCount = finalHealth.retryCount
        result.lostBeforeSpoolCount = finalHealth.lostBeforeSpoolCount
      } catch (error) {
        if (error?.safeStage) throw error
        throw harnessError('ACTIVE_EXECUTION', 'ACTIVE_EXECUTION_FAILED')
      }
    }
    result.status = 'PASS'
    result.failureStage = 'NONE'
    result.failureCode = 'NONE'
  } catch (error) {
    markFailure(result, error)
  } finally {
    if (interceptor && typeof interceptor.detach === 'function') {
      try {
        interceptor.detach()
        result.detachCompleted = true
      } catch (error) {
        markFailure(result, harnessError('INTERCEPTOR_DETACH', 'DETACH_FAILED'))
      }
    }
    const attempts = typeof instrumentation.snapshot === 'function'
      ? instrumentation.snapshot()
      : { timer: 0, network: 0, database: 0, chromium: 0, max: 0, provider: 0 }
    result.timerAttemptCount = attempts.timer || 0
    result.networkAttemptCount = attempts.network || 0
    result.databaseAttemptCount = attempts.database || 0
    result.chromiumLaunched = (attempts.chromium || 0) > 0
    result.maxContacted = (attempts.max || 0) > 0
    result.providerAction = (attempts.provider || 0) > 0
    if (instrumentationAttempted) {
      try {
        instrumentation.restore()
        result.instrumentationRestored = true
      } catch {
        markFailure(result, harnessError('INSTRUMENTATION_RESTORE', 'INSTRUMENTATION_RESTORE_FAILED'))
      }
    }
    const suppressed = suppressionInstalled && typeof suppression.snapshot === 'function'
      ? suppression.snapshot()
      : { log: 0, warn: 0, error: 0 }
    result.suppressedLogCount = suppressed.log || 0
    result.suppressedWarnCount = suppressed.warn || 0
    result.suppressedErrorCount = suppressed.error || 0
    if (suppressionInstalled) {
      try { suppression.restore() } catch {
        markFailure(result, harnessError('INTERNAL', 'CONSOLE_RESTORE_FAILED'))
      }
    }
  }
  return result
}

function serializeEnvelope(envelope) {
  const value = { ...envelope, resultSerialized: true }
  if (!FAILURE_STAGES.has(value.failureStage) || !FAILURE_CODES.has(value.failureCode)) {
    throw harnessError('RESULT_SERIALIZATION', 'RESULT_SERIALIZATION_FAILED')
  }
  if (Object.keys(value).join('|') !== ENVELOPE_FIELDS.join('|')) {
    throw harnessError('RESULT_SERIALIZATION', 'RESULT_SERIALIZATION_FAILED')
  }
  return JSON.stringify(value)
}

function emergencySerializationEnvelope(selectedMode = 'NOT_SELECTED') {
  const value = baseEnvelope()
  value.selectedMode = ALLOWED_MODES.has(selectedMode) ? selectedMode : 'NOT_SELECTED'
  value.failureStage = 'RESULT_SERIALIZATION'
  value.failureCode = 'RESULT_SERIALIZATION_FAILED'
  value.resultSerialized = true
  return JSON.stringify(value)
}

if (require.main === module) {
  ;(async () => {
    let result
    let serialized
    try {
      result = await runHarness()
      serialized = serializeEnvelope(result)
    } catch {
      serialized = emergencySerializationEnvelope(result?.selectedMode)
      result = { status: 'FAIL' }
    }
    ORIGINAL_STDOUT_WRITE(`${serialized}\n`)
    process.exitCode = result.status === 'PASS' ? 0 : 1
  })()
}

module.exports = {
  ALLOWED_MODES,
  DEFAULT_OFF_FIELDS,
  ENVELOPE_FIELDS,
  FAILURE_CODES,
  FAILURE_STAGES,
  PINNED_APP_ROOT,
  baseEnvelope,
  createAttemptInstrumentation,
  createConsoleSuppression,
  loadProductDependencies,
  runHarness,
  selectedHarnessMode,
  serializeEnvelope,
}
