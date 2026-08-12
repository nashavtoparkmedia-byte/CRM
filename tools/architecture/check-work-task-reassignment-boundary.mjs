#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { scanArchitecture } from './enforce-architecture.mjs'

const root = process.cwd()
const read = (relative) => readFileSync(path.join(root, relative), 'utf8')
const sha256 = (source) => createHash('sha256').update(source).digest('hex')
const legacyConsumerPath = 'gravity-mvp/src/app/team-overview/actions.ts'
const routePath = 'gravity-mvp/src/app/api/tasks/reassign/route.ts'
const workPublicPath = 'gravity-mvp/src/modules/work-management/public/v1/index.ts'
const workHandlerPath = 'gravity-mvp/src/modules/work-management/public/v1/reassign-tasks-handler.ts'
const identityAdapterPath = 'gravity-mvp/src/modules/identity-access/public/v1/legacy-prisma-crm-user-query-adapter.ts'
const exactCapabilities = ['reassignTasks']

function capabilityKeys(source) {
    const body = source.match(/taskReassignmentV1 = Object\.freeze\(\{([\s\S]*?)\n\}\)/)?.[1] ?? ''
    return [...body.matchAll(/^\s+(\w+):/gm)].map((match) => match[1]).sort()
}

const legacyConsumer = read(legacyConsumerPath)
const route = read(routePath)
const workPublic = read(workPublicPath)
const workHandler = read(workHandlerPath)
const identityAdapter = read(identityAdapterPath)

assert.deepEqual(capabilityKeys(workPublic), exactCapabilities)
assert.match(workPublic, /queryCrmUserV1\(\{ contract: CRM_USER_QUERY_V1, userId \}\)/)
assert.doesNotMatch(workPublic, /deleteTasks|updateTask|export \*/)
const unrelatedWriteProbe = workPublic.replace(
    /\n\}\)\nexport const completeTaskV1/,
    '\n  deleteTasks: (taskIds) => deleteTasks(taskIds),\n})\nexport const completeTaskV1',
)
assert.notDeepEqual(capabilityKeys(unrelatedWriteProbe), exactCapabilities)

assert.match(route, /@\/modules\/work-management\/public\/v1/)
assert.match(route, /taskReassignmentV1\.reassignTasks\(\{/)
assert.match(route, /REASSIGN_TASKS_COMMAND_V1/)
assert.doesNotMatch(route, /@\/app\/team-overview\/actions/)
assert.doesNotMatch(legacyConsumer, /export async function reassignTasks/)
assert.doesNotMatch(legacyConsumer, /crmUser\.findUnique/)

assert.match(identityAdapter, /prisma\.crmUser\.findUnique\(\{/)
assert.match(identityAdapter, /select: \{ id: true, name: true \}/)
assert.doesNotMatch(identityAdapter, /\.(?:create|update|updateMany|upsert|delete|deleteMany)\s*\(/)
assert.match(workHandler, /if \(parsed\.taskIds\.length === 0\)/)
assert(workHandler.indexOf('parsed.taskIds.length === 0') < workHandler.indexOf('port.findTargetUser'))
assert.match(workHandler, /throw new Error\('Target user not found'\)/)
assert.match(workHandler, /for \(const taskId of parsed\.taskIds\)/)
assert.match(workHandler, /if \(status === 'reassigned'\) reassigned\+\+/)
assert.equal(
    sha256(read('gravity-mvp/src/modules/work-management/public/v1/legacy-prisma-assignment-adapter.ts')),
    'c5be7f588d2f4b8c7dcb67abc244f8281c5e5b6af356b580963d49bcdb8a8f35',
)

const identityManifest = JSON.parse(read('architecture/contexts/v1/manifests/identity_access.json'))
const workManifest = JSON.parse(read('architecture/contexts/v1/manifests/work_management.json'))
assert(identityManifest.public_surface.includes('CrmUserQuery.v1'))
assert(workManifest.commands.includes('ReassignTasksCommand.v1'))
assert(workManifest.public_surface.includes('TaskReassignment.v1'))
assert(workManifest.allowed_dependencies.some((dependency) => (
    dependency.context === 'identity_access' && dependency.surface === 'identity_access.public'
)))

const scan = await scanArchitecture(root)
assert.deepEqual(scan.findings.filter((finding) => (
    finding.file === routePath && finding.details?.target === legacyConsumerPath
)), [])
assert.deepEqual(scan.findings.filter((finding) => finding.rule === 'dependency_graph_cycle'), [])

process.stdout.write(`${JSON.stringify({
    status: 'PASS',
    runtime_consumers: 1,
    write_capabilities: exactCapabilities.length,
    negative_unrelated_write_probe: 'REJECTED',
    legacy_identity_source: 'PRESERVED',
    dependency_cycle: 'ABSENT',
    current_findings: scan.findings.length,
}, null, 2)}\n`)
