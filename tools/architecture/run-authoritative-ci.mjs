#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = process.cwd()

export const targetedControls = [
  ['authoritative-ci-inventory', 'node', ['tools/architecture/test-authoritative-ci-inventory.mjs']],
  ['original-dod-canonical-mapping', 'node', ['tools/architecture/v2/verify-original-dod-canonical-mapping.mjs']],
  ['original-dod-canonical-mapping-negatives', 'node', ['tools/architecture/v2/test-original-dod-canonical-mapping.mjs']],
  ['manifest-policy', 'node', ['tools/architecture/validate-context-manifests.mjs']],
  ['manifest-negatives', 'node', ['--test', 'tools/architecture/__tests__/context-manifests.test.mjs']],
  ['executable-path-ownership-negatives', 'node', ['tools/architecture/test-executable-path-ownership.mjs']],
  ['final-dependency-artifact', 'node', ['tools/architecture/test-final-dependency-artifact.mjs']],
  ['module-scaffold-negatives', 'node', ['tools/architecture/test-module-scaffold.mjs']],
  ['production-migration-authority', 'node', ['tools/architecture/validate-production-migration-authority.mjs']],
  ['production-migration-authority-negatives', 'node', ['tools/architecture/test-production-migration-authority.mjs']],
  ['production-migration-default-clean-checkout', 'node', ['tools/architecture/test-production-migration-clean-checkout.mjs']],
  ['production-migration-runtime-semantics', 'node', ['tools/architecture/test-production-migration-runtime.mjs']],
  ['source-only-runtime-v10-contract', 'node', ['tools/architecture/test-source-only-runtime-v10.mjs']],
  ['production-migration-committed-runtime-inventory', 'node', ['tools/architecture/verify-production-migration-runtime.mjs', '--sanitized-inventory']],
  ['production-migration-canonical-replay', 'node', ['tools/architecture/replay-production-migration-authority.mjs', '--allow-isolated-replay']],
  ['production-migration-predecessor-recovery-replay', 'node', ['tools/architecture/replay-production-migration-authority.mjs', '--allow-isolated-replay', '--predecessor-recovery']],
  ['architecture-policy', 'node', ['tools/architecture/enforce-architecture.mjs']],
  ['architecture-negatives', 'node', ['tools/architecture/test-architecture-enforcement.mjs']],
  ['write-analyzer-negatives', 'node', ['tools/architecture/v2/test-write-analyzer.mjs']],
  ['write-runner-negatives', 'node', ['tools/architecture/v2/test-analyze.mjs']],
  ['write-gate-negatives', 'node', ['tools/architecture/v2/test-authoritative-write-analysis.mjs']],
  ['surface-lifecycle-negatives', 'node', ['tools/architecture/v2/test-surface-inventory.mjs']],
  ['ambiguity-reconciliation', 'node', ['tools/architecture/v2/test-triage-reconciliation.mjs', 'architecture/recovery/whole-project-dod/v2/AMBIGUOUS_WRITE_TRIAGE_FINAL_CLOSURE.json']],
  ['scoped-ownership-negatives', 'node', ['tools/architecture/v2/test-scoped-data-ownership.mjs']],
  ['maintenance-capability-negatives', 'node', ['tools/architecture/v2/test-maintenance-capability-policy.mjs']],
  ['credential-field-registry', 'node', ['tools/architecture/v2/check-credential-field-registry.mjs']],
  ['credential-analyzer-negatives', 'node', ['tools/architecture/v2/test-credential-analyzer.mjs']],
  ['credential-inventory-negatives', 'node', ['tools/architecture/v2/test-credential-inventory.mjs']],
  ['credential-boundary-negatives', 'node', ['tools/architecture/v2/test-credential-boundary-negative.mjs']],
  ['credential-gate-negatives', 'node', ['tools/architecture/v2/test-authoritative-credential-inventory.mjs']],
  ['credential-migration-boundary', 'node', ['tools/architecture/v2/check-credential-migration-boundary.mjs']],
  ['contract-registry-policy', 'node', ['tools/architecture/validate-contract-registry.mjs']],
  ['contract-registry-negatives', 'node', ['tools/architecture/test-contract-registry.mjs']],
  ['contract-policy', 'node', ['tools/architecture/check-contract-boundaries.mjs']],
  ['contract-behavior', 'node', ['tools/architecture/test-contracts.mjs']],
  ['outbox-policy', 'node', ['tools/architecture/check-outbox-architecture.mjs']],
  ['outbox-behavior-negatives', 'node', ['tools/architecture/test-outbox.mjs']],
  ['static-sql-policy', 'node', ['tools/architecture/check-static-sql-ownership-boundary.mjs']],
  ['typescript-baseline-negatives', 'node', ['tools/architecture/test-typescript-baseline.mjs']],
  ['typescript-baseline', 'node', ['tools/architecture/check-typescript-baseline.mjs']],
  ['blast-radius-negatives', 'node', ['tools/architecture/test-blast-radius.mjs']],
  ['blast-radius', 'node', ['tools/architecture/check-blast-radius.mjs']],
  ['boundary-control-lifecycle-negatives', 'node', ['tools/architecture/test-boundary-control-lifecycle.mjs']],
  ['all-current-boundaries', 'node', ['tools/architecture/run-boundary-controls.mjs']],
  ['independent-source-critic', 'node', ['tools/architecture/v2/independent-critic-final-gate.mjs']],
  ['gravity-security', 'npm', ['run', 'test:security-boundaries'], 'gravity-mvp'],
  ['tg-bot-security', 'npm', ['run', 'test:security-boundaries'], 'tg-bot'],
]

