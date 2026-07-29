'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const PINNED_APP_ROOT = '/app'
const MODULE_NAMES = Object.freeze([
  'capture/LiveCaptureAdapter.js',
  'capture/AuthenticatedCaptureDrain.js',
  'transport/TransportInterceptor.js',
])
const ORIGINAL_STDOUT_WRITE = process.stdout.write.bind(process.stdout)

function safeFailure(stage, code) {
  return Object.assign(new Error(code), { safeStage: stage, safeCode: code })
}

function consoleSuppression() {
  const originals = { log: console.log, warn: console.warn, error: console.error }
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
      console.log = originals.log
      console.warn = originals.warn
      console.error = originals.error
      installed = false
    },
    snapshot: () => ({ ...counts }),
  }
}

function emptyModuleFact() {
  return { regularFile: false, symlink: false, sha256: 'not_observed' }
}

function baseEnvelope(appRootCategory) {
  const nodeMajor = Number(process.versions.node.split('.')[0])
  return {
    schemaVersion: 1,
    status: 'FAIL',
    failureStage: 'INTERNAL',
    failureCode: 'RUNTIME_INTERNAL_FAILURE',
    appRootCategory,
    nodeVersionCategory: Number.isSafeInteger(nodeMajor) && nodeMajor >= 20 && nodeMajor <= 24
      ? 'SUPPORTED_NODE_MAJOR'
      : 'UNSUPPORTED_NODE_MAJOR',
    nodeMajor: Number.isSafeInteger(nodeMajor) ? nodeMajor : 0,
    runtimeUid: typeof process.getuid === 'function' ? process.getuid() : -1,
    runtimeGid: typeof process.getgid === 'function' ? process.getgid() : -1,
    moduleLoadCompleted: false,
    moduleFacts: {
      liveCaptureAdapter: emptyModuleFact(),
      authenticatedCaptureDrain: emptyModuleFact(),
      transportInterceptor: emptyModuleFact(),
    },
    exportFacts: {
      createLiveCaptureAdapterFromEnvironment: 'not_observed',
      TransportInterceptor: 'not_observed',
    },
    disabledAdapterFacts: {
      objectCreated: false,
      capturePhysicalFrameCallable: false,
      getCaptureHealthCallable: false,
      enabledFalse: false,
    },
    interceptorFacts: {
      constructed: false,
      handleFrameCallable: false,
      getCaptureHealthCallable: false,
      detachCallable: false,
      detached: false,
    },
    suppressedLogCount: 0,
    suppressedWarnCount: 0,
    suppressedErrorCount: 0,
    sourceContentsCaptured: false,
    environmentCaptured: false,
    profileDataCaptured: false,
    persistedMessageContentsCaptured: false,
    resultSerialized: false,
  }
}

function moduleFact(target) {
  let metadata
  try {
    metadata = fs.lstatSync(target)
  } catch (error) {
    if (error && error.code === 'ENOENT') throw safeFailure('SOURCE_METADATA', 'RUNTIME_MODULE_MISSING')
    throw safeFailure('SOURCE_METADATA', 'RUNTIME_MODULE_METADATA_FAILED')
  }
  if (metadata.isSymbolicLink()) throw safeFailure('SOURCE_METADATA', 'RUNTIME_MODULE_SYMLINK')
  if (!metadata.isFile()) throw safeFailure('SOURCE_METADATA', 'RUNTIME_MODULE_NOT_REGULAR')
  return {
    regularFile: true,
    symlink: false,
    sha256: crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex'),
  }
}

