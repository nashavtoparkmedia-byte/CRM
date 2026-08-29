#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { createRequire } from 'node:module'

const root = process.cwd()
const consumerPath = path.join(root, 'gravity-mvp/src/app/team-overview/actions.ts')
const pureConfigPath = path.join(root, 'gravity-mvp/src/lib/tasks/manager-health-config.ts')
const consumerSource = readFileSync(consumerPath, 'utf8')
const pureConfigSource = readFileSync(pureConfigPath, 'utf8')
const require = createRequire(import.meta.url)
const typescript = require(path.join(root, 'gravity-mvp/node_modules/typescript/lib/typescript.js'))
const consumerAst = typescript.createSourceFile(
    consumerPath,
    consumerSource,
    typescript.ScriptTarget.Latest,
    true,
    typescript.ScriptKind.TS,
)
const namedImportsFrom = specifier => consumerAst.statements.flatMap(statement => {
    if (!typescript.isImportDeclaration(statement)
        || !typescript.isStringLiteralLike(statement.moduleSpecifier)
        || statement.moduleSpecifier.text !== specifier) return []
    const named = statement.importClause?.namedBindings
    if (!named || !typescript.isNamedImports(named)) return []
    return named.elements.map(element => ({
        imported: element.propertyName?.text ?? element.name.text,
        local: element.name.text,
        typeOnly: Boolean(statement.importClause?.isTypeOnly || element.isTypeOnly),
    }))
})
const importStatementIndex = specifier => consumerAst.statements.findIndex(statement => (
    typescript.isImportDeclaration(statement)
    && typescript.isStringLiteralLike(statement.moduleSpecifier)
    && statement.moduleSpecifier.text === specifier
))

const sliceBetween = (source, startMarker, endMarker) => {
    const start = source.indexOf(startMarker)
    if (start < 0) throw new Error(`missing start marker: ${startMarker}`)
    const end = source.indexOf(endMarker, start + startMarker.length)
    if (end < 0) throw new Error(`missing end marker: ${endMarker}`)
    return source.slice(start, end)
}

const wrapperSource = sliceBetween(
    consumerSource,
    'async function getPreviousHealthScores',
    'export async function getTeamOverview',
)
const zeroUserSource = sliceBetween(
    consumerSource,
    'if (users.length === 0)',
    'const userIds = users.map',
)

const harnessSource = `
type HealthLevel = 'healthy' | 'warning' | 'critical'
interface HealthSnapshot {
    managerId: string
    score: number
    declineStreak: number
    healthLevel: HealthLevel
}
interface PreviousHealthData { score: number; declineStreak: number }
interface HealthHistoryPoint { score: number; healthLevel: HealthLevel; recordedAt: Date }
const HEALTH_HISTORY_CONFIG = globalThis.__deps.HEALTH_HISTORY_CONFIG
const ENSURE_MANAGER_HEALTH_REPOSITORY_COMMAND_V1 = globalThis.__deps.ENSURE_MANAGER_HEALTH_REPOSITORY_COMMAND_V1
const LIST_MANAGER_HEALTH_SNAPSHOTS_QUERY_V1 = globalThis.__deps.LIST_MANAGER_HEALTH_SNAPSHOTS_QUERY_V1
const SAVE_MANAGER_HEALTH_SCORES_COMMAND_V1 = globalThis.__deps.SAVE_MANAGER_HEALTH_SCORES_COMMAND_V1
const LIST_MANAGER_HEALTH_HISTORY_QUERY_V1 = globalThis.__deps.LIST_MANAGER_HEALTH_HISTORY_QUERY_V1
const ensureManagerHealthRepositoryV1 = globalThis.__deps.ensureManagerHealthRepositoryV1
const listManagerHealthSnapshotsV1 = globalThis.__deps.listManagerHealthSnapshotsV1
const saveManagerHealthScoresV1 = globalThis.__deps.saveManagerHealthScoresV1
const listManagerHealthHistoryV1 = globalThis.__deps.listManagerHealthHistoryV1
${wrapperSource}
module.exports = { getPreviousHealthScores, saveHealthScores, getHealthHistory }
`
const harnessOutput = typescript.transpileModule(harnessSource, {
    compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2022 },
}).outputText