export function fullScanControlsFor(temporary) {
  const writeOutput = path.join(temporary, 'write-analysis.json')
  const progressOutput = path.join(temporary, 'write-progress.jsonl')
  const credentialOutput = path.join(temporary, 'credential-inventory.json')
  return [
  ['whole-repository-write-scan', 'node', [
    'tools/architecture/v2/analyze.mjs', '--root', '.', '--strict', '--workers', '4',
    '--worker-timeout-ms', '120000', '--progress-every', '25',
    '--surface-registry', 'architecture/recovery/whole-project-dod/v2/LIFECYCLE_SURFACE_CLASSIFICATION_REGISTRY.json',
    '--progress-jsonl', progressOutput, '--output', writeOutput,
  ]],
  ['fresh-write-verification', 'node', [
    'tools/architecture/v2/verify-authoritative-write-analysis.mjs', writeOutput,
  ]],
  ['fresh-migration-write-site-authorizations', 'node', [
    'tools/architecture/v2/test-migration-write-site-authorizations.mjs', writeOutput,
  ]],
  ['whole-repository-credential-inventory', 'node', [
    'tools/architecture/v2/credential-inventory.mjs', '--root', '.',
    '--surface-registry', 'architecture/recovery/whole-project-dod/v2/LIFECYCLE_SURFACE_CLASSIFICATION_REGISTRY.json',
    '--output', credentialOutput,
  ]],
  ['fresh-credential-verification', 'node', [
    'tools/architecture/v2/verify-authoritative-credential-inventory.mjs', credentialOutput,
  ]],
  ]
}

export const fullScanControls = fullScanControlsFor('/tmp/yoko-authoritative-ci')

export function normalizedControlCatalog(temporary = '$YOKO_CI_TEMP') {
  return [...targetedControls, ...fullScanControlsFor(temporary)].map(([id, command, args, relativeCwd = '.']) => ({
    id,
    command,
    args: [...args],
    cwd: relativeCwd,
  }))
}

export function controlIdCatalogSha256(ids = normalizedControlCatalog().map(({ id }) => id)) {
  return createHash('sha256').update(`${JSON.stringify(ids)}\n`).digest('hex')
}

export function semanticControlCatalogSha256(catalog = normalizedControlCatalog()) {
  return createHash('sha256').update(`${JSON.stringify({
    schema: 'yoko.crm.authoritative-ci-control-catalog.v1',
    controls: catalog,
  })}\n`).digest('hex')
}

function sha256File(relative) {
  return createHash('sha256').update(readFileSync(path.join(root, relative))).digest('hex')
}

