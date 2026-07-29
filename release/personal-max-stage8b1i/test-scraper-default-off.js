'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const packageRoot = __dirname
const repositoryRoot = path.resolve(packageRoot, '..', '..')
const harnessPath = path.join(packageRoot, 'synthetic-scraper-harness.js')
const probePath = path.join(packageRoot, 'isolated-release-probe.sh')
const boundedPath = path.join(packageRoot, 'bounded-operations.sh')
const { createLiveCaptureAdapterFromEnvironment } = require(path.join(repositoryRoot, 'max-web-scraper/capture/LiveCaptureAdapter.js'))
const { TransportInterceptor } = require(path.join(repositoryRoot, 'max-web-scraper/transport/TransportInterceptor.js'))
const { DEFAULT_OFF_FIELDS, runHarness, selectedHarnessMode, serializeEnvelope } = require(harnessPath)

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'personal-max-stage8b1i-default-off.'))
let passCount = 0
const pass = name => {
  passCount += 1
  process.stdout.write(`${name}=PASS\n`)
}

function expectCode(fn, code) {
  assert.throws(fn, error => error && error.code === code)
}

function validateFixture(name, value, expectedClassification = 'NONE') {
  const target = path.join(tempRoot, `${name}.json`)
  if (value !== undefined) fs.writeFileSync(target, typeof value === 'string' ? value : `${JSON.stringify(value)}\n`, { mode: 0o600 })
  const shell = `
    set -uo pipefail
    source "$1"
    PROBE_ERROR_CLASSIFICATION=NONE
    SCRAPER_CHECK_ID=NONE
    set +e
    pm_validate_scraper_default_off_result "$2"
    status=$?
    set -e
    printf '%s|%s|%s|%s' "$status" "$PROBE_ERROR_CLASSIFICATION" "$SCRAPER_CHECK_ID" "$SCRAPER_ORIGINAL_EXIT"
  `
  const result = spawnSync('bash', ['-c', shell, 'bash', boundedPath, target], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  const [status, classification, checkId, originalExit] = result.stdout.split('|')
  assert.equal(checkId, 'SCRAPER_DEFAULT_OFF_RESULT_CHECK')
  assert.equal(classification, expectedClassification)
  assert.equal(status, expectedClassification === 'NONE' ? '0' : '65')
  assert.equal(originalExit, expectedClassification === 'NONE' ? '0' : '65')
}

function invocationBlocks(probeSource) {
  const lines = probeSource.split('\n')
  const mounts = lines.map((line, index) => line.includes('$SYNTHETIC_SCRAPER_HARNESS_RUNNER:/tmp/stage8b1i-harness.js:ro') ? index : -1)
    .filter(index => index >= 0)
  return mounts.map(index => {
    let start = index
    while (start > 0 && !lines[start].includes('pm_write_bounded')) start -= 1
    let end = index
    while (end < lines.length && !lines[end].includes('/tmp/stage8b1i-harness.js')) end += 1
    return lines.slice(start, end + 1).join('\n')
  })
}

function blockByName(blocks, name) {
  const block = blocks.find(candidate => candidate.includes(name))
  assert.ok(block, `missing invocation block ${name}`)
  return block
}

async function main() {
  const probeSource = fs.readFileSync(probePath, 'utf8')
  const blocks = invocationBlocks(probeSource)
  const observed = await runHarness({
    environment: { STAGE8B1I_HARNESS_MODE: 'default-off' },
    appRoot: path.join(repositoryRoot, 'max-web-scraper'),
    disabledPath: path.join(tempRoot, 'disabled-spool'),
  })
  const pinnedObserved = { ...observed, productDependencySource: 'PINNED_APP_ROOT', resultSerialized: true }

  assert.equal(observed.status, 'PASS')
  assert.equal(observed.selectedMode, 'default-off')
  validateFixture('accepted', pinnedObserved)
  pass('explicit_default_off_mode_succeeds')

  expectCode(() => selectedHarnessMode({}), 'MODE_MISSING')
  pass('missing_mode_rejected')

  expectCode(() => selectedHarnessMode({ STAGE8B1I_HARNESS_MODE: 'capture' }), 'MODE_INVALID')
  pass('wrong_mode_rejected')

  assert.match(probeSource, /readonly DEFAULT_OFF_HARNESS_MODE='default-off'/)
  assert.match(blockByName(blocks, 'scraper-default-off'), /-e STAGE8B1I_HARNESS_MODE="\$DEFAULT_OFF_HARNESS_MODE"/)
  pass('probe_exact_default_off_binding')

  assert.equal(blocks.length, 5)
  const expectedModes = ['default-off', 'capture-only', 'retry-only', 'capture-and-drain', 'drain-only']
  const modes = blocks.map(block => {
    if (block.includes('DEFAULT_OFF_HARNESS_MODE')) return 'default-off'
    return block.match(/STAGE8B1I_HARNESS_MODE=([a-z-]+)/)?.[1]
  })
  assert.deepEqual(modes.sort(), expectedModes.sort())
  const defaultOff = blockByName(blocks, 'scraper-default-off')
  assert.match(defaultOff, /--network none/)
  for (const forbidden of ['MAX_PERSONAL_ACCOUNT_ID', 'MAX_PERSONAL_LIVE_CAPTURE_ENABLED', 'MAX_PERSONAL_CAPTURE_SPOOL_PATH', 'MAX_PERSONAL_CAPTURE_INGRESS_URL', '--env-file', '$SPOOL_VOLUME:/spool']) {
    assert.ok(!defaultOff.includes(forbidden), `default-off contains ${forbidden}`)
  }
  const captureA = blockByName(blocks, 'scraper-capture-a')
  assert.match(captureA, /--network none/)
  assert.match(captureA, /MAX_PERSONAL_ACCOUNT_ID="\$ACCOUNT_A"/)
  assert.match(captureA, /MAX_PERSONAL_LIVE_CAPTURE_ENABLED="\$ACCOUNT_A"/)
  assert.match(captureA, /MAX_PERSONAL_CAPTURE_SPOOL_PATH=\/spool\/account-a/)
  assert.match(captureA, /STAGE8B1I_HARNESS_MODE=capture-only/)
  assert.match(captureA, /STAGE8B1I_FRAME_COUNT=500/)
  assert.match(captureA, /STAGE8B1I_IDENTICAL_COUNT=100/)
  assert.ok(!captureA.includes('MAX_PERSONAL_CAPTURE_INGRESS_URL'))
  const retryA = blockByName(blocks, 'scraper-retry-a')
  assert.match(retryA, /--network "\$NETWORK"/)
  assert.match(retryA, /STAGE8B1I_HARNESS_MODE=retry-only/)
  assert.match(retryA, /STAGE8B1I_DRAIN_ATTEMPTS=10/)
  assert.match(retryA, /MAX_PERSONAL_CAPTURE_INGRESS_URL=http:\/\/max-personal-gateway:8080\/v1\/capture/)
  const captureB = blockByName(blocks, 'scraper-capture-b')
  assert.match(captureB, /MAX_PERSONAL_ACCOUNT_ID="\$ACCOUNT_B"/)
  assert.match(captureB, /MAX_PERSONAL_CAPTURE_SPOOL_PATH=\/spool\/account-b/)
  assert.match(captureB, /STAGE8B1I_HARNESS_MODE=capture-and-drain/)
  assert.match(captureB, /STAGE8B1I_FRAME_COUNT=500/)
  assert.match(captureB, /STAGE8B1I_IDENTICAL_COUNT=0/)
  const drainA = blockByName(blocks, 'scraper-drain-a')
  assert.match(drainA, /MAX_PERSONAL_ACCOUNT_ID="\$ACCOUNT_A"/)
  assert.match(drainA, /STAGE8B1I_HARNESS_MODE=drain-only/)
  assert.match(drainA, /STAGE8B1I_DRAIN_ATTEMPTS=120/)
  assert.ok(!drainA.includes('STAGE8B1I_FRAME_COUNT'))
  assert.ok(!drainA.includes('STAGE8B1I_IDENTICAL_COUNT'))
  for (const activeBlock of [captureA, retryA, captureB, drainA]) assert.match(activeBlock, /"\$SPOOL_VOLUME:\/spool"/)
  pass('all_harness_invocations_explicit_allowlisted')

  assert.equal(observed.adapterEnabled, false)
  pass('disabled_adapter_reports_false')

  assert.equal(observed.frameHandled, true)
  pass('actual_transport_interceptor_frame_path')

  assert.equal(observed.spoolPathCreated, false)
  pass('spool_directory_not_created')

  assert.equal(observed.spoolPendingCount, 0)
  pass('spool_pending_zero')

  assert.equal(observed.activeAdapterFactoryCalled, false)
  pass('active_factory_not_called')

  const injected = await runHarness({
    environment: { STAGE8B1I_HARNESS_MODE: 'default-off' },
    dependencies: {
      createDisabledAdapterFromEnvironment: createLiveCaptureAdapterFromEnvironment,
      createActiveAdapterFromEnvironment: () => { throw new Error('ACTIVE_FACTORY_MUST_NOT_BE_CALLED') },
      TransportInterceptor,
    },
    disabledPath: path.join(tempRoot, 'injected-disabled-spool'),
  })
  assert.equal(injected.status, 'PASS')
  assert.equal(injected.activeAdapterFactoryCalled, false)
  pass('throwing_active_factory_fixture_not_called')

  assert.equal(observed.drainCreated, false)
  pass('drain_not_created')

  assert.equal(observed.timerAttemptCount, 0)
  pass('timer_attempts_zero')

  assert.equal(observed.networkAttemptCount, 0)
  pass('network_attempts_zero')

  assert.equal(observed.databaseAttemptCount, 0)
  pass('database_attempts_zero')

  assert.equal(observed.chromiumLaunched, false)
  pass('chromium_attempts_zero')

  assert.equal(observed.maxContacted, false)
  assert.equal(observed.providerAction, false)
  pass('max_provider_attempts_zero')

  validateFixture('malformed', '{not-json\n', 'SCRAPER_DEFAULT_OFF_OUTPUT_MALFORMED')
  pass('malformed_output_precise')

  validateFixture('missing', undefined, 'SCRAPER_DEFAULT_OFF_OUTPUT_MISSING')
  pass('missing_output_precise')

  const exited = spawnSync('bash', ['-c', `
    source "$1"
    pm_scraper_begin_operation SCRAPER_DEFAULT_OFF_RUN_CHECK default_off_harness docker_run docker_cli not_observed
    pm_scraper_mark_started
    pm_scraper_finish_operation 1 SCRAPER_DEFAULT_OFF_HARNESS_EXITED exited
    printf '%s|%s|%s' "$SCRAPER_PRIMARY_CLASSIFICATION" "$SCRAPER_ORIGINAL_EXIT" "$SCRAPER_CHECK_ID"
  `, 'bash', boundedPath], { encoding: 'utf8' })
  assert.equal(exited.status, 0, exited.stderr)
  assert.equal(exited.stdout, 'SCRAPER_DEFAULT_OFF_HARNESS_EXITED|1|SCRAPER_DEFAULT_OFF_RUN_CHECK')
  pass('harness_exit_one_precise')

  validateFixture('wrong-mode', { ...pinnedObserved, selectedMode: 'capture-only' }, 'SCRAPER_DEFAULT_OFF_MODE_MISMATCH')
  pass('wrong_selected_mode_rejected')

  validateFixture('enabled', { ...pinnedObserved, adapterEnabled: true }, 'SCRAPER_DEFAULT_OFF_ENABLED_UNEXPECTED')
  pass('enabled_true_rejected')

  validateFixture('spool-created', { ...pinnedObserved, spoolPathCreated: true }, 'SCRAPER_DEFAULT_OFF_SPOOL_CREATED')
  pass('spool_created_rejected')

  validateFixture('timer', { ...pinnedObserved, timerAttemptCount: 1 }, 'SCRAPER_DEFAULT_OFF_TIMER_ACTIVITY')
  pass('timer_activity_rejected')

  validateFixture('network', { ...pinnedObserved, networkAttemptCount: 1 }, 'SCRAPER_DEFAULT_OFF_NETWORK_ACTIVITY')
  pass('network_activity_rejected')

  validateFixture('database', { ...pinnedObserved, databaseAttemptCount: 1 }, 'SCRAPER_DEFAULT_OFF_DATABASE_ACTIVITY')
  pass('database_activity_rejected')

  validateFixture('active-factory', { ...pinnedObserved, activeAdapterFactoryCalled: true }, 'SCRAPER_DEFAULT_OFF_ACTIVE_FACTORY_CALLED')
  pass('active_factory_rejected')

  validateFixture('drain', { ...pinnedObserved, drainCreated: true }, 'SCRAPER_DEFAULT_OFF_DRAIN_CREATED')
  pass('drain_created_rejected')

  assert.deepEqual(Object.keys(observed), DEFAULT_OFF_FIELDS)
  assert.equal(JSON.parse(serializeEnvelope(observed)).resultSerialized, true)
  pass('output_allowlist_exact')

  const serialized = JSON.stringify(observed)
  for (const forbidden of ['DATABASE_URL', 'MAX_PERSONAL_CAPTURE_HMAC_SECRET', 'stage8b1i-secret-fixture', 'process.env']) {
    assert.ok(!serialized.includes(forbidden))
  }
  pass('no_environment_or_secrets_emitted')

  assert.equal(passCount, 30)
  process.stdout.write('SCRAPER_DEFAULT_OFF_TEST_COUNT=30\nREAL_CHECKOUT_LOADER_EXECUTED=YES\nACTUAL_HARNESS_EXECUTED=YES\nACTUAL_TRANSPORT_INTERCEPTOR_EXECUTED=YES\nDOCKER_EXECUTED=NO\nDATABASE_CONNECTED=NO\n')
}

main().finally(() => fs.rmSync(tempRoot, { recursive: true, force: true })).catch(error => {
  process.stderr.write(`${error.stack || error}\n`)
  process.exit(1)
})
