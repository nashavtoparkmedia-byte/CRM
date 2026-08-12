#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = process.cwd()

export const targetedControls = [
  ['manifest-policy', 'node', ['tools/architecture/validate-context-manifests.mjs']],
  ['manifest-negatives', 'node', ['--test', 'tools/architecture/__tests__/context-manifests.test.mjs']],
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
  ['whole-repository-credential-inventory', 'node', [
    'tools/architecture/v2/credential-inventory.mjs', '--root', '.', '--output', credentialOutput,
  ]],
  ['fresh-credential-verification', 'node', [
    'tools/architecture/v2/verify-authoritative-credential-inventory.mjs', credentialOutput,
  ]],
  ]
}

export const fullScanControls = fullScanControlsFor('/tmp/yoko-authoritative-ci')

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
    process.exit(result.status ?? 1)
  }
  process.stdout.write(`AUTHORITATIVE_CONTROL_PASS ${id}\n`)
}

function main() {
  const skipFullScans = process.argv.includes('--skip-full-scans')
  const listOnly = process.argv.includes('--list')
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
  try {
    selected.forEach(run)
    process.stdout.write(`authoritative architecture CI: PASS (${selected.length}/${selected.length})\n`)
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
