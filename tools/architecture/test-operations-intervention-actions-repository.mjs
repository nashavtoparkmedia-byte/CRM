#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import vm from 'node:vm'

const root = process.cwd()
const out = mkdtempSync(path.join(tmpdir(), 'yoko-intervention-repository-'))
const sources = [
    'gravity-mvp/src/contracts/operations-observability/v1/intervention-actions-repository.ts',
    'gravity-mvp/src/contracts/operations-observability/v1/index.ts',
    'gravity-mvp/src/modules/operations-observability/public/v1/intervention-actions-repository-handler.ts',
].map(value => path.join(root, value))
const compiled = spawnSync(process.execPath, [
    path.join(root, 'gravity-mvp/node_modules/typescript/bin/tsc'),
    '--target', 'ES2022', '--module', 'commonjs', '--moduleResolution', 'node', '--strict', '--skipLibCheck',
    '--rootDir', path.join(root, 'gravity-mvp/src'), '--outDir', out, ...sources,
], { encoding: 'utf8' })
if (compiled.status !== 0) {
    process.stderr.write(compiled.stdout + compiled.stderr)
    process.exit(1)
}

const require = createRequire(import.meta.url)
const contracts = require(path.join(out, 'contracts/operations-observability/v1/index.js'))
const handlers = require(path.join(
    out,
    'modules/operations-observability/public/v1/intervention-actions-repository-handler.js',
))
const typescript = require(path.join(root, 'gravity-mvp/node_modules/typescript/lib/typescript.js'))
const adapterSource = readFileSync(path.join(
    root,
    'gravity-mvp/src/modules/operations-observability/public/v1/legacy-prisma-intervention-actions-repository.ts',
), 'utf8')
const adapterOutput = typescript.transpileModule(adapterSource, {
    compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2022 },
}).outputText
const checks = []
const check = (name, fn) => { fn(); checks.push(name) }
const checkAsync = async (name, fn) => { await fn(); checks.push(name) }
const plain = value => JSON.parse(JSON.stringify(value))
const FROZEN_DDL_SQL = [
    `
CREATE TABLE IF NOT EXISTS intervention_actions (
  id TEXT PRIMARY KEY,
  manager_id TEXT NOT NULL,
  action TEXT NOT NULL,
  comment TEXT,
  score_at_action INTEGER,
  outcome TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`,
    `
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'intervention_actions' AND column_name = 'score_at_action') THEN
    ALTER TABLE intervention_actions ADD COLUMN score_at_action INTEGER;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'intervention_actions' AND column_name = 'outcome') THEN
    ALTER TABLE intervention_actions ADD COLUMN outcome TEXT;
  END IF;
END $$`,
    `
CREATE INDEX IF NOT EXISTS idx_intervention_actions_manager
ON intervention_actions (manager_id, created_at DESC)`,
]
const FROZEN_READ_SQL = [
    `
            SELECT id, manager_id, score_at_action
            FROM intervention_actions
            WHERE outcome IS NULL AND score_at_action IS NOT NULL AND created_at <= $1
        `,
    `
            SELECT DISTINCT ON (manager_id) manager_id, action, comment, score_at_action, outcome, created_at
            FROM intervention_actions
            ORDER BY manager_id, created_at DESC
        `,
    `
            SELECT action, outcome, COUNT(*)::text as cnt
            FROM intervention_actions
            WHERE outcome IS NOT NULL
            GROUP BY action, outcome
            ORDER BY action, outcome
        `,
    `
            SELECT created_at
            FROM intervention_actions
            WHERE outcome IS NOT NULL
            ORDER BY created_at DESC
        `,
]

function loadAdapter(prisma) {
    const module = { exports: {} }
    vm.runInNewContext(adapterOutput, {
        module,
        exports: module.exports,
        require(specifier) {
            if (specifier === '@/lib/prisma') return { prisma }
            throw new Error(`unexpected adapter import: ${specifier}`)
        },
    })
    return module.exports.legacyPrismaInterventionActionsRepositoryPortV1
}

const requests = {
    ensure: { contract: contracts.ENSURE_INTERVENTION_ACTIONS_REPOSITORY_COMMAND_V1 },
    create: {
        contract: contracts.CREATE_INTERVENTION_ACTION_COMMAND_V1,
        id: 'ia-1', managerId: 'manager-1', action: 'coaching', comment: null, scoreAtAction: 71,
    },
    pending: {
        contract: contracts.LIST_PENDING_INTERVENTION_ACTIONS_QUERY_V1,
        eligibleAtOrBefore: new Date('2026-08-01T00:00:00.000Z'),
    },
    outcome: { contract: contracts.SET_INTERVENTION_OUTCOME_COMMAND_V1, id: 'ia-1', outcome: 'improved' },
    latest: { contract: contracts.LIST_LATEST_INTERVENTION_ACTIONS_QUERY_V1 },
    counts: { contract: contracts.LIST_INTERVENTION_OUTCOME_COUNTS_QUERY_V1 },
    times: { contract: contracts.LIST_COMPLETED_INTERVENTION_TIMES_QUERY_V1 },
}

