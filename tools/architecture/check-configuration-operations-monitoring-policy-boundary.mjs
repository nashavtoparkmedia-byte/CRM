#!/usr/bin/env node

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { scanArchitecture } from './enforce-architecture.mjs'

const root = process.cwd()
const read = (relative) => readFileSync(path.join(root, relative), 'utf8')
const policyPath = 'gravity-mvp/src/modules/configuration/public/v1/operations-monitoring-policy.ts'
const validatorPath = 'gravity-mvp/src/lib/config-validator.ts'
const failurePath = 'gravity-mvp/src/lib/failure-detection.ts'
const performancePath = 'gravity-mvp/src/lib/perf-monitor.ts'

const policy = read(policyPath)
assert.match(policy, /FAILURE_DETECTION_CONFIG_V1 = Object\.freeze\(\{/)
assert.match(policy, /PERFORMANCE_MONITORING_CONFIG_V1 = Object\.freeze\(\{/)
assert.doesNotMatch(policy, /prisma|@\/lib|@\/app|process\.env|export \*|function|class/i)
for (const literal of [
    'windowHours: 24',
    'warningConsecutiveErrors: 2',
    'criticalConsecutiveErrors: 5',
    'warningErrorRatePct: 20',
    'criticalErrorRatePct: 50',
    'staleWarningHours: 2',
    'staleCriticalHours: 6',
    'defaultSlowThresholdMs: 5000',
    'cronSlowThresholdMs: 30000',
    'apiSlowThresholdMs: 3000',
    'querySlowThresholdMs: 2000',
    'maxLogEntries: 10000',
    'retentionDays: 7',
]) assert.match(policy, new RegExp(literal))

const validator = read(validatorPath)
assert.match(validator, /@\/modules\/configuration\/public\/v1\/operations-monitoring-policy/g)
assert.doesNotMatch(validator, /@\/lib\/(?:failure-detection|perf-monitor)/)

const failure = read(failurePath)
const performance = read(performancePath)
assert.match(failure, /FAILURE_DETECTION_CONFIG = FAILURE_DETECTION_CONFIG_V1/)
assert.match(performance, /PERF_CONFIG = PERFORMANCE_MONITORING_CONFIG_V1/)
assert.doesNotMatch(failure + performance, /(?:windowHours|defaultSlowThresholdMs):\s*\d/)

const configurationManifest = JSON.parse(read('architecture/contexts/v1/manifests/configuration.json'))
const operationsManifest = JSON.parse(read('architecture/contexts/v1/manifests/operations_observability.json'))
assert(configurationManifest.public_surface.includes('OperationsMonitoringPolicy.v1'))
assert(operationsManifest.allowed_dependencies.some((dependency) => (
    dependency.context === 'configuration' && dependency.surface === 'configuration.public'
)))

const scan = await scanArchitecture(root)
assert.deepEqual(scan.findings.filter((finding) => (
    finding.file === validatorPath && [failurePath, performancePath].includes(finding.details?.target)
)), [])
assert.deepEqual(scan.findings.filter((finding) => finding.rule === 'dependency_graph_cycle'), [])

process.stdout.write(`${JSON.stringify({
    status: 'PASS',
    immutable_policies: 2,
    retired_reverse_dependency_findings: 4,
    operations_to_configuration_dependency: 'EXISTING',
    dependency_cycle: 'ABSENT',
    current_findings: scan.findings.length,
}, null, 2)}\n`)
