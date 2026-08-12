#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { scanArchitecture } from './enforce-architecture.mjs'

const root = process.cwd()
const read = (relative) => readFileSync(path.join(root, relative), 'utf8')
const sha256 = (source) => createHash('sha256').update(source).digest('hex')
const oldPath = 'gravity-mvp/src/lib/dictionaries/dictionary-service.ts'
const publicPath = 'gravity-mvp/src/modules/work-management/public/v1/task-dictionary-catalog.ts'
const storePath = 'gravity-mvp/src/modules/work-management/internal/task-dictionary-store.ts'
const taskConsumerPath = 'gravity-mvp/src/app/tasks/components/TaskDetailsPane.tsx'
const settingsConsumerPath = 'gravity-mvp/src/app/settings/dictionaries/page.tsx'
const exactCapabilities = [
    'addTaskDictionaryItemV1',
    'deleteTaskDictionaryItemV1',
    'getTaskDictionariesV1',
    'updateTaskDictionaryItemV1',
]

function capabilityNames(source) {
    return [...source.matchAll(/export async function (\w+)/g)]
        .map((match) => match[1])
        .sort()
}

assert.equal(existsSync(path.join(root, oldPath)), false)
const publicSource = read(publicPath)
const store = read(storePath)
const taskConsumer = read(taskConsumerPath)
const settingsConsumer = read(settingsConsumerPath)

assert.deepEqual(capabilityNames(publicSource), exactCapabilities)
assert.doesNotMatch(publicSource, /fs\/promises|dictionaries\.json|writeFile|export \*/)
const unrelatedWriteProbe = `${publicSource}\nexport async function deleteAllTaskDictionariesV1() {}\n`
assert.notDeepEqual(capabilityNames(unrelatedWriteProbe), exactCapabilities)

assert.match(store, /path\.join\(process\.cwd\(\), 'src\/data\/dictionaries\.json'\)/)
assert.match(store, /Math\.random\(\)\.toString\(36\)\.substring\(2, 9\)/)
assert.match(store, /dicts\[type\]\.push\(newItem\)/)
assert.match(store, /const idx = list\.findIndex\(\(item\) => item\.id === id\)/)
assert.match(store, /if \(idx !== -1\)/)
assert.match(store, /dicts\[type\] = dicts\[type\]\.filter\(\(item\) => item\.id !== id\)/)
assert.match(store, /console\.error\('Failed to read dictionaries:', error\)/)
assert.match(store, /return \{\} as TaskDictionariesV1/)

for (const source of [taskConsumer, settingsConsumer]) {
    assert.match(source, /@\/modules\/work-management\/public\/v1\/task-dictionary-catalog/)
    assert.doesNotMatch(source, /@\/lib\/dictionaries\/dictionary-service/)
}
assert.match(taskConsumer, /getTaskDictionariesV1\(\)\.then\(setDicts\)/)
for (const capability of exactCapabilities) assert.match(settingsConsumer, new RegExp(`\\b${capability}\\b`))

const configurationManifest = JSON.parse(read('architecture/contexts/v1/manifests/configuration.json'))
const workManifest = JSON.parse(read('architecture/contexts/v1/manifests/work_management.json'))
assert(!configurationManifest.internal_surface.includes('gravity-mvp/src/lib/dictionaries'))
assert(!configurationManifest.responsibility.includes('dictionaries'))
assert(workManifest.public_surface.includes('TaskDictionaryCatalog.v1'))
assert(workManifest.responsibility.includes('task dictionaries'))
assert.equal(
    sha256(read('gravity-mvp/src/data/dictionaries.json')),
    'f936573c34c6365d8944dc2ce96567813b6a5bc8dd175f4ac7b066b534505899',
)

const scan = await scanArchitecture(root)
assert.deepEqual(scan.findings.filter((finding) => (
    [taskConsumerPath, settingsConsumerPath].includes(finding.file)
    && finding.details?.target === oldPath
)), [])
assert.deepEqual(scan.findings.filter((finding) => finding.rule === 'dependency_graph_cycle'), [])

process.stdout.write(`${JSON.stringify({
    status: 'PASS',
    task_consumers: 1,
    configuration_consumers: 1,
    capabilities: exactCapabilities.length,
    negative_unrelated_write_probe: 'REJECTED',
    dictionary_data: 'BYTE_IDENTICAL',
    dependency_cycle: 'ABSENT',
    current_findings: scan.findings.length,
}, null, 2)}\n`)
