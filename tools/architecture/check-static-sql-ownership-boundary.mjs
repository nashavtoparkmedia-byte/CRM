#!/usr/bin/env node
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { scanArchitecture } from './enforce-architecture.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const scan = await scanArchitecture(root)
const direct = scan.findings.filter((finding) => finding.rule === 'direct_foreign_prisma_write')
const ownerLocalDdlFiles = new Set([
    'gravity-mvp/src/lib/config-validator.ts',
    'gravity-mvp/src/lib/cron-health.ts',
    'gravity-mvp/src/lib/execution-lock.ts',
    'gravity-mvp/src/lib/IntegrityChecker.ts',
    'gravity-mvp/src/lib/perf-monitor.ts',
    'gravity-mvp/src/lib/stability-check.ts',
])

const checks = [
    ['all 12 owner-local DDL false findings are retired', direct.every((finding) => !ownerLocalDdlFiles.has(finding.file))],
    ['103 genuine foreign or dynamic writes remain explicit', direct.length === 103],
    ['no unexceptionable finding exists', scan.findings.every((finding) => !scan.policy.unexceptionable_rules.includes(finding.rule))],
    ['all source files remain classified', !scan.findings.some((finding) => finding.rule === 'unclassified_production_source')],
    ['effective dependency graph remains acyclic', !scan.findings.some((finding) => finding.rule === 'dependency_graph_cycle')],
]

for (const [name, passed] of checks) {
    assert.equal(passed, true, name)
    process.stdout.write(`ok - ${name}\n`)
}
process.stdout.write(`${checks.length}/${checks.length} static SQL ownership boundary checks passed\n`)
