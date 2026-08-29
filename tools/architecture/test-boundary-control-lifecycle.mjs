#!/usr/bin/env node

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  boundaryControlInventory,
  validateBoundaryControlLifecycle,
} from './run-boundary-controls.mjs'

const root = process.cwd()
const inventory = boundaryControlInventory(root)
assert(inventory.active.length > 100, 'critical active boundary inventory unexpectedly narrow')
assert.equal(inventory.superseded.length, 6)
assert.equal(new Set([...inventory.active, ...inventory.superseded]).size, (
  inventory.active.length + inventory.superseded.length
))

const lifecycle = JSON.parse(readFileSync(
  'architecture/enforcement/v1/superseded-boundary-controls.json',
  'utf8',
))
assert.throws(() => validateBoundaryControlLifecycle(root, [...inventory.active, ...inventory.superseded], {
  ...lifecycle,
  records: [...lifecycle.records, {
    checker: 'tools/architecture/check-does-not-exist-boundary.mjs',
    reason: 'This intentionally invalid record proves that untracked supersession cannot pass.',
    successors: [inventory.active[0]],
  }],
}), /superseded checker does not exist/)
assert.throws(() => validateBoundaryControlLifecycle(root, [...inventory.active, ...inventory.superseded], {
  ...lifecycle,
  records: [{
    checker: inventory.superseded[0],
    reason: 'This intentionally invalid record proves that a missing successor cannot pass.',
    successors: ['tools/architecture/check-does-not-exist-boundary.mjs'],
  }],
}), /successor is not a boundary checker/)

process.stdout.write(`boundary control lifecycle: PASS (${inventory.active.length} active; ${inventory.superseded.length} superseded; 2 negative probes)\n`)
