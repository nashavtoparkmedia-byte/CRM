#!/usr/bin/env node

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { scanArchitecture } from './enforce-architecture.mjs'

const root = process.cwd()
const read = (relative) => readFileSync(path.join(root, relative), 'utf8')
const scenarioConsumers = [
  'gravity-mvp/src/app/messages/components/ChatHeader.tsx',
  'gravity-mvp/src/app/messages/components/DriverTasksWidget.tsx',
  'gravity-mvp/src/app/settings/scenarios/[id]/fields/page.tsx',
  'gravity-mvp/src/app/team-overview/ReassignModal.tsx',
  'gravity-mvp/src/app/team-overview/TeamOverviewContent.tsx',
]
const policyConsumers = [
  'gravity-mvp/src/app/team-overview/InterventionActionModal.tsx',
  'gravity-mvp/src/app/team-overview/TeamOverviewContent.tsx',
  'gravity-mvp/src/app/team-overview/actions.ts',
  'gravity-mvp/src/lib/config-validator.ts',
]
const consumers = [...new Set([...scenarioConsumers, ...policyConsumers])]

for (const consumer of consumers) {
  assert.doesNotMatch(read(consumer), /@\/lib\/tasks\/[^'"\n]*config/)
}
for (const consumer of scenarioConsumers) {
  assert.match(read(consumer), /@\/modules\/work-management\/public\/v1\/scenario-catalog/)
}
for (const consumer of policyConsumers) {
  assert.match(read(consumer), /@\/modules\/work-management\/public\/v1\/team-operational-policy/)
}

const scenarioCatalog = read('gravity-mvp/src/modules/work-management/public/v1/scenario-catalog.ts')
assert.doesNotMatch(scenarioCatalog, /export \*|SCENARIOS|getRecommendedNext|getMainScenarioIds/)
assert.match(scenarioCatalog, /export \{ getScenario, getStage \}/)

const policy = read('gravity-mvp/src/modules/work-management/public/v1/team-operational-policy.ts')
assert.doesNotMatch(policy, /export \*|@\/lib\/prisma|\$queryRaw|\$executeRaw|Service|Repository/)
const policyTargets = [...policy.matchAll(/from '(@\/lib\/tasks\/[^']+)'/g)].map((match) => match[1])
assert.equal(new Set(policyTargets).size, 16)
assert(policyTargets.every((target) => target.endsWith('-config')))

const manifest = JSON.parse(read('architecture/contexts/v1/manifests/work_management.json'))
assert(manifest.public_surface.includes('ScenarioCatalog.v1'))
assert(manifest.public_surface.includes('TeamOperationalPolicy.v1'))

const scan = await scanArchitecture(root)
const oldPolicyTarget = /^gravity-mvp\/src\/lib\/tasks\/[^/]*config\.ts$/
assert.deepEqual(scan.findings.filter((finding) =>
  consumers.includes(finding.file) && oldPolicyTarget.test(finding.details?.target ?? '')), [])
assert.deepEqual(scan.findings.filter((finding) =>
  consumers.includes(finding.file)
  && /\/modules\/work-management\/public\/v1\/(?:scenario-catalog|team-operational-policy)\.ts$/.test(finding.details?.target ?? '')), [])

const registry = JSON.parse(read('architecture/enforcement/v1/exceptions.json'))
const live = new Set(scan.findings.map((finding) => finding.fingerprint))
assert.equal(registry.exceptions.filter((entry) =>
  consumers.includes(entry.file) && !live.has(entry.fingerprint)).length, 0)

process.stdout.write(`${JSON.stringify({
  status: 'PASS',
  consumers: consumers.length,
  retired_policy_targets: 17,
  current_findings: scan.findings.length,
  registry_entries: registry.exceptions.length,
}, null, 2)}\n`)
