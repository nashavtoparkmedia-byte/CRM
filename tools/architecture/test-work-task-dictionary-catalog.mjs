#!/usr/bin/env node

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const root = process.cwd()
const compiler = process.env.YOKO_TSC_PATH
    ?? path.join(root, 'gravity-mvp/node_modules/typescript/bin/tsc')
const output = mkdtempSync(path.join(tmpdir(), 'yoko-work-task-dictionary-build-'))
const sandbox = mkdtempSync(path.join(tmpdir(), 'yoko-work-task-dictionary-data-'))
const sources = [
    'gravity-mvp/src/contracts/work-management/v1/task-dictionary-catalog.ts',
    'gravity-mvp/src/modules/work-management/internal/task-dictionary-store.ts',
    'gravity-mvp/src/modules/work-management/application/task-dictionary-operations.ts',
].map((value) => path.join(root, value))

const compile = spawnSync(process.execPath, [
    compiler,
    '--target', 'ES2022',
    '--module', 'commonjs',
    '--moduleResolution', 'node',
    '--strict',
    '--skipLibCheck',
    '--esModuleInterop',
    '--types', 'node',
    '--typeRoots', path.join(root, 'gravity-mvp/node_modules/@types'),
    '--rootDir', path.join(root, 'gravity-mvp/src'),
    '--outDir', output,
    ...sources,
], { encoding: 'utf8' })

if (compile.status !== 0) {
    process.stderr.write(compile.stdout)
    process.stderr.write(compile.stderr)
    rmSync(output, { recursive: true, force: true })
    rmSync(sandbox, { recursive: true, force: true })
    process.exit(1)
}

const fixture = {
    scenarios: [{ id: 'contact', label: 'Контакт', isActive: true }],
    events: [],
    statuses: [],
    priorities: [],
    sources: [],
    history_actions: [],
    contact_results: [],
    next_actions: [],
}
const dataDirectory = path.join(sandbox, 'src/data')
const dataPath = path.join(dataDirectory, 'dictionaries.json')
mkdirSync(dataDirectory, { recursive: true })
writeFileSync(dataPath, JSON.stringify(fixture, null, 2))

const originalCwd = process.cwd()
const originalRandom = Math.random
const originalError = console.error
const checks = []
const checkAsync = async (name, body) => {
    await body()
    checks.push(name)
}

try {
    process.chdir(sandbox)
    const require = createRequire(import.meta.url)
    const store = require(path.join(
        output,
        'modules/work-management/internal/task-dictionary-store.js',
    ))

    await checkAsync('catalog reads the exact JSON projection', async () => {
        assert.deepEqual(await store.getTaskDictionaries(), fixture)
    })
    await checkAsync('add preserves generated-id push and formatted persistence', async () => {
        Math.random = () => 0.123456789
        const item = await store.addTaskDictionaryItem('events', {
            label: 'Позвонить',
            isActive: true,
            metadata: { scenario: 'contact' },
        })
        assert.equal(item.id, (0.123456789).toString(36).substring(2, 9))
        const persisted = JSON.parse(readFileSync(dataPath, 'utf8'))
        assert.deepEqual(persisted.events, [item])
    })
    await checkAsync('update merges a patch and missing ids remain no-ops', async () => {
        const current = JSON.parse(readFileSync(dataPath, 'utf8'))
        const id = current.events[0].id
        await store.updateTaskDictionaryItem('events', id, { isActive: false })
        assert.equal(JSON.parse(readFileSync(dataPath, 'utf8')).events[0].isActive, false)
        const beforeMissing = readFileSync(dataPath, 'utf8')
        await store.updateTaskDictionaryItem('events', 'missing', { label: 'ignored' })
        assert.equal(readFileSync(dataPath, 'utf8'), beforeMissing)
    })
    await checkAsync('delete filters the selected dictionary and persists', async () => {
        const id = JSON.parse(readFileSync(dataPath, 'utf8')).events[0].id
        await store.deleteTaskDictionaryItem('events', id)
        assert.deepEqual(JSON.parse(readFileSync(dataPath, 'utf8')).events, [])
    })
    await checkAsync('read failure retains the logged empty-catalog fallback', async () => {
        rmSync(dataPath)
        let logged = false
        console.error = (...args) => {
            logged = args[0] === 'Failed to read dictionaries:'
        }
        assert.deepEqual(await store.getTaskDictionaries(), {})
        assert.equal(logged, true)
    })
} finally {
    process.chdir(originalCwd)
    Math.random = originalRandom
    console.error = originalError
    rmSync(output, { recursive: true, force: true })
    rmSync(sandbox, { recursive: true, force: true })
}

process.stdout.write(`${JSON.stringify({ status: 'PASS', passed: checks.length, checks }, null, 2)}\n`)