function loadRuntimeContract(options = {}) {
  const appRoot = options.appRoot || PINNED_APP_ROOT
  const appRootCategory = appRoot === PINNED_APP_ROOT ? 'PINNED_APP_ROOT' : 'OFFLINE_CHECKOUT_ROOT'
  const result = baseEnvelope(appRootCategory)
  const suppression = options.consoleSuppression || consoleSuppression()
  let interceptor = null
  try {
    suppression.install()
    const targets = MODULE_NAMES.map(name => path.join(appRoot, name))
    result.moduleFacts.liveCaptureAdapter = moduleFact(targets[0])
    result.moduleFacts.authenticatedCaptureDrain = moduleFact(targets[1])
    result.moduleFacts.transportInterceptor = moduleFact(targets[2])

    let liveCaptureModule
    let transportModule
    try {
      liveCaptureModule = require(targets[0])
      transportModule = require(targets[2])
    } catch {
      throw safeFailure('MODULE_LOAD', 'RUNTIME_MODULE_LOAD_FAILED')
    }
    result.moduleLoadCompleted = true
    result.exportFacts.createLiveCaptureAdapterFromEnvironment = typeof liveCaptureModule.createLiveCaptureAdapterFromEnvironment
    result.exportFacts.TransportInterceptor = typeof transportModule.TransportInterceptor
    if (result.exportFacts.createLiveCaptureAdapterFromEnvironment !== 'function'
      || result.exportFacts.TransportInterceptor !== 'function') {
      throw safeFailure('EXPORT_CONTRACT', 'RUNTIME_EXPORT_MISSING')
    }

    let disabled
    try {
      disabled = liveCaptureModule.createLiveCaptureAdapterFromEnvironment({
        MAX_PERSONAL_ACCOUNT_ID: 'stage8b1i-runtime-contract-disabled',
      })
    } catch {
      throw safeFailure('DISABLED_ADAPTER_CONTRACT', 'RUNTIME_DISABLED_ADAPTER_CREATE_FAILED')
    }
    result.disabledAdapterFacts.objectCreated = disabled !== null && typeof disabled === 'object'
    result.disabledAdapterFacts.capturePhysicalFrameCallable = typeof disabled?.capturePhysicalFrame === 'function'
    result.disabledAdapterFacts.getCaptureHealthCallable = typeof disabled?.getCaptureHealth === 'function'
    if (!result.disabledAdapterFacts.objectCreated
      || !result.disabledAdapterFacts.capturePhysicalFrameCallable
      || !result.disabledAdapterFacts.getCaptureHealthCallable) {
      throw safeFailure('DISABLED_ADAPTER_CONTRACT', 'RUNTIME_DISABLED_ADAPTER_INVALID')
    }
    let health
    try { health = disabled.getCaptureHealth() } catch {
      throw safeFailure('DISABLED_ADAPTER_CONTRACT', 'RUNTIME_DISABLED_ADAPTER_HEALTH_FAILED')
    }
    result.disabledAdapterFacts.enabledFalse = health?.enabled === false
    if (!result.disabledAdapterFacts.enabledFalse) {
      throw safeFailure('DISABLED_ADAPTER_CONTRACT', 'RUNTIME_DISABLED_ADAPTER_ENABLED')
    }

    try { interceptor = new transportModule.TransportInterceptor(disabled) } catch {
      throw safeFailure('INTERCEPTOR_CONTRACT', 'RUNTIME_INTERCEPTOR_CONSTRUCT_FAILED')
    }
    result.interceptorFacts.constructed = true
    result.interceptorFacts.handleFrameCallable = typeof interceptor?._handleFrame === 'function'
    result.interceptorFacts.getCaptureHealthCallable = typeof interceptor?.getCaptureHealth === 'function'
    result.interceptorFacts.detachCallable = typeof interceptor?.detach === 'function'
    if (!result.interceptorFacts.handleFrameCallable
      || !result.interceptorFacts.getCaptureHealthCallable
      || !result.interceptorFacts.detachCallable) {
      throw safeFailure('INTERCEPTOR_CONTRACT', 'RUNTIME_INTERCEPTOR_INVALID')
    }
    try {
      interceptor.detach()
      result.interceptorFacts.detached = true
      interceptor = null
    } catch {
      throw safeFailure('DETACH', 'RUNTIME_INTERCEPTOR_DETACH_FAILED')
    }
    result.status = 'PASS'
    result.failureStage = 'NONE'
    result.failureCode = 'NONE'
  } catch (error) {
    result.status = 'FAIL'
    result.failureStage = error?.safeStage || 'INTERNAL'
    result.failureCode = error?.safeCode || 'RUNTIME_INTERNAL_FAILURE'
  } finally {
    if (interceptor && typeof interceptor.detach === 'function') {
      try {
        interceptor.detach()
        result.interceptorFacts.detached = true
      } catch {}
    }
    const counts = suppression.snapshot()
    result.suppressedLogCount = counts.log
    result.suppressedWarnCount = counts.warn
    result.suppressedErrorCount = counts.error
    try { suppression.restore() } catch {
      if (result.status === 'PASS') {
        result.status = 'FAIL'
        result.failureStage = 'INTERNAL'
        result.failureCode = 'RUNTIME_CONSOLE_RESTORE_FAILED'
      }
    }
  }
  return result
}

function serializeEnvelope(envelope) {
  return JSON.stringify({ ...envelope, resultSerialized: true })
}

function emergencySerializationEnvelope(appRootCategory) {
  const value = baseEnvelope(appRootCategory)
  value.failureStage = 'RESULT_SERIALIZATION'
  value.failureCode = 'RUNTIME_RESULT_SERIALIZATION_FAILED'
  value.resultSerialized = true
  return JSON.stringify(value)
}

if (require.main === module) {
  let result
  let serialized
  try {
    result = loadRuntimeContract()
    serialized = serializeEnvelope(result)
  } catch {
    serialized = emergencySerializationEnvelope('PINNED_APP_ROOT')
    result = { status: 'FAIL' }
  }
  ORIGINAL_STDOUT_WRITE(`${serialized}\n`)
  process.exitCode = result.status === 'PASS' ? 0 : 1
}

module.exports = {
  MODULE_NAMES,
  PINNED_APP_ROOT,
  baseEnvelope,
  consoleSuppression,
  loadRuntimeContract,
  serializeEnvelope,
}