try {
    check('all seven request and result identifiers are literal', () => {
        const expected = {
            ENSURE_INTERVENTION_ACTIONS_REPOSITORY_COMMAND_V1: 'operations_observability.EnsureInterventionActionsRepositoryCommand.v1',
            ENSURE_INTERVENTION_ACTIONS_REPOSITORY_RESULT_V1: 'operations_observability.EnsureInterventionActionsRepositoryResult.v1',
            CREATE_INTERVENTION_ACTION_COMMAND_V1: 'operations_observability.CreateInterventionActionCommand.v1',
            CREATE_INTERVENTION_ACTION_RESULT_V1: 'operations_observability.CreateInterventionActionResult.v1',
            LIST_PENDING_INTERVENTION_ACTIONS_QUERY_V1: 'operations_observability.ListPendingInterventionActionsQuery.v1',
            LIST_PENDING_INTERVENTION_ACTIONS_RESULT_V1: 'operations_observability.ListPendingInterventionActionsResult.v1',
            SET_INTERVENTION_OUTCOME_COMMAND_V1: 'operations_observability.SetInterventionOutcomeCommand.v1',
            SET_INTERVENTION_OUTCOME_RESULT_V1: 'operations_observability.SetInterventionOutcomeResult.v1',
            LIST_LATEST_INTERVENTION_ACTIONS_QUERY_V1: 'operations_observability.ListLatestInterventionActionsQuery.v1',
            LIST_LATEST_INTERVENTION_ACTIONS_RESULT_V1: 'operations_observability.ListLatestInterventionActionsResult.v1',
            LIST_INTERVENTION_OUTCOME_COUNTS_QUERY_V1: 'operations_observability.ListInterventionOutcomeCountsQuery.v1',
            LIST_INTERVENTION_OUTCOME_COUNTS_RESULT_V1: 'operations_observability.ListInterventionOutcomeCountsResult.v1',
            LIST_COMPLETED_INTERVENTION_TIMES_QUERY_V1: 'operations_observability.ListCompletedInterventionTimesQuery.v1',
            LIST_COMPLETED_INTERVENTION_TIMES_RESULT_V1: 'operations_observability.ListCompletedInterventionTimesResult.v1',
        }
        for (const [key, value] of Object.entries(expected)) assert.equal(contracts[key], value)
    })
    check('strict parsers accept exact requests', () => {
        assert.deepEqual(contracts.parseEnsureInterventionActionsRepositoryCommandV1(requests.ensure), requests.ensure)
        assert.deepEqual(contracts.parseCreateInterventionActionCommandV1(requests.create), requests.create)
        assert.deepEqual(contracts.parseListPendingInterventionActionsQueryV1(requests.pending), requests.pending)
        assert.deepEqual(contracts.parseSetInterventionOutcomeCommandV1(requests.outcome), requests.outcome)
        assert.deepEqual(contracts.parseListLatestInterventionActionsQueryV1(requests.latest), requests.latest)
        assert.deepEqual(contracts.parseListInterventionOutcomeCountsQueryV1(requests.counts), requests.counts)
        assert.deepEqual(contracts.parseListCompletedInterventionTimesQueryV1(requests.times), requests.times)
    })
    check('strict parsers reject v2 extras invalid dates and invalid outcomes', () => {
        const parserCases = [
            [contracts.parseEnsureInterventionActionsRepositoryCommandV1, requests.ensure],
            [contracts.parseCreateInterventionActionCommandV1, requests.create],
            [contracts.parseListPendingInterventionActionsQueryV1, requests.pending],
            [contracts.parseSetInterventionOutcomeCommandV1, requests.outcome],
            [contracts.parseListLatestInterventionActionsQueryV1, requests.latest],
            [contracts.parseListInterventionOutcomeCountsQueryV1, requests.counts],
            [contracts.parseListCompletedInterventionTimesQueryV1, requests.times],
        ]
        for (const [parse, request] of parserCases) {
            assert.throws(() => parse({ ...request, tableName: 'intervention_actions' }))
            assert.throws(() => parse({ ...request, contract: request.contract.replace('.v1', '.v2') }), error =>
                error.code === 'UNSUPPORTED_CONTRACT_VERSION')
        }
        assert.throws(() => contracts.parseCreateInterventionActionCommandV1({ ...requests.create, scoreAtAction: NaN }))
        assert.throws(() => contracts.parseCreateInterventionActionCommandV1({ ...requests.create, action: 'unknown' }))
        assert.throws(() => contracts.parseListPendingInterventionActionsQueryV1({
            ...requests.pending, eligibleAtOrBefore: new Date('invalid'),
        }))
        assert.throws(() => contracts.parseSetInterventionOutcomeCommandV1({ ...requests.outcome, outcome: 'unknown' }))
    })

    await checkAsync('handlers preserve exact port mappings results and Date identity', async () => {
        const calls = []
        const latestDate = new Date('2026-08-02T00:00:00.000Z')
        const port = {
            async ensure() { calls.push(['ensure']) },
            async create(input) { calls.push(['create', input]) },
            async listPending(date) { calls.push(['pending', date]); return [{ id: 'ia-1', managerId: 'manager-1', scoreAtAction: 71 }] },
            async setOutcome(input) { calls.push(['outcome', input]) },
            async listLatest() { calls.push(['latest']); return [{ managerId: 'manager-1', action: 'coaching', comment: null, scoreAtAction: 71, outcome: 'improved', createdAt: latestDate }] },
            async listOutcomeCounts() { calls.push(['counts']); return [{ action: 'coaching', outcome: 'improved', total: '2' }] },
            async listCompletedTimes() { calls.push(['times']); return [{ createdAt: latestDate }] },
        }
        const results = []
        results.push(await handlers.createEnsureInterventionActionsRepositoryHandlerV1(port)(requests.ensure))
        results.push(await handlers.createCreateInterventionActionHandlerV1(port)(requests.create))
        results.push(await handlers.createListPendingInterventionActionsHandlerV1(port)(requests.pending))
        results.push(await handlers.createSetInterventionOutcomeHandlerV1(port)(requests.outcome))
        results.push(await handlers.createListLatestInterventionActionsHandlerV1(port)(requests.latest))
        results.push(await handlers.createListInterventionOutcomeCountsHandlerV1(port)(requests.counts))
        results.push(await handlers.createListCompletedInterventionTimesHandlerV1(port)(requests.times))
        assert.deepEqual(plain(calls.slice(0, 4)), [
            ['ensure'],
            ['create', { id: 'ia-1', managerId: 'manager-1', action: 'coaching', comment: null, scoreAtAction: 71 }],
            ['pending', requests.pending.eligibleAtOrBefore.toISOString()],
            ['outcome', { id: 'ia-1', outcome: 'improved' }],
        ])
        assert.equal(calls[2][1], requests.pending.eligibleAtOrBefore)
        assert.equal(results[4].items[0].createdAt, latestDate)
        assert.equal(results[6].items[0].createdAt, latestDate)
        assert.deepEqual(plain(results.map(result => result.contract)), [
            contracts.ENSURE_INTERVENTION_ACTIONS_REPOSITORY_RESULT_V1,
            contracts.CREATE_INTERVENTION_ACTION_RESULT_V1,
            contracts.LIST_PENDING_INTERVENTION_ACTIONS_RESULT_V1,
            contracts.SET_INTERVENTION_OUTCOME_RESULT_V1,
            contracts.LIST_LATEST_INTERVENTION_ACTIONS_RESULT_V1,
            contracts.LIST_INTERVENTION_OUTCOME_COUNTS_RESULT_V1,
            contracts.LIST_COMPLETED_INTERVENTION_TIMES_RESULT_V1,
        ])
    })
    await checkAsync('invalid requests never reach ports and owner failures remain visible', async () => {
        let calls = 0
        const port = {
            async ensure() { calls += 1; throw new Error('owner down') },
            async create() { calls += 1 }, async listPending() { calls += 1; return [] },
            async setOutcome() { calls += 1 }, async listLatest() { calls += 1; return [] },
            async listOutcomeCounts() { calls += 1; return [] }, async listCompletedTimes() { calls += 1; return [] },
        }
        await assert.rejects(handlers.createCreateInterventionActionHandlerV1(port)({ ...requests.create, sql: 'x' }))
        await assert.rejects(handlers.createCreateInterventionActionHandlerV1(port)({ ...requests.create, action: 'unknown' }))
        assert.equal(calls, 0)
        await assert.rejects(handlers.createEnsureInterventionActionsRepositoryHandlerV1(port)(requests.ensure), /owner down/)
        assert.equal(calls, 1)
    })

    await checkAsync('adapter preserves exact DDL state machine typed writes and fixed read mappings', async () => {
        const ddl = []
        const creates = []
        const updates = []
        const reads = []
        const latestDate = new Date('2026-08-02T00:00:00.000Z')
        const prisma = {
            async $executeRawUnsafe(sql) { ddl.push(sql); return 0 },
            async $queryRawUnsafe(sql, ...args) {
                reads.push([sql, args])
                if (sql.includes('SELECT id, manager_id')) return [{ id: 'ia-1', manager_id: 'manager-1', score_at_action: 71 }]
                if (sql.includes('SELECT DISTINCT ON')) return [{ manager_id: 'manager-1', action: 'coaching', comment: null, score_at_action: 71, outcome: 'improved', created_at: latestDate }]
                if (sql.includes('COUNT(*)::text')) return [{ action: 'coaching', outcome: 'improved', cnt: '2' }]
                if (sql.includes('SELECT created_at')) return [{ created_at: latestDate }]
                throw new Error(`unexpected read: ${sql}`)
            },
            intervention_actions: {
                async create(input) { creates.push(input); return input.data },
                async updateMany(input) { updates.push(input); return { count: 0 } },
            },
        }
        const adapter = loadAdapter(prisma)
        await adapter.ensure()
        await adapter.ensure()
        await adapter.create({ id: 'ia-1', managerId: 'manager-1', action: 'coaching', comment: null, scoreAtAction: 71 })
        const pending = await adapter.listPending(requests.pending.eligibleAtOrBefore)
        await adapter.setOutcome({ id: 'ia-1', outcome: 'improved' })
        const latest = await adapter.listLatest()
        const counts = await adapter.listOutcomeCounts()
        const times = await adapter.listCompletedTimes()
        assert.deepEqual(ddl, FROZEN_DDL_SQL)
        assert.deepEqual(plain(creates), [{ data: { id: 'ia-1', manager_id: 'manager-1', action: 'coaching', comment: null, score_at_action: 71 } }])
        assert.deepEqual(plain(updates), [{ where: { id: 'ia-1' }, data: { outcome: 'improved' } }])
        assert.equal(Object.prototype.hasOwnProperty.call(creates[0].data, 'created_at'), false)
        assert.equal(Object.prototype.hasOwnProperty.call(creates[0].data, 'outcome'), false)
        assert.deepEqual(plain(pending), [{ id: 'ia-1', managerId: 'manager-1', scoreAtAction: 71 }])
        assert.deepEqual(plain(latest), [{ managerId: 'manager-1', action: 'coaching', comment: null, scoreAtAction: 71, outcome: 'improved', createdAt: latestDate.toISOString() }])
        assert.deepEqual(plain(counts), [{ action: 'coaching', outcome: 'improved', total: '2' }])
        assert.deepEqual(plain(times), [{ createdAt: latestDate.toISOString() }])
        assert.deepEqual(reads.map(([sql]) => sql), FROZEN_READ_SQL)
        assert.equal(reads[0][1].length, 1)
        assert.equal(reads[0][1][0], requests.pending.eligibleAtOrBefore)
        assert.deepEqual(reads.slice(1).map(([, args]) => args), [[], [], []])
    })
    await checkAsync('failed DDL leaves flag false and retry reruns all three statements', async () => {
        const calls = []
        let failColumns = true
        const adapter = loadAdapter({
            async $executeRawUnsafe(sql) {
                calls.push(sql)
                if (failColumns && sql.includes('DO $$ BEGIN')) { failColumns = false; throw new Error('columns down') }
                return 0
            },
        })
        await assert.rejects(adapter.ensure(), /columns down/)
        await adapter.ensure()
        assert.equal(calls.length, 5)
        assert.equal(calls[0], calls[2])
        assert.equal(calls[1], calls[3])
        assert.match(calls[4], /CREATE INDEX IF NOT EXISTS/)
    })
    await checkAsync('concurrent first ensures retain the inherited race behavior', async () => {
        const calls = []
        const adapter = loadAdapter({ async $executeRawUnsafe(sql) { calls.push(sql); await Promise.resolve(); return 0 } })
        await Promise.all([adapter.ensure(), adapter.ensure()])
        assert.equal(calls.length, 6)
        assert.equal(calls.filter(sql => sql.includes('CREATE TABLE IF NOT EXISTS')).length, 2)
        assert.equal(calls.filter(sql => sql.includes('DO $$ BEGIN')).length, 2)
        assert.equal(calls.filter(sql => sql.includes('CREATE INDEX IF NOT EXISTS')).length, 2)
    })
} finally {
    rmSync(out, { recursive: true, force: true })
}

process.stdout.write(`${JSON.stringify({ status: 'PASS', passed: checks.length, checks }, null, 2)}\n`)
