#!/usr/bin/env node

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'

const execFileAsync = promisify(execFile)
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const validatorRelative = 'tools/architecture/validate-executable-path-ownership.mjs'
const validatorPath = path.join(repositoryRoot, validatorRelative)
const validatorUrl = pathToFileURL(validatorPath).href
const removedAuthorityReaders = [
  'readCurrentOwnershipCoverage',
  'readCurrentOwnershipDependencies',
  'readHistoricalOwnershipBaseline',
  'readReviewedOwnershipDecisions',
]
const formerConsumers = [
  'tools/architecture/__tests__/context-manifests.test.mjs',
  'tools/architecture/generate-context-manifests.mjs',
  'tools/architecture/test-executable-path-ownership.mjs',
  'tools/architecture/v2/independent-critic-final-gate.mjs',
  'tools/architecture/validate-context-manifests.mjs',
]
const pureHelperPaths = [
  'tools/architecture/enrich-context-manifests.mjs',
  'tools/architecture/generate-context-manifests.mjs',
]
async function runNode(args, options = {}) {
  return execFileAsync(process.execPath, args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    ...options,
  })
}

const validatorSource = await readFile(validatorPath, 'utf8')
assert.equal(/^\s*export\s/mu.test(validatorSource), false, 'authority executable must export zero symbols')
const canonicalNamespace = await import(`${validatorUrl}?authority-export-inventory=${Date.now()}`)
assert.deepEqual(Object.keys(canonicalNamespace), [], 'authority executable module namespace must be empty')
for (const reader of removedAuthorityReaders) {
  assert.equal(Object.hasOwn(canonicalNamespace, reader), false, `raw authority reader remains exported: ${reader}`)
}

for (const relative of formerConsumers) {
  if (relative === 'tools/architecture/test-executable-path-ownership.mjs') continue
  const source = await readFile(path.join(repositoryRoot, relative), 'utf8')
  for (const reader of removedAuthorityReaders) {
    assert.equal(source.includes(reader), false, `former consumer still names raw authority reader: ${relative}#${reader}`)
  }
  assert.equal(source.includes("from './validate-executable-path-ownership.mjs'"), false, `former consumer still imports authority executable: ${relative}`)
  assert.equal(source.includes("from '../validate-executable-path-ownership.mjs'"), false, `former consumer still imports authority executable: ${relative}`)
}

for (const relative of pureHelperPaths) {
  const source = await readFile(path.join(repositoryRoot, relative), 'utf8')
  for (const reader of removedAuthorityReaders) {
    assert.equal(source.includes(reader), false, `pure helper recreates raw authority reader: ${relative}#${reader}`)
  }
}

const validation = await runNode([validatorRelative, '--validate'])
const validationResult = JSON.parse(validation.stdout)
assert.deepEqual({
  schema: validationResult.schema,
  operation: validationResult.operation,
  ok: validationResult.ok,
  singleAuthority: validationResult.single_authority_reader_executable,
  authorityExports: validationResult.authority_capability_exports,
  rawApiRemoved: validationResult.raw_authority_reader_module_api_removed,
  authorityPathsPrivate: validationResult.authority_paths_private_to_orchestrator,
  pureHelpers: validationResult.reusable_helpers_authority_io_free,
  formerConsumersDecoupled: validationResult.historical_consumers_no_longer_import_authority,
  nodeIdentityRetired: validationResult.node_identity_enumeration_retired,
  sourceLanguageRetired: validationResult.source_language_loader_enumeration_retired,
  arbitraryDataflowRetired: validationResult.arbitrary_js_dataflow_retired,
  threatModelExplicit: validationResult.same_trust_source_threat_model_explicit,
  historicalFixture: validationResult.historical_fixture_verified,
  denominator: validationResult.tracked_executable_surfaces,
}, {
  schema: 'yoko.crm.single-authority-process-result.v1',
  operation: 'validate',
  ok: true,
  singleAuthority: true,
  authorityExports: 0,
  rawApiRemoved: true,
  authorityPathsPrivate: true,
  pureHelpers: true,
  formerConsumersDecoupled: true,
  nodeIdentityRetired: true,
  sourceLanguageRetired: true,
  arbitraryDataflowRetired: true,
  threatModelExplicit: true,
  historicalFixture: true,
  denominator: 2242,
})

