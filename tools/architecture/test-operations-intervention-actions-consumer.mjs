#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'

const root = process.cwd()
const require = createRequire(import.meta.url)
const typescript = require(path.join(root, 'gravity-mvp/node_modules/typescript/lib/typescript.js'))
const sourcePath = path.join(root, 'gravity-mvp/src/app/team-overview/actions.ts')
const source = `${readFileSync(sourcePath, 'utf8')}
export const __interventionConsumerTest = {
    getOutcomeTimingStats,
    getLastInterventionActions,
    evaluateInterventionOutcomes,
    getInterventionEffectiveness,
}
`
const output = typescript.transpileModule(source, {
    compilerOptions: {
        module: typescript.ModuleKind.CommonJS,
        target: typescript.ScriptTarget.ES2022,
        esModuleInterop: true,
    },
}).outputText

const CONTRACTS = {
    CREATE_INTERVENTION_ACTION_COMMAND_V1: 'operations_observability.CreateInterventionActionCommand.v1',
    ENSURE_INTERVENTION_ACTIONS_REPOSITORY_COMMAND_V1: 'operations_observability.EnsureInterventionActionsRepositoryCommand.v1',
    LIST_COMPLETED_INTERVENTION_TIMES_QUERY_V1: 'operations_observability.ListCompletedInterventionTimesQuery.v1',
    LIST_INTERVENTION_OUTCOME_COUNTS_QUERY_V1: 'operations_observability.ListInterventionOutcomeCountsQuery.v1',
    LIST_LATEST_INTERVENTION_ACTIONS_QUERY_V1: 'operations_observability.ListLatestInterventionActionsQuery.v1',
    LIST_PENDING_INTERVENTION_ACTIONS_QUERY_V1: 'operations_observability.ListPendingInterventionActionsQuery.v1',
    SET_INTERVENTION_OUTCOME_COMMAND_V1: 'operations_observability.SetInterventionOutcomeCommand.v1',
}
const ACTION_LABELS = {
    coaching: 'Проведён разбор',
    reassigned_tasks: 'Перераспределены задачи',
    workload_adjusted: 'Скорректирована нагрузка',
    escalation_reviewed: 'Эскалация рассмотрена',
    no_action_needed: 'Действие не требуется',
}
const DAY_MS = 24 * 60 * 60 * 1000
const checks = []
const checkAsync = async (name, fn) => { await fn(); checks.push(name) }
const plain = value => JSON.parse(JSON.stringify(value))

function evaluateOutcome(scoreAtAction, currentScore) {
    const delta = currentScore - scoreAtAction
    if (delta >= 3) return 'improved'
    if (delta <= -3) return 'worsened'
    return 'unchanged'
}

function loadConsumer({
    prisma = { crmUser: { async findMany() { return [] } } },
    operations = {},
    nowMs = Date.parse('2026-08-10T03:30:00.000Z'),
    randomValue = 0.123456789,
    events = [],
    errors = [],
} = {}) {
    class ControlledDate extends Date {
        static now() {
            events.push('Date.now')
            return nowMs
        }
    }
    const controlledMath = Object.create(Math)
    controlledMath.random = () => {
        events.push('Math.random')
        return randomValue
    }
    const defaults = {
        async ensureInterventionActionsRepositoryV1(input) { events.push(['ensure', input]) },
        async createInterventionActionV1(input) { events.push(['create', input]) },
        async listCompletedInterventionTimesV1(input) { events.push(['times', input]); return { items: [] } },
        async listInterventionOutcomeCountsV1(input) { events.push(['counts', input]); return { items: [] } },
        async listLatestInterventionActionsV1(input) { events.push(['latest', input]); return { items: [] } },
        async listPendingInterventionActionsV1(input) { events.push(['pending', input]); return { items: [] } },
        async setInterventionOutcomeV1(input) { events.push(['outcome', input]) },
    }
    const ops = { ...defaults, ...operations }
    const module = { exports: {} }
    vm.runInNewContext(output, {
        module,
        exports: module.exports,
        Date: ControlledDate,
        Math: controlledMath,
        console: { error: (...args) => errors.push(args), log() {}, warn() {}, info() {} },
        require(specifier) {
            if (specifier === '@/lib/prisma') return { prisma }
            if (specifier === '@/contracts/operations-observability/v1') return CONTRACTS
            if (specifier === '@/modules/operations-observability/public/v1') return ops
            if (specifier === '@/modules/work-management/public/v1/team-operational-policy') {
                return {
                    INTERVENTION_ACTION_LABELS: ACTION_LABELS,
                    evaluateOutcome,
                    INTERVENTION_OUTCOME_CONFIG: { outcomeWindowHours: 24, improvementThreshold: 3 },
                    OUTCOME_TIMING_CONFIG: { minCompletedForStats: 3, recentPeriodDays: 7 },
                }
            }
            return {}
        },
    })
    return { exported: module.exports, events, errors, nowMs, randomValue }
}

