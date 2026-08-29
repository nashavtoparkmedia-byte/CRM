#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const registryPath = process.env.PROTECTED_MESSAGES_REGISTRY
  ? path.resolve(process.env.PROTECTED_MESSAGES_REGISTRY)
  : path.join(root, 'architecture/recovery/whole-project-dod/v2/protected-messages-reconciliation-v1/registry.json')
const registry = JSON.parse(readFileSync(registryPath, 'utf8'))
const allowed = new Set([
  'REQUIRED_BEHAVIOR',
  'OBSOLETE',
  'GENERATED',
  'HOTFIX_ALREADY_REIMPLEMENTED',
  'SECURITY_RISK',
  'UNKNOWN',
])
const failures = []
const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex')

for (const record of registry.records) {
  const production = path.join(registry.production_root, record.production_path)
  const accepted = path.join(root, record.accepted_path)
  if (!existsSync(production)) {
    failures.push({ id: record.id, failure: 'production source missing' })
    continue
  }
  if (!existsSync(accepted)) {
    failures.push({ id: record.id, failure: 'accepted target missing' })
    continue
  }
  if (sha256(production) !== record.production_sha256) {
    failures.push({ id: record.id, failure: 'production authority drift' })
  }
  if (sha256(accepted) !== record.accepted_sha256) {
    failures.push({ id: record.id, failure: 'accepted target drift' })
  }
  if (!Array.isArray(record.classifications) || record.classifications.length === 0 || record.classifications.some(value => !allowed.has(value))) {
    failures.push({ id: record.id, failure: 'classification is not closed' })
  }
  if (record.classifications.includes('UNKNOWN')) {
    failures.push({ id: record.id, failure: 'UNKNOWN may not pass reconciliation' })
  }
  const source = readFileSync(accepted, 'utf8')
  for (const pattern of record.accepted_patterns || []) {
    if (!source.includes(pattern)) failures.push({ id: record.id, failure: `missing accepted pattern: ${pattern}` })
  }
  for (const pattern of record.forbidden_accepted_patterns || []) {
    if (source.includes(pattern)) failures.push({ id: record.id, failure: `obsolete or unsafe pattern remains: ${pattern}` })
  }
}

const ids = registry.records.map(record => record.id)
if (new Set(ids).size !== ids.length) failures.push({ failure: 'duplicate registry id' })
const counts = Object.fromEntries([...allowed].map(classification => [
  classification,
  registry.records.filter(record => record.classifications.includes(classification)).length,
]))
const output = {
  status: failures.length ? 'FAIL' : 'PASS',
  authority: registry.production_authority,
  records: registry.records.length,
  counts,
  unknown_remaining: counts.UNKNOWN,
  production_drift: failures.filter(item => item.failure === 'production authority drift').length,
  accepted_drift: failures.filter(item => item.failure === 'accepted target drift').length,
  failures,
}
process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
if (failures.length) process.exitCode = 1