const attackRoot = await mkdtemp(path.join(os.tmpdir(), 'yoko-authority-api-removal-'))
try {
  const reexportAttack = path.join(attackRoot, 'esm-reexport.mjs')
  await writeFile(reexportAttack, `export { readCurrentOwnershipCoverage } from ${JSON.stringify(validatorUrl)}\n`)
  await assert.rejects(
    () => runNode([reexportAttack]),
    (error) => error.code !== 0 && /does not provide an export named ['"]readCurrentOwnershipCoverage['"]/u.test(error.stderr),
    'ESM re-export attack must fail because the capability does not exist',
  )

  const exportedConstAttack = path.join(attackRoot, 'exported-const.mjs')
  await writeFile(exportedConstAttack, [
    `import * as authority from ${JSON.stringify(validatorUrl)}`,
    'export const exposed = authority.readCurrentOwnershipCoverage',
    'if (exposed !== undefined) process.exit(1)',
    '',
  ].join('\n'))
  await runNode([exportedConstAttack])

  const queryNamespace = await import(`${validatorUrl}?authority-bypass`)
  assert.deepEqual(Object.keys(queryNamespace), [], 'query-qualified import exposed authority capability')

  const uppercaseFileNamespace = await import(`FILE:${validatorUrl.slice('file:'.length)}`)
  assert.deepEqual(Object.keys(uppercaseFileNamespace), [], 'uppercase FILE import exposed authority capability')

  const commonJsAttack = path.join(attackRoot, 'aliased-create-require.cjs')
  await writeFile(commonJsAttack, [
    "const { createRequire: factory } = require('node:module')",
    'const load = factory(__filename)',
    'let authority = null',
    `try { authority = load(${JSON.stringify(validatorPath)}) } catch (error) { if (error.code !== 'ERR_REQUIRE_ESM') throw error }`,
    "const capability = authority && typeof authority.readCurrentOwnershipCoverage === 'function'",
    'if (capability) process.exit(1)',
    "process.stdout.write(JSON.stringify({ capability: false }))",
    '',
  ].join('\n'))
  const commonJs = await runNode([commonJsAttack])
  assert.deepEqual(JSON.parse(commonJs.stdout), { capability: false })
} finally {
  await rm(attackRoot, { recursive: true, force: true })
}

assert.equal(validatorSource.includes('directRequireLoaderNames'), false)
assert.equal(validatorSource.includes('trackedModuleSpecifierIdentity'), false)
assert.equal(validatorSource.includes('validateAcceptanceSourceLanguage'), false)
assert.equal(validatorSource.includes('discoverExecutablePathOwnershipConsumers'), false)
assert.equal(validatorSource.includes('createRequire'), false)
assert.equal(validatorSource.includes('pathToFileURL'), false)

process.stdout.write(`${JSON.stringify({
  status: 'PASS',
  authority_capability_exports: 0,
  former_consumers: formerConsumers.length,
  reusable_helpers_authority_io_free: pureHelperPaths.length,
  historical_fixture_verified: true,
  denominator: validationResult.tracked_executable_surfaces,
  attacks: {
    esm_reexport: 'CAPABILITY_ABSENT',
    exported_const: 'CAPABILITY_ABSENT',
    query_qualified_import: 'CAPABILITY_ABSENT',
    uppercase_file_import: 'CAPABILITY_ABSENT',
    aliased_commonjs_create_require: 'CAPABILITY_ABSENT',
  },
})}\n`)
