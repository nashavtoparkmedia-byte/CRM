'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const packageRoot = __dirname
const repositoryRoot = path.resolve(packageRoot, '..', '..')
const scraperRoot = path.join(repositoryRoot, 'max-web-scraper')
const harnessPath = path.join(packageRoot, 'synthetic-scraper-harness.js')
const contractPath = path.join(packageRoot, 'scraper-runtime-contract.js')
const boundedPath = path.join(packageRoot, 'bounded-operations.sh')
const probePath = path.join(packageRoot, 'isolated-release-probe.sh')
const nodeBinary = process.execPath
const {
  ENVELOPE_FIELDS,
  runHarness,
  serializeEnvelope,
} = require(harnessPath)
const { loadRuntimeContract, serializeEnvelope: serializeRuntimeEnvelope } = require(contractPath)

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'personal-max-stage8b1i-real-loader.'))
let passCount = 0
const pass = name => { passCount += 1; process.stdout.write(`${name}=PASS\n`) }

function disabledAdapter(overrides = {}) {
  return {
    enabled: false,
    capturePhysicalFrame() { return { captured: false } },
    getCaptureHealth() { return { enabled: false, spoolPendingCount: 0, lostBeforeSpoolCount: 0 } },
    close() {},
    ...overrides,
  }
}

class FakeInterceptor {
  constructor(adapter) { this.adapter = adapter }
  _handleFrame(raw) { this.adapter.capturePhysicalFrame({ raw, metadata: {} }) }
  getCaptureHealth() { return this.adapter.getCaptureHealth() }
  detach() { console.log('safe suppressed product log') }
}

function dependencies(overrides = {}) {
  return {
    createDisabledAdapterFromEnvironment: () => disabledAdapter(),
    createActiveAdapterFromEnvironment: () => { throw new Error('active factory forbidden') },
    TransportInterceptor: FakeInterceptor,
    ...overrides,
  }
}

async function executeWith(overrides = {}) {
  return runHarness({
    environment: { STAGE8B1I_HARNESS_MODE: 'default-off' },
    dependencies: dependencies(),
    disabledPath: path.join(tempRoot, `disabled-${Math.random().toString(16).slice(2)}`),
    ...overrides,
  })
}

function expectFailure(result, stage, code) {
  assert.equal(result.status, 'FAIL')
  assert.equal(result.failureStage, stage)
  assert.equal(result.failureCode, code)
  const serialized = serializeEnvelope(result)
  const parsed = JSON.parse(serialized)
  assert.equal(parsed.resultSerialized, true)
  return parsed
}