await checkAsync('zero-user overview returns before every intervention repository operation', async () => {
    const events = []
    const operations = Object.fromEntries([
        'ensureInterventionActionsRepositoryV1',
        'createInterventionActionV1',
        'listCompletedInterventionTimesV1',
        'listInterventionOutcomeCountsV1',
        'listLatestInterventionActionsV1',
        'listPendingInterventionActionsV1',
        'setInterventionOutcomeV1',
    ].map(name => [name, async () => { throw new Error(`unexpected ${name}`) }]))
    const { exported } = loadConsumer({ operations, events })
    const result = await exported.getTeamOverview()
    assert.equal(result.managers.length, 0)
    assert.equal(result.totals.avgHealthScore, 100)
    assert.deepEqual(events, [])
})

await checkAsync('create keeps ensure clock random normalization and payload order', async () => {
    const events = []
    const nowMs = Date.parse('2026-08-10T04:00:00.000Z')
    const randomValue = 0.123456789
    const { exported } = loadConsumer({ events, nowMs, randomValue })
    await exported.logInterventionAction({
        managerId: 'manager-1', action: 'coaching', comment: '  review  ', scoreAtAction: 0,
    })
    assert.equal(events[0][0], 'ensure')
    assert.equal(events[1], 'Date.now')
    assert.equal(events[2], 'Math.random')
    assert.equal(events[3][0], 'create')
    assert.deepEqual(plain(events[3][1]), {
        contract: CONTRACTS.CREATE_INTERVENTION_ACTION_COMMAND_V1,
        id: `ia_${nowMs}_${randomValue.toString(36).slice(2, 8)}`,
        managerId: 'manager-1',
        action: 'coaching',
        comment: 'review',
        scoreAtAction: 0,
    })

    events.length = 0
    await exported.logInterventionAction({ managerId: 'manager-2', action: 'no_action_needed', comment: '   ' })
    assert.equal(events[3][1].comment, null)
    assert.equal(events[3][1].scoreAtAction, null)
})

await checkAsync('failed ensure prevents caller clock randomness and create', async () => {
    const events = []
    const { exported } = loadConsumer({
        events,
        operations: {
            async ensureInterventionActionsRepositoryV1() { events.push('ensure-failed'); throw new Error('ddl down') },
        },
    })
    await assert.rejects(
        exported.logInterventionAction({ managerId: 'manager-1', action: 'coaching' }),
        /ddl down/,
    )
    assert.deepEqual(events, ['ensure-failed'])
})

await checkAsync('latest mapping preserves legacy strings nullable fields and ISO timestamps', async () => {
    const createdAt = new Date('2026-08-09T23:00:00.000Z')
    const { exported } = loadConsumer({
        operations: {
            async listLatestInterventionActionsV1() {
                return { items: [{
                    managerId: 'manager-1', action: 'legacy-action', comment: null,
                    scoreAtAction: null, outcome: 'legacy-outcome', createdAt,
                }] }
            },
        },
    })
    const result = await exported.__interventionConsumerTest.getLastInterventionActions()
    assert.deepEqual(plain([...result]), [['manager-1', {
        action: 'legacy-action', comment: null, timestamp: createdAt.toISOString(),
        scoreAtAction: null, outcome: 'legacy-outcome',
    }]])
})

await checkAsync('outcome evaluation keeps one cutoff skips absent managers and writes sequentially', async () => {
    const events = []
    const nowMs = Date.parse('2026-08-10T05:00:00.000Z')
    const writes = []
    const { exported } = loadConsumer({
        events,
        nowMs,
        operations: {
            async listPendingInterventionActionsV1(input) {
                events.push(['pending', input])
                return { items: [
                    { id: 'a', managerId: 'manager-a', scoreAtAction: 50 },
                    { id: 'missing', managerId: 'manager-missing', scoreAtAction: 50 },
                    { id: 'b', managerId: 'manager-b', scoreAtAction: 50 },
                ] }
            },
            async setInterventionOutcomeV1(input) { writes.push(plain(input)); events.push(`write:${input.id}`) },
        },
    })
    await exported.__interventionConsumerTest.evaluateInterventionOutcomes([
        { managerId: 'manager-a', healthScore: 53 },
        { managerId: 'manager-b', healthScore: 47 },
    ])
    const pending = events.find(value => Array.isArray(value) && value[0] === 'pending')[1]
    assert.equal(pending.eligibleAtOrBefore.getTime(), nowMs - DAY_MS)
    assert.deepEqual(writes, [
        { contract: CONTRACTS.SET_INTERVENTION_OUTCOME_COMMAND_V1, id: 'a', outcome: 'improved' },
        { contract: CONTRACTS.SET_INTERVENTION_OUTCOME_COMMAND_V1, id: 'b', outcome: 'worsened' },
    ])
    assert.deepEqual(events.filter(value => typeof value === 'string' && value.startsWith('write:')), ['write:a', 'write:b'])
})

