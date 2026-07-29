'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const packageRoot = __dirname
const repositoryRoot = path.resolve(packageRoot, '..', '..')
const scraperRoot = path.join(repositoryRoot, 'max-web-scraper')
const contractPath = path.join(packageRoot, 'scraper-runtime-contract.js')
const ledgerPath = path.join(packageRoot, 'scraper-runtime-source-ledger.json')
const acceptedImagesPath = path.join(packageRoot, 'accepted-images.json')
const probePath = path.join(packageRoot, 'isolated-release-probe.sh')
const boundedPath = path.join(packageRoot, 'bounded-operations.sh')
const { PINNED_APP_ROOT, loadRuntimeContract, serializeEnvelope } = require(contractPath)

const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'))
const acceptedImages = JSON.parse(fs.readFileSync(acceptedImagesPath, 'utf8'))
const probe = fs.readFileSync(probePath, 'utf8')
const bounded = fs.readFileSync(boundedPath, 'utf8')
const result = loadRuntimeContract({ appRoot: scraperRoot })
const serialized = serializeEnvelope(result)
const observed = JSON.parse(serialized)
let passCount = 0
const pass = name => { passCount += 1; process.stdout.write(`${name}=PASS\n`) }
const hash = target => crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex')

assert.equal(ledger.schemaVersion, 1)
assert.equal(ledger.privacy.sourceContentsCaptured, false)
pass('ledger_schema_privacy')

assert.equal(ledger.image.digest, 'sha256:e8a6fa389e187129664bc8b66ad883d6ec15308a2d837ee9ab1a7baec89aa43b')
assert.equal(ledger.image.ref, acceptedImages.images.scraper.ref)
pass('exact_image_digest_ref')

assert.equal(ledger.image.expectedSourceCommit, 'cd0ba4f7d25fa81f0d3c5427bf06e4cb48a651bf')
assert.equal(ledger.image.expectedOciRevision, ledger.image.expectedSourceCommit)
pass('expected_source_revision')

assert.equal(acceptedImages.images.scraper.expectedOciRevision, ledger.image.expectedOciRevision)
assert.equal(acceptedImages.images.scraper.expectedSourceCommit, ledger.image.expectedSourceCommit)
pass('accepted_image_provenance_binding')

for (const [absolutePath, fact] of Object.entries(ledger.modules)) {
  const relative = absolutePath.replace(/^\/app\//, '')
  assert.equal(hash(path.join(scraperRoot, relative)), fact.sha256)
}
pass('module_sha_ledger_matches_checkout')

assert.equal(result.status, 'PASS')
assert.equal(result.appRootCategory, 'OFFLINE_CHECKOUT_ROOT')
pass('runtime_contract_checkout_pass')

for (const moduleFact of Object.values(result.moduleFacts)) assert.equal(moduleFact.regularFile, true)
pass('module_regular_files')

for (const moduleFact of Object.values(result.moduleFacts)) assert.equal(moduleFact.symlink, false)
pass('module_non_symlink')

assert.equal(result.moduleLoadCompleted, true)
pass('module_load_completed')

assert.equal(result.exportFacts.createLiveCaptureAdapterFromEnvironment, 'function')
assert.equal(result.exportFacts.TransportInterceptor, 'function')
pass('export_types_exact')

assert.equal(result.disabledAdapterFacts.objectCreated, true)
pass('disabled_adapter_created')

assert.equal(result.disabledAdapterFacts.capturePhysicalFrameCallable, true)
assert.equal(result.disabledAdapterFacts.getCaptureHealthCallable, true)
pass('disabled_adapter_methods')

assert.equal(result.disabledAdapterFacts.enabledFalse, true)
pass('disabled_adapter_default_off')

assert.equal(result.interceptorFacts.constructed, true)
pass('interceptor_constructed')

assert.equal(result.interceptorFacts.handleFrameCallable, true)
assert.equal(result.interceptorFacts.getCaptureHealthCallable, true)
assert.equal(result.interceptorFacts.detachCallable, true)
pass('interceptor_methods')

assert.equal(result.interceptorFacts.detached, true)
pass('interceptor_detached')

assert.ok(result.suppressedLogCount >= 1)
assert.equal(typeof result.suppressedWarnCount, 'number')
assert.equal(typeof result.suppressedErrorCount, 'number')
pass('console_output_suppressed')

assert.equal(result.sourceContentsCaptured, false)
assert.equal(result.environmentCaptured, false)
assert.equal(result.profileDataCaptured, false)
assert.equal(result.persistedMessageContentsCaptured, false)
pass('runtime_privacy_flags')

assert.equal(serialized.trim().split('\n').length, 1)
assert.equal(observed.resultSerialized, true)
assert.ok(!serialized.includes('process.env'))
pass('single_safe_serialization')

const contractSource = fs.readFileSync(contractPath, 'utf8')
assert.match(contractSource, /const PINNED_APP_ROOT = '\/app'/)
assert.ok(!contractSource.includes('process.env.STAGE8B1I_APP_ROOT'))
assert.match(probe, /bootstrap_verify_runtime_artifact scraper-runtime-contract\.js/)
assert.match(probe, /bootstrap_verify_runtime_artifact scraper-runtime-source-ledger\.json/)
for (const checkId of ['SCRAPER_RUNTIME_CONTRACT_CHECK', 'SCRAPER_RUNTIME_SOURCE_CHECK', 'SCRAPER_RUNTIME_EXPORT_CHECK', 'SCRAPER_RUNTIME_DISABLED_ADAPTER_CHECK', 'SCRAPER_RUNTIME_INTERCEPTOR_CHECK']) {
  assert.ok(probe.includes(checkId) || bounded.includes(checkId))
}
assert.equal(PINNED_APP_ROOT, '/app')
pass('cli_root_and_probe_bindings')

assert.equal(passCount, 20)
process.stdout.write('SCRAPER_RUNTIME_CONTRACT_TEST_COUNT=20\nREAL_RUNTIME_CONTRACT_CODE_EXECUTED=YES\nDOCKER_EXECUTED=NO\nDATABASE_CONNECTED=NO\n')
