#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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

function main() {
  const root = process.cwd()
  const inventory = boundaryControlInventory(root)
  for (const control of inventory.active) {
    process.stdout.write(`BOUNDARY_CONTROL_START ${control}\n`)
    const result = spawnSync(process.execPath, [control], {
      cwd: root,
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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