function gitIdentity(expression) {
  const result = spawnSync('git', ['rev-parse', expression], { cwd: root, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`unable to resolve authoritative CI source identity: ${expression}`)
  return result.stdout.trim()
}

export function buildExecutionProof(executions, identity) {
  const catalog = normalizedControlCatalog()
  const ids = catalog.map(({ id }) => id)
  if (
    executions.length !== ids.length
    || executions.some((execution, index) => (
      execution?.id !== ids[index] || execution?.status !== 'PASS'
      || Object.keys(execution).length !== 2
    ))
  ) throw new Error('authoritative CI execution proof requires all 52 ordered PASS controls')
  if (ids.length !== 52 || new Set(ids).size !== 52) {
    throw new Error('authoritative CI execution proof catalog is not exact')
  }
  return {
    schema: 'yoko.crm.authoritative-ci-execution-proof.v1',
    outcome: 'PASS',
    source: { commit: identity.commit, tree: identity.tree },
    workflow: {
      path: '.github/workflows/architecture-enforcement.yml',
      sha256: identity.workflow_sha256,
    },
    runner: {
      path: 'tools/architecture/run-authoritative-ci.mjs',
      sha256: identity.runner_sha256,
    },
    runtime: { node: process.versions.node },
    controls: {
      count: ids.length,
      catalog_sha256: controlIdCatalogSha256(ids),
      semantic_catalog_sha256: semanticControlCatalogSha256(catalog),
      executions,
    },
  }
}

function executionProofIdentity() {
  return {
    commit: gitIdentity('HEAD^{commit}'),
    tree: gitIdentity('HEAD^{tree}'),
    workflow_sha256: sha256File('.github/workflows/architecture-enforcement.yml'),
    runner_sha256: sha256File('tools/architecture/run-authoritative-ci.mjs'),
  }
}

function resolveExecutionProofOutput() {
  const configured = process.env.YOKO_CI_ATTESTATION_OUTPUT?.trim()
  if (!configured) return null
  const resolved = path.resolve(root, configured)
  if (path.dirname(resolved) !== root || path.basename(resolved) !== configured) {
    throw new Error('YOKO_CI_ATTESTATION_OUTPUT must be one plain repository-root filename')
  }
  return resolved
}

function removeExecutionProof(output) {
  if (!output) return
  try { unlinkSync(output) } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  try { unlinkSync(`${output}.new`) } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

function writeExecutionProof(output, executions) {
  const proof = buildExecutionProof(executions, executionProofIdentity())
  const temporary = `${output}.new`
  writeFileSync(temporary, `${JSON.stringify(proof, null, 2)}\n`, { encoding: 'ascii', flag: 'wx', mode: 0o444 })
  renameSync(temporary, output)
}

function resolveCommand(command) {
  if (command === 'node') return process.execPath
  return command
}

function run([id, command, args, relativeCwd = '.']) {
  process.stdout.write(`AUTHORITATIVE_CONTROL_START ${id}\n`)
  const result = spawnSync(resolveCommand(command), args, {
    cwd: path.join(root, relativeCwd),
    encoding: 'utf8',
    stdio: 'inherit',
    env: process.env,
  })
  if (result.status !== 0) {
    process.stderr.write(`AUTHORITATIVE_CONTROL_FAIL ${id} exit=${result.status}\n`)
    const failure = new Error(`authoritative control failed: ${id}`)
    failure.exitCode = result.status ?? 1
    throw failure
  }
  process.stdout.write(`AUTHORITATIVE_CONTROL_PASS ${id}\n`)
}

function main() {
  const skipFullScans = process.argv.includes('--skip-full-scans')
  const listOnly = process.argv.includes('--list')
  const proofOutput = resolveExecutionProofOutput()
  if (proofOutput && (listOnly || skipFullScans)) {
    throw new Error('execution proof is permitted only for the complete authoritative catalog')
  }
  removeExecutionProof(proofOutput)
  const temporary = mkdtempSync(path.join(tmpdir(), 'yoko-authoritative-ci-'))
  const currentFullScanControls = fullScanControlsFor(temporary)
  const selected = skipFullScans
    ? targetedControls
    : [...targetedControls, ...currentFullScanControls]
  if (listOnly) {
    process.stdout.write(`${JSON.stringify({
      schema: 'yoko.crm.authoritative-ci-control-inventory.v1',
      skip_full_scans: skipFullScans,
      controls: selected.map(([id, command, args, cwd = '.']) => ({ id, command, args, cwd })),
    }, null, 2)}\n`)
    rmSync(temporary, { recursive: true, force: true })
    return
  }
  const executions = []
  try {
    selected.forEach((control) => {
      run(control)
      executions.push({ id: control[0], status: 'PASS' })
    })
    if (proofOutput) writeExecutionProof(proofOutput, executions)
    process.stdout.write(`authoritative architecture CI: PASS (${selected.length}/${selected.length})\n`)
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main() } catch (error) {
    process.stderr.write(`${error.stack ?? error.message}\n`)
    process.exitCode = error.exitCode ?? 1
  }
}
