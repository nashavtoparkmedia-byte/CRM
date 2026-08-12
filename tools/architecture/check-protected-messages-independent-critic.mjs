#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { cwd: process.cwd(), encoding: 'utf8', ...options })
  assert.equal(result.status, 0, `${command} ${args.join(' ')} failed\n${result.stdout}${result.stderr}`)
  return result.stdout.trim()
}

const registry = JSON.parse(readFileSync(
  'architecture/recovery/whole-project-dod/v2/protected-messages-reconciliation-v1/registry.json',
  'utf8',
))
assert.equal(registry.records.length, 26, 'protected Messages selected denominator drift')
assert.equal(registry.records.filter(record => record.classifications.includes('UNKNOWN')).length, 0, 'unknown delta remains')
assert.equal(registry.records.filter(record => record.classifications.includes('REQUIRED_BEHAVIOR')).length, 14, 'required behavior denominator drift')

run(process.execPath, ['tools/architecture/check-protected-messages-reconciliation.mjs'])
run(process.execPath, ['tools/architecture/test-protected-messages-reconciliation-negative.mjs'])
run(process.execPath, ['tools/architecture/check-protected-messages-owner-boundaries.mjs'])

const productionHead = run('git', ['--git-dir=/opt/crm/.git', 'rev-parse', 'HEAD'])
assert.ok(productionHead.startsWith('e6a0a833'), 'production identity context drift')
const aiCallsHead = run('git', ['-C', '/opt/codex-work/crm-ai-calls', 'rev-parse', 'HEAD'])
assert.ok(aiCallsHead.startsWith('b38b22d3'), 'protected AI Calls lineage drift')
run('git', ['diff', '--quiet', 'HEAD', '--', 'gravity-mvp/src/lib/ai-call', 'gravity-mvp/src/app/api/ai-calls'])

const metrics = {
  selected_surfaces: registry.records.length,
  required_behavior: registry.records.filter(record => record.classifications.includes('REQUIRED_BEHAVIOR')).length,
  obsolete: registry.records.filter(record => record.classifications.includes('OBSOLETE')).length,
  hotfix_already_reimplemented: registry.records.filter(record => record.classifications.includes('HOTFIX_ALREADY_REIMPLEMENTED')).length,
  security_risk: registry.records.filter(record => record.classifications.includes('SECURITY_RISK')).length,
  unknown: 0,
  owner_boundary_failures: 0,
  unrelated_writer_negative_probe: 'REJECTED',
  protected_ai_calls_changed: 0,
}
process.stdout.write(`${JSON.stringify({ status: 'PASS', metrics }, null, 2)}\n`)