await checkAsync('outcome failure exposes partial sequential progress without later writes', async () => {
    const completed = []
    const { exported } = loadConsumer({
        operations: {
            async listPendingInterventionActionsV1() {
                return { items: ['a', 'b', 'c'].map(id => ({ id, managerId: id, scoreAtAction: 50 })) }
            },
            async setInterventionOutcomeV1(input) {
                if (input.id === 'b') throw new Error('second write failed')
                completed.push(input.id)
            },
        },
    })
    await assert.rejects(
        exported.__interventionConsumerTest.evaluateInterventionOutcomes([
            { managerId: 'a', healthScore: 53 },
            { managerId: 'b', healthScore: 53 },
            { managerId: 'c', healthScore: 53 },
        ]),
        /second write failed/,
    )
    assert.deepEqual(completed, ['a'])
})

await checkAsync('effectiveness retains known aggregation unknown rows fallback labels and tie order', async () => {
    const { exported } = loadConsumer({
        operations: {
            async listInterventionOutcomeCountsV1() {
                return { items: [
                    { action: 'coaching', outcome: 'improved', total: '2' },
                    { action: 'coaching', outcome: 'unknown', total: '100' },
                    { action: 'reassigned_tasks', outcome: 'improved', total: '1' },
                    { action: 'reassigned_tasks', outcome: 'worsened', total: '1' },
                    { action: 'legacy-action', outcome: 'unknown', total: '4' },
                    { action: 'no_action_needed', outcome: 'improved', total: 'bad' },
                ] }
            },
        },
    })
    const result = await exported.__interventionConsumerTest.getInterventionEffectiveness()
    assert.deepEqual(plain(result), [
        { action: 'coaching', label: ACTION_LABELS.coaching, total: 2, improved: 2, unchanged: 0, worsened: 0, improvementRate: 100 },
        { action: 'reassigned_tasks', label: ACTION_LABELS.reassigned_tasks, total: 2, improved: 1, unchanged: 0, worsened: 1, improvementRate: 50 },
        { action: 'legacy-action', label: 'legacy-action', total: 0, improved: 0, unchanged: 0, worsened: 0, improvementRate: 0 },
        { action: 'no_action_needed', label: ACTION_LABELS.no_action_needed, total: 0, improved: 0, unchanged: 0, worsened: 0, improvementRate: 0 },
    ])
})

await checkAsync('timing avoids clock for insufficient data and preserves inclusive math rounding and clamp', async () => {
    const nowMs = Date.parse('2026-08-10T06:00:00.000Z')
    const events = []
    let rows = [
        { createdAt: new Date(nowMs - DAY_MS) },
        { createdAt: new Date(nowMs - 2 * DAY_MS) },
    ]
    const { exported } = loadConsumer({
        events,
        nowMs,
        operations: { async listCompletedInterventionTimesV1() { return { items: rows } } },
    })
    const insufficient = await exported.__interventionConsumerTest.getOutcomeTimingStats()
    assert.deepEqual(plain(insufficient), {
        status: 'insufficient_data', completedCount: 0, recentCount: 0, avgPerDay: 0, newestDaysAgo: 0,
    })
    assert.equal(events.includes('Date.now'), false)

    events.length = 0
    rows = [
        { createdAt: new Date(nowMs + DAY_MS) },
        { createdAt: new Date(nowMs - DAY_MS) },
        { createdAt: new Date(nowMs - 7 * DAY_MS) },
        { createdAt: new Date(nowMs - 8 * DAY_MS) },
    ]
    const available = await exported.__interventionConsumerTest.getOutcomeTimingStats()
    assert.deepEqual(plain(available), {
        status: 'available', completedCount: 4, recentCount: 3, avgPerDay: 0.4, newestDaysAgo: 0,
    })
    assert.equal(events.filter(value => value === 'Date.now').length, 1)
})

await checkAsync('timing catches ensure/read failures with the exact existing log prefix', async () => {
    const errors = []
    const { exported } = loadConsumer({
        errors,
        operations: { async listCompletedInterventionTimesV1() { throw new Error('read down') } },
    })
    const result = await exported.__interventionConsumerTest.getOutcomeTimingStats()
    assert.equal(result.status, 'insufficient_data')
    assert.equal(errors.length, 1)
    assert.equal(errors[0][0], '[outcome-timing] Failed to query, returning insufficient:')
    assert.match(errors[0][1].message, /read down/)
})

await checkAsync('latest and effectiveness owner failures remain visible', async () => {
    const { exported } = loadConsumer({
        operations: {
            async listLatestInterventionActionsV1() { throw new Error('latest down') },
            async listInterventionOutcomeCountsV1() { throw new Error('counts down') },
        },
    })
    await assert.rejects(exported.__interventionConsumerTest.getLastInterventionActions(), /latest down/)
    await assert.rejects(exported.__interventionConsumerTest.getInterventionEffectiveness(), /counts down/)
})

process.stdout.write(`${JSON.stringify({ status: 'PASS', passed: checks.length, checks }, null, 2)}\n`)