function loadWrappers(overrides = {}) {
    const dependencies = {
        HEALTH_HISTORY_CONFIG: { defaultPeriodDays: 7, maxPeriodDays: 30 },
        ENSURE_MANAGER_HEALTH_REPOSITORY_COMMAND_V1: 'ensure.v1',
        LIST_MANAGER_HEALTH_SNAPSHOTS_QUERY_V1: 'snapshots.v1',
        SAVE_MANAGER_HEALTH_SCORES_COMMAND_V1: 'save.v1',
        LIST_MANAGER_HEALTH_HISTORY_QUERY_V1: 'history.v1',
        async ensureManagerHealthRepositoryV1() {},
        async listManagerHealthSnapshotsV1() { return { items: [] } },
        async saveManagerHealthScoresV1() {},
        async listManagerHealthHistoryV1() { return { items: [] } },
        ...overrides,
    }
    const module = { exports: {} }
    vm.runInNewContext(harnessOutput, {
        module,
        exports: module.exports,
        __deps: dependencies,
        console: dependencies.console ?? console,
    })
    return module.exports
}

const checks = []
const check = (name, fn) => { fn(); checks.push(name) }
const checkAsync = async (name, fn) => { await fn(); checks.push(name) }
const plain = value => JSON.parse(JSON.stringify(value))
const mapEntries = map => [...map.entries()].map(([key, value]) => [key, plain(value)])