function validatorResult(fixture, functionCall) {
  const target = path.join(tempRoot, `validator-${Math.random().toString(16).slice(2)}.json`)
  fs.writeFileSync(target, `${JSON.stringify(fixture)}\n`, { mode: 0o600 })
  const script = `
    set -uo pipefail
    source "$1"
    PROBE_ERROR_CLASSIFICATION=NONE
    SCRAPER_CHECK_ID=NONE
    SCRAPER_RUNTIME_CONTRACT_VERIFIED=false
    set +e
    ${functionCall}
    status=$?
    set -e
    printf '%s|%s|%s|%s' "$status" "$PROBE_ERROR_CLASSIFICATION" "$SCRAPER_CHECK_ID" "$SCRAPER_ORIGINAL_EXIT"
  `
  const result = spawnSync('bash', ['-c', script, 'bash', boundedPath, target], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout
}

async function main() {
  const real = await runHarness({
    environment: { STAGE8B1I_HARNESS_MODE: 'default-off' },
    appRoot: scraperRoot,
    disabledPath: path.join(tempRoot, 'real-loader-disabled'),
  })
  assert.equal(real.status, 'PASS')
  assert.equal(real.productDependencySource, 'OFFLINE_CHECKOUT_ROOT')
  assert.equal(real.moduleLoadCompleted, true)
  assert.equal(real.frameDispatchCompleted, true)
  assert.equal(real.healthReadCompleted, true)
  assert.equal(real.detachCompleted, true)
  assert.equal(real.instrumentationRestored, true)
  pass('real_checkout_loader_path')

  const missingRoot = path.join(tempRoot, 'missing-live')
  fs.mkdirSync(missingRoot, { recursive: true })
  expectFailure(await runHarness({ environment: { STAGE8B1I_HARNESS_MODE: 'default-off' }, appRoot: missingRoot }),
    'PRODUCT_DEPENDENCY_LOAD', 'LIVE_CAPTURE_MODULE_MISSING')
  pass('missing_live_capture_module')

  const missingTransportRoot = path.join(tempRoot, 'missing-transport')
  fs.mkdirSync(path.join(missingTransportRoot, 'capture'), { recursive: true })
  fs.copyFileSync(path.join(scraperRoot, 'capture', 'LiveCaptureAdapter.js'), path.join(missingTransportRoot, 'capture', 'LiveCaptureAdapter.js'))
  fs.copyFileSync(path.join(scraperRoot, 'capture', 'AuthenticatedCaptureDrain.js'), path.join(missingTransportRoot, 'capture', 'AuthenticatedCaptureDrain.js'))
  expectFailure(await runHarness({ environment: { STAGE8B1I_HARNESS_MODE: 'default-off' }, appRoot: missingTransportRoot }),
    'PRODUCT_DEPENDENCY_LOAD', 'TRANSPORT_INTERCEPTOR_MODULE_MISSING')
  pass('missing_transport_interceptor_module')

  expectFailure(await executeWith({ dependencies: dependencies({ createDisabledAdapterFromEnvironment: null }) }),
    'PRODUCT_DEPENDENCY_LOAD', 'LIVE_CAPTURE_EXPORT_MISSING')
  pass('wrong_export_type')

  expectFailure(await executeWith({ dependencies: dependencies({
    createDisabledAdapterFromEnvironment: () => { throw new Error('private factory failure') },
  }) }), 'DISABLED_ADAPTER_CREATE', 'DISABLED_ADAPTER_CREATE_FAILED')
  pass('disabled_factory_throws')

  expectFailure(await executeWith({ dependencies: dependencies({
    createDisabledAdapterFromEnvironment: () => disabledAdapter({ capturePhysicalFrame: undefined }),
  }) }), 'DISABLED_ADAPTER_CONTRACT', 'CAPTURE_PHYSICAL_FRAME_MISSING')
  pass('capture_method_missing')

  expectFailure(await executeWith({ dependencies: dependencies({
    createDisabledAdapterFromEnvironment: () => disabledAdapter({ getCaptureHealth: undefined }),
  }) }), 'DISABLED_ADAPTER_CONTRACT', 'GET_CAPTURE_HEALTH_MISSING')
  pass('health_method_missing')

  expectFailure(await executeWith({ dependencies: dependencies({
    TransportInterceptor: class { constructor() { throw new Error('private constructor failure') } },
  }) }), 'INTERCEPTOR_CONSTRUCT', 'INTERCEPTOR_CONSTRUCT_FAILED')
  pass('interceptor_constructor_throws')

  expectFailure(await executeWith({ dependencies: dependencies({
    TransportInterceptor: class { getCaptureHealth() {}; detach() {} },
  }) }), 'INTERCEPTOR_CONSTRUCT', 'HANDLE_FRAME_MISSING')
  pass('handle_frame_missing')

  expectFailure(await executeWith({ dependencies: dependencies({
    TransportInterceptor: class { _handleFrame() {}; getCaptureHealth() {} },
  }) }), 'INTERCEPTOR_CONSTRUCT', 'DETACH_MISSING')
  pass('detach_missing')

  expectFailure(await executeWith({ dependencies: dependencies({
    TransportInterceptor: class extends FakeInterceptor { _handleFrame() { throw new Error('private frame') } },
  }) }), 'FRAME_DISPATCH', 'FRAME_DISPATCH_FAILED')
  pass('frame_dispatch_throws')

  expectFailure(await executeWith({ dependencies: dependencies({
    TransportInterceptor: class extends FakeInterceptor { getCaptureHealth() { throw new Error('private health') } },
  }) }), 'HEALTH_READ', 'HEALTH_READ_FAILED')
  pass('health_read_throws')

  expectFailure(await executeWith({ dependencies: dependencies({
    TransportInterceptor: class extends FakeInterceptor { detach() { throw new Error('private detach') } },
  }) }), 'INTERCEPTOR_DETACH', 'DETACH_FAILED')
  pass('detach_throws')

  expectFailure(await executeWith({ instrumentation: {
    install() { throw new Error('private install') }, restore() {}, snapshot: () => ({}),
  } }), 'INSTRUMENTATION_INSTALL', 'INSTRUMENTATION_INSTALL_FAILED')
  pass('instrumentation_install_throws')

  expectFailure(await executeWith({ instrumentation: {
    install() {}, restore() { throw new Error('private restore') },
    snapshot: () => ({ timer: 0, network: 0, database: 0, chromium: 0, max: 0, provider: 0 }),
  } }), 'INSTRUMENTATION_RESTORE', 'INSTRUMENTATION_RESTORE_FAILED')
  pass('instrumentation_restore_throws')

  const polluted = await executeWith({ dependencies: dependencies({
    TransportInterceptor: class extends FakeInterceptor { constructor(adapter) { super(adapter); console.log('private log') } },
  }) })
  assert.equal(polluted.status, 'PASS'); assert.ok(polluted.suppressedLogCount >= 1)
  pass('console_log_suppressed')

  const warned = await executeWith({ dependencies: dependencies({
    TransportInterceptor: class extends FakeInterceptor { constructor(adapter) { super(adapter); console.warn('private warn') } },
  }) })
  assert.equal(warned.status, 'PASS'); assert.equal(warned.suppressedWarnCount, 1)
  pass('console_warn_suppressed')

  const errored = await executeWith({ dependencies: dependencies({
    TransportInterceptor: class extends FakeInterceptor { constructor(adapter) { super(adapter); console.error('private error') } },
  }) })
  assert.equal(errored.status, 'PASS'); assert.equal(errored.suppressedErrorCount, 1)
  pass('console_error_suppressed')

  const oneSerialized = serializeEnvelope(real)
  assert.equal(oneSerialized.trim().split('\n').length, 1)
  assert.equal(Object.keys(JSON.parse(oneSerialized)).length, ENVELOPE_FIELDS.length)
  pass('exactly_one_json_envelope')

  const cliFailure = spawnSync(nodeBinary, [harnessPath], {
    env: { PATH: process.env.PATH, STAGE8B1I_HARNESS_MODE: 'default-off' }, encoding: 'utf8',
  })
  assert.equal(cliFailure.status, 1)
  assert.equal(cliFailure.stdout.trim().split('\n').length, 1)
  assert.equal(JSON.parse(cliFailure.stdout).status, 'FAIL')
  assert.equal(cliFailure.stderr, '')
  pass('failure_envelope_available_exit_one')

  const pinned = { ...real, productDependencySource: 'PINNED_APP_ROOT', resultSerialized: true }
  const unknownCode = { ...pinned, status: 'FAIL', failureStage: 'INTERNAL', failureCode: 'UNKNOWN_PRIVATE_CODE' }
  assert.match(validatorResult(unknownCode, 'pm_validate_scraper_default_off_result "$2"'), /65\|SCRAPER_DEFAULT_OFF_OUTPUT_MALFORMED/)
  pass('unknown_failure_code_rejected')

  assert.match(validatorResult({ ...pinned, unexpected: true }, 'pm_validate_scraper_default_off_result "$2"'), /65\|SCRAPER_DEFAULT_OFF_OUTPUT_MALFORMED/)
  pass('unknown_field_rejected')

  const privateFailure = expectFailure(await executeWith({ dependencies: dependencies({
    createDisabledAdapterFromEnvironment: () => { throw new Error('SECRET_PRIVATE_ERROR_MESSAGE') },
  }) }), 'DISABLED_ADAPTER_CREATE', 'DISABLED_ADAPTER_CREATE_FAILED')
  assert.ok(!JSON.stringify(privateFailure).includes('SECRET_PRIVATE_ERROR_MESSAGE'))
  pass('raw_error_message_absent')

  assert.ok(!Object.prototype.hasOwnProperty.call(privateFailure, 'stack'))
  pass('raw_stack_absent')

  const privateSerialized = JSON.stringify(privateFailure)
  assert.ok(!privateSerialized.includes('process.env'))
  assert.ok(!privateSerialized.includes('DATABASE_URL'))
  pass('environment_absent')

  const runtime = loadRuntimeContract({ appRoot: scraperRoot })
  const pinnedRuntime = {
    ...JSON.parse(serializeRuntimeEnvelope(runtime)),
    appRootCategory: 'PINNED_APP_ROOT', runtimeUid: 1001, runtimeGid: 1001,
  }
  const runtimeCall = 'pm_validate_scraper_runtime_contract "$2" 0 33eb40b87f77eee16fbf4ccd06a667ea4ce51e5a 7b5a8c6b7b9d6020a52bef253c317f90eff070cfbe8ac98aed66381c6bc523a5 1bc464fc8eaf6d9111a6a4ba7eda3a4f4b4fdd63d677f7e620720e9f17889b37 35c979f12d67447d176bac3641fc38eb75fa6a1adc0633e19171a6512e7192f7'
  const sourceMismatch = JSON.parse(JSON.stringify(pinnedRuntime))
  sourceMismatch.moduleFacts.liveCaptureAdapter.sha256 = '0'.repeat(64)
  assert.match(validatorResult(sourceMismatch, runtimeCall), /65\|SCRAPER_RUNTIME_SOURCE_BINDING_MISMATCH/)
  pass('runtime_source_sha_mismatch_blocks')

  const exportMismatch = JSON.parse(JSON.stringify(pinnedRuntime))
  exportMismatch.exportFacts.createLiveCaptureAdapterFromEnvironment = 'undefined'
  assert.match(validatorResult(exportMismatch, runtimeCall), /65\|SCRAPER_RUNTIME_EXPORT_MISSING/)
  pass('runtime_export_mismatch_blocks')

  assert.match(validatorResult(pinnedRuntime, runtimeCall), /^0\|NONE\|SCRAPER_RUNTIME_INTERCEPTOR_CHECK\|0$/)
  pass('exact_accepted_module_ledger_passes')

  const probeSource = fs.readFileSync(probePath, 'utf8')
  assert.match(probeSource, /pm_enter_phase scraper_runtime_contract/)
  assert.match(probeSource, /--network none/)
  assert.match(probeSource, /\$SCRAPER_RUNTIME_CONTRACT_RUNNER:\/tmp\/stage8b1i-runtime-contract\.js:ro/)
  assert.match(probeSource, /SCRAPER_RUNTIME_SOURCE_LEDGER_SHA256/)
  pass('pinned_image_contract_invocation_source')

  assert.equal(real.adapterEnabled, false)
  assert.equal(real.frameHandled, true)
  assert.equal(real.spoolPathCreated, false)
  assert.equal(real.spoolPendingCount, 0)
  assert.equal(real.timerAttemptCount, 0)
  assert.equal(real.networkAttemptCount, 0)
  assert.equal(real.databaseAttemptCount, 0)
  assert.equal(real.activeAdapterFactoryCalled, false)
  assert.equal(real.drainCreated, false)
  assert.equal(real.chromiumLaunched, false)
  assert.equal(real.maxContacted, false)
  assert.equal(real.providerAction, false)
  pass('default_off_semantics_remain_strict')

  assert.equal(passCount, 30)
  process.stdout.write('SCRAPER_REAL_LOADER_TEST_COUNT=30\nREAL_LOADER_EXECUTED=YES\nFAULT_MATRIX_EXECUTED=YES\nDOCKER_EXECUTED=NO\nDATABASE_CONNECTED=NO\n')
}

main().finally(() => fs.rmSync(tempRoot, { recursive: true, force: true })).catch(error => {
  process.stderr.write(`${error.stack || error}\n`)
  process.exit(1)
})
