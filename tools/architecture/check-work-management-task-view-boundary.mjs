#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { scanArchitecture } from './enforce-architecture.mjs'

const root = process.cwd()
const read = (relative) => readFileSync(path.join(root, relative), 'utf8')
const sha256 = (source) => createHash('sha256').update(source).digest('hex')
const queryImplementationPath = 'gravity-mvp/src/app/tasks/actions.ts'
const typeImplementationPath = 'gravity-mvp/src/lib/tasks/types.ts'
const cardImplementationPath = 'gravity-mvp/src/app/tasks/components/TaskCard.tsx'
const modalImplementationPath = 'gravity-mvp/src/app/tasks/components/TaskCreateModal.tsx'
const queryPublicPath = 'gravity-mvp/src/modules/work-management/public/v1/task-query.ts'
const viewPublicPath = 'gravity-mvp/src/modules/work-management/public/v1/task-view.ts'
const consumers = [
    'gravity-mvp/src/app/messages/components/ChatHeader.tsx',
    'gravity-mvp/src/app/messages/components/DriverTasksWidget.tsx',
    'gravity-mvp/src/app/messages/components/ChatWorkspace.tsx',
    'gravity-mvp/src/app/messages/components/ContactProfileDrawer.tsx',
]

assert.equal(sha256(read(queryImplementationPath)), '42c89e0978f2fdc6bf55c0c1669abec5bdacafda4da75ef5b5dd55fdba397e29')
assert.equal(sha256(read(typeImplementationPath)), 'cf8f93c0e2145962c45141f227a23688c9c479ad2a0e5d185d8247572d474d11')
assert.equal(sha256(read(cardImplementationPath)), 'd4f64fc476c94d3b4a1275025b18559124c74f3b101a50abb0f43c06703daa78')
assert.equal(sha256(read(modalImplementationPath)), 'b169fbaa6ffd14bf5a15fec74edf8f311b03d44bf0dc5bda70d2607eb9925cea')

function exportedPublicNames(source) {
    const aliases = [...source.matchAll(/export\s+(?:type\s+)?\{([\s\S]*?)\}\s+from/g)]
        .flatMap((match) => match[1].split(','))
        .map((entry) => entry.trim())
        .filter(Boolean)
        .map((entry) => entry.match(/\bas\s+(\w+)$/)?.[1] ?? entry)
    const functions = [...source.matchAll(/export\s+async\s+function\s+(\w+)/g)].map((match) => match[1])
    return [...aliases, ...functions].sort()
}

const queryPublic = read(queryPublicPath)
const viewPublic = read(viewPublicPath)
assert.deepEqual(exportedPublicNames(queryPublic), ['getDriverActiveTasksV1'])
assert.deepEqual(exportedPublicNames(viewPublic), ['WorkTaskCardV1', 'WorkTaskCreateModalV1', 'WorkTaskViewV1'])
assert.match(queryPublic, /export\s+async\s+function\s+getDriverActiveTasksV1\s*\(/)
assert.doesNotMatch(queryPublic, /create|update|delete|resolve|assign|export \*/i)
assert.doesNotMatch(viewPublic, /TaskDetails|TaskBoard|export \*/)
const unrelatedQueryProbe = `${queryPublic}\nexport { updateTask as updateTaskV1 } from '@/app/tasks/actions'\n`
assert.notDeepEqual(exportedPublicNames(unrelatedQueryProbe), ['getDriverActiveTasksV1'])
const unrelatedViewProbe = `${viewPublic}\nexport { default as TaskDetailsPaneV1 } from '@/app/tasks/components/TaskDetailsPane'\n`
assert.notDeepEqual(exportedPublicNames(unrelatedViewProbe), ['WorkTaskCardV1', 'WorkTaskCreateModalV1', 'WorkTaskViewV1'])

for (const consumerPath of consumers.slice(0, 2)) {
    const consumer = read(consumerPath)
    assert.match(consumer, /@\/modules\/work-management\/public\/v1\/task-query/)
    assert.match(consumer, /@\/modules\/work-management\/public\/v1\/task-view/)
    assert.doesNotMatch(consumer, /@\/app\/tasks\/actions|@\/lib\/tasks\/types/)
}
assert.doesNotMatch(read(consumers[1]), /@\/app\/tasks\/components\/TaskCard/)
for (const consumerPath of consumers.slice(2)) {
    const consumer = read(consumerPath)
    assert.match(consumer, /WorkTaskCreateModalV1 as TaskCreateModal/)
    assert.match(consumer, /@\/modules\/work-management\/public\/v1\/task-view/)
    assert.doesNotMatch(consumer, /@\/app\/tasks\/components\/TaskCreateModal/)
}

const manifest = JSON.parse(read('architecture/contexts/v1/manifests/work_management.json'))
assert(manifest.public_surface.includes('TaskQuery.v1'))
assert(manifest.public_surface.includes('TaskView.v1'))

const scan = await scanArchitecture(root)
const privateTargets = new Set([queryImplementationPath, typeImplementationPath, cardImplementationPath, modalImplementationPath])
assert.deepEqual(scan.findings.filter((finding) => (
    consumers.includes(finding.file) && privateTargets.has(finding.details?.target)
)), [])

process.stdout.write(`${JSON.stringify({
    status: 'PASS',
    runtime_consumers: consumers.length,
    query_capabilities: 1,
    view_capabilities: 3,
    negative_unrelated_capability_probes: 'REJECTED',
    current_findings: scan.findings.length,
}, null, 2)}\n`)