check('manager health pure module remains Prisma and Operations free with data shapes retained', () => {
    assert.equal(/@\/lib\/prisma|\bprisma\.|operations-observability/.test(pureConfigSource), false)
    assert.equal(/\$queryRaw|\$executeRaw|health_snapshots|health_score_history/.test(pureConfigSource), false)
    assert.match(pureConfigSource, /export interface HealthSnapshot \{/)
    assert.match(pureConfigSource, /export interface PreviousHealthData \{/)
    assert.match(pureConfigSource, /export interface HealthHistoryPoint \{/)
    assert.match(pureConfigSource, /export function calculateManagerHealthScore/)
    assert.match(pureConfigSource, /export function computeTeamStability/)
})

check('consumer preserves AST import ownership and imports only public Operations health surface', () => {
    const workPolicySpecifier = '@/modules/work-management/public/v1/team-operational-policy'
    const contractSpecifier = '@/contracts/operations-observability/v1'
    const operationsSpecifier = '@/modules/operations-observability/public/v1'
    const workPolicyBindings = namedImportsFrom(workPolicySpecifier)
    const contractBindings = namedImportsFrom(contractSpecifier)
    const operationsBindings = namedImportsFrom(operationsSpecifier)
    assert.equal(consumerAst.parseDiagnostics.length, 0)
    assert.deepEqual(
        workPolicyBindings.filter(binding => [
            'HEALTH_HISTORY_CONFIG',
            'calculateManagerHealthScore',
            'HealthSnapshot',
            'PreviousHealthData',
        ].includes(binding.imported)),
        [
            { imported: 'HEALTH_HISTORY_CONFIG', local: 'HEALTH_HISTORY_CONFIG', typeOnly: false },
            { imported: 'calculateManagerHealthScore', local: 'calculateManagerHealthScore', typeOnly: false },
            { imported: 'HealthSnapshot', local: 'HealthSnapshot', typeOnly: true },
            { imported: 'PreviousHealthData', local: 'PreviousHealthData', typeOnly: true },
        ],
    )
    assert.deepEqual(
        contractBindings.filter(binding => /MANAGER_HEALTH/.test(binding.imported)),
        [
            { imported: 'ENSURE_MANAGER_HEALTH_REPOSITORY_COMMAND_V1', local: 'ENSURE_MANAGER_HEALTH_REPOSITORY_COMMAND_V1', typeOnly: false },
            { imported: 'LIST_MANAGER_HEALTH_HISTORY_QUERY_V1', local: 'LIST_MANAGER_HEALTH_HISTORY_QUERY_V1', typeOnly: false },
            { imported: 'LIST_MANAGER_HEALTH_SNAPSHOTS_QUERY_V1', local: 'LIST_MANAGER_HEALTH_SNAPSHOTS_QUERY_V1', typeOnly: false },
            { imported: 'SAVE_MANAGER_HEALTH_SCORES_COMMAND_V1', local: 'SAVE_MANAGER_HEALTH_SCORES_COMMAND_V1', typeOnly: false },
        ],
    )
    assert.deepEqual(
        operationsBindings.filter(binding => /ManagerHealth/.test(binding.imported)),
        [
            { imported: 'ensureManagerHealthRepositoryV1', local: 'ensureManagerHealthRepositoryV1', typeOnly: false },
            { imported: 'listManagerHealthHistoryV1', local: 'listManagerHealthHistoryV1', typeOnly: false },
            { imported: 'listManagerHealthSnapshotsV1', local: 'listManagerHealthSnapshotsV1', typeOnly: false },
            { imported: 'saveManagerHealthScoresV1', local: 'saveManagerHealthScoresV1', typeOnly: false },
        ],
    )
    assert.ok(importStatementIndex(workPolicySpecifier) < importStatementIndex(contractSpecifier))
    assert.ok(importStatementIndex(contractSpecifier) < importStatementIndex(operationsSpecifier))
    assert.equal(workPolicyBindings.some(binding => /getPreviousHealthScores|saveHealthScores|getHealthHistory/.test(binding.imported)), false)
    assert.equal(/from ['"]@\/modules\/operations-observability\/(?:application|internal|public\/v1\/)/.test(consumerSource), false)
    assert.equal(/FROM health_|INSERT INTO health_|CREATE TABLE IF NOT EXISTS health_|\bprisma\.health_/.test(consumerSource), false)
})

check('wrapper source freezes empty guards ensure order cap mapping and exact fallback log', () => {
    const previous = sliceBetween(wrapperSource, 'async function getPreviousHealthScores', 'async function saveHealthScores')
    const save = sliceBetween(wrapperSource, 'async function saveHealthScores', 'async function getHealthHistory')
    const history = wrapperSource.slice(wrapperSource.indexOf('async function getHealthHistory'))
    assert.ok(previous.indexOf('await ensureManagerHealthRepositoryV1') < previous.indexOf('await listManagerHealthSnapshotsV1'))
    assert.ok(previous.indexOf('await listManagerHealthSnapshotsV1') < previous.indexOf('new Map<string, PreviousHealthData>()'))
    assert.ok(save.indexOf('if (snapshots.length === 0) return') < save.indexOf('await ensureManagerHealthRepositoryV1'))
    assert.ok(save.indexOf('await ensureManagerHealthRepositoryV1') < save.indexOf('await saveManagerHealthScoresV1'))
    assert.ok(history.indexOf('new Map<string, HealthHistoryPoint[]>()') < history.indexOf('if (managerIds.length === 0) return result'))
    assert.ok(history.indexOf('if (managerIds.length === 0) return result') < history.indexOf('await ensureManagerHealthRepositoryV1'))
    assert.ok(history.indexOf('await ensureManagerHealthRepositoryV1') < history.indexOf('const days = Math.min('))
    assert.ok(history.indexOf('const days = Math.min(') < history.indexOf('await listManagerHealthHistoryV1'))
    assert.equal(/Math\.max|Math\.floor|Math\.ceil|Math\.round/.test(history), false)
    assert.match(history, /console\.error\('\[health-history\] Failed to read history, returning empty:', e\)/)
})

check('zero-user projection exits before every manager health repository operation', () => {
    const zeroStart = consumerSource.indexOf('if (users.length === 0)')
    const firstHealthRead = consumerSource.indexOf('const previousData = await getPreviousHealthScores()', zeroStart)
    assert.ok(zeroStart >= 0 && firstHealthRead > zeroStart)
    assert.ok(consumerSource.indexOf('return {', zeroStart) < firstHealthRead)
    assert.match(zeroUserSource, /healthHistory: \{\}/)
    assert.match(zeroUserSource, /managers: \[\]/)
    assert.equal(/ManagerHealthRepository|ManagerHealthScores|ManagerHealthHistory|getPreviousHealthScores|saveHealthScores|getHealthHistory/.test(zeroUserSource), false)
})

check('team projection retains previous compute save and history ordering', () => {
    const previous = consumerSource.indexOf('const previousData = await getPreviousHealthScores()')
    const compute = consumerSource.indexOf('const health = calculateManagerHealthScore', previous)
    const save = consumerSource.indexOf('await saveHealthScores(', compute)
    const intervention = consumerSource.indexOf('// Compute intervention priority + reasons', save)
    const history = consumerSource.indexOf('const historyMap = await getHealthHistory(', intervention)
    const risk = consumerSource.indexOf('m.riskPersistence = computeRiskPersistence', history)
    const stability = consumerSource.indexOf('const teamStability = computeTeamStability', risk)
    assert.ok(previous < compute && compute < save && save < intervention && intervention < history)
    assert.ok(history < risk && risk < stability)
})

await checkAsync('previous snapshot wrapper ensures first preserves row order and last duplicate wins', async () => {
    const calls = []
    const wrappers = loadWrappers({
        async ensureManagerHealthRepositoryV1(command) { calls.push(['ensure', command]) },
        async listManagerHealthSnapshotsV1(query) {
            calls.push(['list', query])
            return { items: [
                { managerId: 'manager-1', score: 80, declineStreak: 1 },
                { managerId: 'manager-2', score: 60, declineStreak: 2 },
                { managerId: 'manager-1', score: 40, declineStreak: 5 },
            ] }
        },
    })
    const result = await wrappers.getPreviousHealthScores()
    assert.deepEqual(plain(calls), [
        ['ensure', { contract: 'ensure.v1' }],
        ['list', { contract: 'snapshots.v1' }],
    ])
    assert.deepEqual(mapEntries(result), [
        ['manager-1', { score: 40, declineStreak: 5 }],
        ['manager-2', { score: 60, declineStreak: 2 }],
    ])
})

await checkAsync('previous snapshot ensure and query failures propagate in order', async () => {
    let listCalls = 0
    const ensureError = new Error('ensure down')
    let wrappers = loadWrappers({
        async ensureManagerHealthRepositoryV1() { throw ensureError },
        async listManagerHealthSnapshotsV1() { listCalls += 1; return { items: [] } },
    })
    await assert.rejects(wrappers.getPreviousHealthScores(), error => error === ensureError)
    assert.equal(listCalls, 0)
    const listError = new Error('list down')
    wrappers = loadWrappers({
        async listManagerHealthSnapshotsV1() { throw listError },
    })
    await assert.rejects(wrappers.getPreviousHealthScores(), error => error === listError)
})

await checkAsync('save wrapper skips empty arrays and preserves ensure save order and item identity', async () => {
    const calls = []
    const wrappers = loadWrappers({
        async ensureManagerHealthRepositoryV1(command) { calls.push(['ensure', command]) },
        async saveManagerHealthScoresV1(command) { calls.push(['save', command]) },
    })
    await wrappers.saveHealthScores([])
    assert.deepEqual(calls, [])
    const items = [
        { managerId: 'manager-1', score: 72, declineStreak: 2, healthLevel: 'warning' },
        { managerId: 'manager-1', score: 35, declineStreak: 4, healthLevel: 'critical' },
    ]
    await wrappers.saveHealthScores(items)
    assert.deepEqual(calls.map(call => call[0]), ['ensure', 'save'])
    assert.deepEqual(plain(calls[0][1]), { contract: 'ensure.v1' })
    assert.equal(calls[1][1].items, items)
    assert.deepEqual(plain(calls[1][1]), { contract: 'save.v1', items })
})

await checkAsync('save wrapper propagates ensure and save failures without reordering', async () => {
    let saveCalls = 0
    const ensureError = new Error('ensure down')
    let wrappers = loadWrappers({
        async ensureManagerHealthRepositoryV1() { throw ensureError },
        async saveManagerHealthScoresV1() { saveCalls += 1 },
    })
    await assert.rejects(wrappers.saveHealthScores([
        { managerId: 'manager-1', score: 70, declineStreak: 1, healthLevel: 'warning' },
    ]), error => error === ensureError)
    assert.equal(saveCalls, 0)
    const saveError = new Error('save down')
    wrappers = loadWrappers({ async saveManagerHealthScoresV1() { throw saveError } })
    await assert.rejects(wrappers.saveHealthScores([
        { managerId: 'manager-1', score: 70, declineStreak: 1, healthLevel: 'warning' },
    ]), error => error === saveError)
})

await checkAsync('history wrapper skips empty IDs and maps ordered points with Date identity', async () => {
    const calls = []
    const first = new Date('2026-08-08T10:00:00.000Z')
    const second = new Date('2026-08-08T11:00:00.000Z')
    const wrappers = loadWrappers({
        async ensureManagerHealthRepositoryV1(command) { calls.push(['ensure', command]) },
        async listManagerHealthHistoryV1(query) {
            calls.push(['history', query])
            return { items: [
                { managerId: 'manager-1', score: 80, healthLevel: 'healthy', recordedAt: first },
                { managerId: 'manager-1', score: 60, healthLevel: 'warning', recordedAt: second },
                { managerId: 'manager-2', score: 30, healthLevel: 'critical', recordedAt: second },
            ] }
        },
    })
    assert.deepEqual(mapEntries(await wrappers.getHealthHistory([])), [])
    assert.deepEqual(calls, [])
    const managerIds = ['manager-1', 'manager-2', 'manager-1']
    const result = await wrappers.getHealthHistory(managerIds)
    assert.deepEqual(calls.map(call => call[0]), ['ensure', 'history'])
    assert.equal(calls[1][1].managerIds, managerIds)
    assert.equal(calls[1][1].periodDays, 7)
    assert.deepEqual(mapEntries(result), [
        ['manager-1', [
            { score: 80, healthLevel: 'healthy', recordedAt: first.toISOString() },
            { score: 60, healthLevel: 'warning', recordedAt: second.toISOString() },
        ]],
        ['manager-2', [
            { score: 30, healthLevel: 'critical', recordedAt: second.toISOString() },
        ]],
    ])
    assert.equal(result.get('manager-1')[0].recordedAt, first)
})

await checkAsync('history cap is Math.min-only and preserves negative and fractional periods', async () => {
    const observed = []
    const wrappers = loadWrappers({
        async listManagerHealthHistoryV1(query) { observed.push(query.periodDays); return { items: [] } },
    })
    await wrappers.getHealthHistory(['manager-1'], 45)
    await wrappers.getHealthHistory(['manager-1'], -3.75)
    await wrappers.getHealthHistory(['manager-1'], 1.25)
    await wrappers.getHealthHistory(['manager-1'], undefined)
    assert.deepEqual(observed, [30, -3.75, 1.25, 7])
})

await checkAsync('history ensure and query errors log exact fallback and return empty maps', async () => {
    const logs = []
    const ensureError = new Error('ensure down')
    let queryCalls = 0
    let wrappers = loadWrappers({
        console: { error(...args) { logs.push(args) } },
        async ensureManagerHealthRepositoryV1() { throw ensureError },
        async listManagerHealthHistoryV1() { queryCalls += 1; return { items: [] } },
    })
    assert.deepEqual(mapEntries(await wrappers.getHealthHistory(['manager-1'])), [])
    assert.equal(queryCalls, 0)
    assert.deepEqual(logs, [[
        '[health-history] Failed to read history, returning empty:',
        ensureError,
    ]])

    logs.length = 0
    const queryError = new Error('query down')
    wrappers = loadWrappers({
        console: { error(...args) { logs.push(args) } },
        async listManagerHealthHistoryV1() { throw queryError },
    })
    assert.deepEqual(mapEntries(await wrappers.getHealthHistory(['manager-1'], -0.5)), [])
    assert.deepEqual(logs, [[
        '[health-history] Failed to read history, returning empty:',
        queryError,
    ]])
})

await checkAsync('history mapping failure returns the inherited partial map and exact log', async () => {
    const logs = []
    const mappingError = new Error('iterator down')
    const first = new Date('2026-08-08T10:00:00.000Z')
    const items = {
        [Symbol.iterator]() {
            let step = 0
            return {
                next() {
                    if (step++ === 0) {
                        return {
                            done: false,
                            value: { managerId: 'manager-1', score: 80, healthLevel: 'healthy', recordedAt: first },
                        }
                    }
                    throw mappingError
                },
            }
        },
    }
    const wrappers = loadWrappers({
        console: { error(...args) { logs.push(args) } },
        async listManagerHealthHistoryV1() { return { items } },
    })
    const result = await wrappers.getHealthHistory(['manager-1'])
    assert.deepEqual(mapEntries(result), [[
        'manager-1',
        [{ score: 80, healthLevel: 'healthy', recordedAt: first.toISOString() }],
    ]])
    assert.deepEqual(logs, [[
        '[health-history] Failed to read history, returning empty:',
        mappingError,
    ]])
})

process.stdout.write(`${JSON.stringify({ status: 'PASS', passed: checks.length, checks }, null, 2)}\n`)
