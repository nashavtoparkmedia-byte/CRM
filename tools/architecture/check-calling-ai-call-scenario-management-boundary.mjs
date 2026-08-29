#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { scanArchitecture } from './enforce-architecture.mjs'

const root = process.cwd()
const read = (relative) => readFileSync(path.join(root, relative), 'utf8')
const sha256 = (source) => createHash('sha256').update(source).digest('hex')
const consumers = [
  'gravity-mvp/src/app/api/settings/ai-call-projects/route.ts',
  'gravity-mvp/src/app/api/settings/ai-call-scenarios/route.ts',
  'gravity-mvp/src/app/api/settings/ai-call-scenarios/[id]/route.ts',
]

for (const consumer of consumers) {
  const source = read(consumer)
  assert.match(source, /@\/modules\/calling\/public\/v1\/ai-call-scenario-management/)
  assert.doesNotMatch(source, /@\/lib\/ai-call\/scenarios/)
}

const facade = read('gravity-mvp/src/modules/calling/public/v1/ai-call-scenario-management.ts')
assert.equal(sha256(facade), '2b7f352001184c2c7a28dbb217e5199ca6ddf12d444c680a8e24634e8b2ed654')
assert.match(facade, /@\/lib\/ai-call\/scenarios/)
assert.doesNotMatch(facade, /export \*|prisma|\$queryRaw|\$executeRaw/)
for (const operation of ['createScenario', 'deleteScenario', 'getScenario', 'listProjects', 'listScenarios', 'updateScenario']) {
  assert.match(facade, new RegExp(`\\b${operation},`))
}

const implementation = read('gravity-mvp/src/lib/ai-call/scenarios.ts')
assert.equal(sha256(implementation), '21421c56862d725fca27fc10e3b4da82634539bd7d4c1de4ff50b748e370695b')
assert.match(implementation, /await db\.aiCallScenario\.create\(/)
assert.match(implementation, /await db\.aiCallScenario\.update\(/)
assert.match(implementation, /data: \{ isActive: false \}/)

const collection = read(consumers[1])
assert(collection.indexOf('getCurrentUser()') < collection.indexOf('listScenarios('))
assert(collection.indexOf("user.role !== 'Администратор'") < collection.indexOf('createScenario({'))
assert(collection.indexOf("if (!name)") < collection.indexOf('createScenario({'))
assert(collection.indexOf("if (!systemPrompt)") < collection.indexOf('createScenario({'))

const item = read(consumers[2])
assert(item.indexOf('getCurrentUser()') < item.indexOf('getScenario(id)'))
assert(item.indexOf("user.role !== 'Администратор'") < item.indexOf('updateScenario(id,'))
assert(item.lastIndexOf("user.role !== 'Администратор'") < item.indexOf('deleteScenario(id)'))

const manifest = JSON.parse(read('architecture/contexts/v1/manifests/calling.json'))
assert(manifest.public_surface.includes('AiCallScenarioManagement.v1'))

const scan = await scanArchitecture(root)
assert.deepEqual(scan.findings.filter((finding) =>
  consumers.includes(finding.file)
  && (finding.details?.target === 'gravity-mvp/src/lib/ai-call/scenarios.ts'
    || finding.details?.target?.endsWith('/modules/calling/public/v1/ai-call-scenario-management.ts'))), [])

const registry = JSON.parse(read('architecture/enforcement/v1/exceptions.json'))
const live = new Set(scan.findings.map((finding) => finding.fingerprint))
assert.equal(registry.exceptions.filter((entry) => !live.has(entry.fingerprint)).length, 0)

process.stdout.write(`${JSON.stringify({
  status: 'PASS',
  consumers: consumers.length,
  implementation_sha256: sha256(implementation),
  current_findings: scan.findings.length,
  registry_entries: registry.exceptions.length,
}, null, 2)}\n`)
