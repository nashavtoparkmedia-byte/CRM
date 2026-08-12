#!/usr/bin/env node

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { fullScanControls, targetedControls } from './run-authoritative-ci.mjs'

const ids = new Set([...targetedControls, ...fullScanControls].map(([id]) => id))
for (const required of [
  'manifest-negatives',
  'architecture-negatives',
  'write-analyzer-negatives',
  'whole-repository-write-scan',
  'fresh-write-verification',
  'surface-lifecycle-negatives',
  'scoped-ownership-negatives',
  'maintenance-capability-negatives',
  'credential-boundary-negatives',
  'whole-repository-credential-inventory',
  'fresh-credential-verification',
  'contract-policy',
  'outbox-behavior-negatives',
  'typescript-baseline-negatives',
  'blast-radius-negatives',
  'blast-radius',
  'all-current-boundaries',
  'gravity-security',
  'tg-bot-security',
]) assert(ids.has(required), `missing authoritative CI control: ${required}`)

assert.equal(ids.size, targetedControls.length + fullScanControls.length, 'duplicate CI control id')
const workflow = readFileSync('.github/workflows/architecture-enforcement.yml', 'utf8')
assert.match(workflow, /node tools\/architecture\/run-authoritative-ci\.mjs/u)
assert.match(workflow, /YOKO_BLAST_BASE: \$\{\{ github\.event\.pull_request\.base\.sha \|\| github\.event\.before \}\}/u)
assert.doesNotMatch(workflow, /--skip-full-scans/u)

const writeCommand = fullScanControls.find(([id]) => id === 'whole-repository-write-scan')
assert(writeCommand[2].includes('--strict'))
assert(writeCommand[2].includes('--progress-jsonl'))
assert(writeCommand[2].includes('--output'))

process.stdout.write(`authoritative CI inventory: PASS (${ids.size} controls; fresh write and credential scans enabled)\n`)
