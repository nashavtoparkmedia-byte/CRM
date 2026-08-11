#!/usr/bin/env node

import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { scanArchitecture } from './enforce-architecture.mjs'

const root = process.cwd()
const read = (relative) => readFileSync(path.join(root, relative), 'utf8')
const walk = (relative) => readdirSync(path.join(root, relative), { withFileTypes: true })
  .flatMap((entry) => {
    const child = path.posix.join(relative, entry.name)
    return entry.isDirectory() ? walk(child) : [child]
  })

const legacyTargets = [
  'gravity-mvp/src/store/tasks-store.ts',
  'gravity-mvp/src/store/list-view-store.ts',
  'gravity-mvp/src/store/tasks-selectors.ts',
  'gravity-mvp/src/hooks/use-task-mutations.ts',
  'gravity-mvp/src/hooks/use-tasks-query.ts',
]
const forbiddenImports = /@\/(?:store\/(?:tasks-store|list-view-store|tasks-selectors)|hooks\/(?:use-task-mutations|use-tasks-query))/
const taskConsumers = walk('gravity-mvp/src/app/tasks').filter((file) => /\.[cm]?[jt]sx?$/.test(file))
for (const consumer of taskConsumers) assert.doesNotMatch(read(consumer), forbiddenImports)

for (const shim of legacyTargets) {
  const source = read(shim)
  assert.match(source, /@\/modules\/work-management\/public\/v1\/client-state\//)
  assert.doesNotMatch(source, /export \*/)
}

const ownerFiles = walk('gravity-mvp/src/modules/work-management/public/v1/client-state')
  .filter((file) => /\.tsx?$/.test(file) && !file.endsWith('.test.ts'))
for (const ownerFile of ownerFiles) {
  const source = read(ownerFile)
  assert.doesNotMatch(source, forbiddenImports)
  assert.doesNotMatch(source, /@\/lib\/prisma|export \*/)
}

const scan = await scanArchitecture(root)
assert.deepEqual(scan.findings.filter((finding) => legacyTargets.includes(finding.details?.target)), [])
assert.deepEqual(scan.findings.filter((finding) => ownerFiles.includes(finding.file)), [])

const registry = JSON.parse(read('architecture/enforcement/v1/exceptions.json'))
const live = new Set(scan.findings.map((finding) => finding.fingerprint))
assert.equal(registry.exceptions.filter((entry) =>
  (taskConsumers.includes(entry.file) || ownerFiles.includes(entry.file)) && !live.has(entry.fingerprint)).length, 0)

process.stdout.write(`${JSON.stringify({
  status: 'PASS',
  task_consumers: taskConsumers.length,
  owner_files: ownerFiles.length,
  current_findings: scan.findings.length,
  registry_entries: registry.exceptions.length,
}, null, 2)}\n`)
