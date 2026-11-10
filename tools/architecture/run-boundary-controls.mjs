#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Must equal ARCHITECTURE_SCAN_MEMO_ENV in enforce-architecture.mjs. The runner
// does not import the scanner, so a scanner that cannot load still leaves the
// runner and its fail-fast order intact.
const ARCHITECTURE_SCAN_MEMO_ENV = 'YOKO_ARCHITECTURE_SCAN_MEMO'
const ARCHITECTURE_SCAN_MEMO_DISABLE_ENV = 'YOKO_ARCHITECTURE_SCAN_MEMO_DISABLE'
const WRITE_ARCHITECTURE_SCAN_MEMO = '--write-architecture-scan-memo'

export function validateBoundaryControlLifecycle(root, controls, lifecycle) {
  assert.equal(lifecycle.schema, 'yoko.crm.superseded-boundary-controls.v1')
  const all = new Set(controls)
  const superseded = new Set()
  for (const record of lifecycle.records ?? []) {
    assert(all.has(record.checker), `superseded checker does not exist: ${record.checker}`)
    assert(!superseded.has(record.checker), `duplicate superseded checker: ${record.checker}`)
    assert.equal(typeof record.reason, 'string')
    assert(record.reason.length > 20, `missing supersession rationale: ${record.checker}`)
    assert(Array.isArray(record.successors) && record.successors.length > 0, `missing successor: ${record.checker}`)
    for (const successor of record.successors) {
      assert(all.has(successor), `successor is not a boundary checker: ${successor}`)
      assert.notEqual(successor, record.checker)
      assert(existsSync(path.join(root, successor)), `successor file missing: ${successor}`)
    }
    superseded.add(record.checker)
  }
  return {
    active: controls.filter((control) => !superseded.has(control)),
    superseded: [...superseded].sort(),
  }
}

export function boundaryControlInventory(root = process.cwd()) {
  const directory = path.join(root, 'tools/architecture')
  const controls = readdirSync(directory)
    .filter((name) => /^check-.*-boundary\.mjs$/u.test(name))
    .map((name) => `tools/architecture/${name}`)
    .sort()
  const lifecycle = JSON.parse(readFileSync(
    path.join(root, 'architecture/enforcement/v1/superseded-boundary-controls.json'),
    'utf8',
  ))
  return validateBoundaryControlLifecycle(root, controls, lifecycle)
}

// One scanArchitecture() result for the whole run (OD-12). The scan is computed
// once, in a separate process, before the first control, and written to a
// private directory that is removed when the runner exits. Controls only read
// it, and each one checks it against the inputs its own scan has just read (see
// enforce-architecture.mjs). If this step fails for any reason, no control gets
// the memo, every control scans for itself, and failures surface exactly where
// they did before.
export function prepareArchitectureScanMemo(root, environment) {
  if (environment[ARCHITECTURE_SCAN_MEMO_DISABLE_ENV] === '1') {
    return { memoFile: null, note: `disabled by ${ARCHITECTURE_SCAN_MEMO_DISABLE_ENV}=1` }
  }
  let directory = null
  try {
    directory = mkdtempSync(path.join(os.tmpdir(), 'yoko-architecture-scan-memo-'))
    const owned = directory
    process.on('exit', () => rmSync(owned, { recursive: true, force: true }))
    const memoFile = path.join(directory, 'scan-memo.json')
    const started = Date.now()
    const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), WRITE_ARCHITECTURE_SCAN_MEMO, memoFile], {
      cwd: root,
      env: environment,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 16 * 1024 * 1024,
    })
    if (result.status !== 0 || !existsSync(memoFile)) {
      const detail = `${result.stderr ?? ''}`.trim().split('\n').filter(Boolean).at(-1) ?? result.error?.message ?? ''
      return { memoFile: null, note: `precompute failed (exit=${result.status ?? result.signal})${detail ? `: ${detail}` : ''}` }
    }
    return { memoFile, note: `ready in ${Math.round((Date.now() - started) / 1000)}s ${`${result.stdout}`.trim()}` }
  } catch (error) {
    return { memoFile: null, note: `precompute failed: ${error?.message ?? error}` }
  }
}

async function writeArchitectureScanMemoMain(memoFile) {
  assert(typeof memoFile === 'string' && path.isAbsolute(memoFile), `${WRITE_ARCHITECTURE_SCAN_MEMO} needs an absolute file path`)
  const { writeArchitectureScanMemo } = await import('./enforce-architecture.mjs')
  const summary = await writeArchitectureScanMemo(process.cwd(), memoFile)
  process.stdout.write(`${JSON.stringify(summary)}\n`)
}

function main() {
  const root = process.cwd()
  const inventory = boundaryControlInventory(root)
  const controlEnvironment = { ...process.env }
  delete controlEnvironment[ARCHITECTURE_SCAN_MEMO_ENV]
  const memo = prepareArchitectureScanMemo(root, controlEnvironment)
  if (memo.memoFile) controlEnvironment[ARCHITECTURE_SCAN_MEMO_ENV] = memo.memoFile
  process.stdout.write(`ARCHITECTURE_SCAN_MEMO ${memo.memoFile ? 'on' : 'off'}: ${memo.note}\n`)
  for (const control of inventory.active) {
    process.stdout.write(`BOUNDARY_CONTROL_START ${control}\n`)
    const result = spawnSync(process.execPath, [control], {
      cwd: root,
      env: controlEnvironment,
      encoding: 'utf8',
      stdio: 'inherit',
    })
    if (result.status !== 0) {
      process.stderr.write(`BOUNDARY_CONTROL_FAIL ${control} exit=${result.status}\n`)
      process.exit(result.status ?? 1)
    }
  }
  process.stdout.write(`boundary controls: PASS (${inventory.active.length}/${inventory.active.length} active; ${inventory.superseded.length} evidence-backed superseded)\n`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === WRITE_ARCHITECTURE_SCAN_MEMO) await writeArchitectureScanMemoMain(process.argv[3])
  else main()
}
