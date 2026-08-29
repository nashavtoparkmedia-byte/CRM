#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import vm from 'node:vm'

const root = process.cwd()
const out = mkdtempSync(path.join(tmpdir(), 'yoko-manager-health-repository-'))
const sources = [
    'gravity-mvp/src/contracts/operations-observability/v1/manager-health-repository.ts',
    'gravity-mvp/src/contracts/operations-observability/v1/index.ts',
    'gravity-mvp/src/modules/operations-observability/public/v1/manager-health-repository-handler.ts',
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
    'modules/operations-observability/public/v1/manager-health-repository-handler.js',
))
const typescript = require(path.join(root, 'gravity-mvp/node_modules/typescript/lib/typescript.js'))
const adapterSource = readFileSync(path.join(
    root,
    'gravity-mvp/src/modules/operations-observability/public/v1/legacy-prisma-manager-health-repository.ts',
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
CREATE TABLE IF NOT EXISTS health_snapshots (
  manager_id TEXT PRIMARY KEY,
  score INTEGER NOT NULL,
  decline_streak INTEGER NOT NULL DEFAULT 0,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`,
    `
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'health_snapshots' AND column_name = 'decline_streak'
  ) THEN
    ALTER TABLE health_snapshots ADD COLUMN decline_streak INTEGER NOT NULL DEFAULT 0;
  END IF;
END $$`,
    `
CREATE TABLE IF NOT EXISTS health_score_history (
  id SERIAL PRIMARY KEY,
  manager_id TEXT NOT NULL,
  score INTEGER NOT NULL,
  health_level TEXT NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`,
    `
CREATE INDEX IF NOT EXISTS idx_hsh_manager_date
  ON health_score_history (manager_id, recorded_at DESC)`,
]

const SAVE_SNAPSHOTS_SQL = `
INSERT INTO health_snapshots (manager_id, score, decline_streak, recorded_at)
SELECT v.manager_id, v.score, v.decline_streak, NOW()
FROM UNNEST($1::text[], $2::integer[], $3::integer[])
     WITH ORDINALITY AS v(manager_id, score, decline_streak, ordinal)
ORDER BY v.ordinal
ON CONFLICT (manager_id) DO UPDATE SET
  score = EXCLUDED.score,
  decline_streak = EXCLUDED.decline_streak,
  recorded_at = NOW()`

const APPEND_HISTORY_SQL = `
INSERT INTO health_score_history (manager_id, score, health_level, recorded_at)
SELECT v.manager_id, v.score, v.health_level, NOW()
FROM UNNEST($1::text[], $2::integer[], $3::text[])
     WITH ORDINALITY AS v(manager_id, score, health_level, ordinal)
WHERE NOT EXISTS (
  SELECT 1 FROM health_score_history h
  WHERE h.manager_id = v.manager_id
    AND h.recorded_at > NOW() - INTERVAL '1 hour'
)
ORDER BY v.ordinal`

const LIST_SNAPSHOTS_SQL = 'SELECT manager_id, score, decline_streak FROM health_snapshots'
const LIST_HISTORY_SQL = `
SELECT manager_id, score, health_level, recorded_at
FROM health_score_history
WHERE manager_id = ANY($1::text[])
  AND recorded_at >= NOW() - ($2::double precision * INTERVAL '1 day')
ORDER BY manager_id, recorded_at ASC`

function loadAdapter(prisma, consoleImpl = console) {
    const module = { exports: {} }
    vm.runInNewContext(adapterOutput, {
        module,
        exports: module.exports,
        console: consoleImpl,
        require(specifier) {
            if (specifier === '@/lib/prisma') return { prisma }
            throw new Error(`unexpected adapter import: ${specifier}`)
        },
    })
    return module.exports.legacyPrismaManagerHealthRepositoryPortV1
}

const duplicateItems = [
    { managerId: 'manager-1', score: 81, declineStreak: 0, healthLevel: 'healthy' },
    { managerId: "manager-' OR 1=1 --", score: 64, declineStreak: 2, healthLevel: 'warning' },
    { managerId: 'manager-1', score: 31, declineStreak: 4, healthLevel: 'critical' },
]
const requests = {
    ensure: { contract: contracts.ENSURE_MANAGER_HEALTH_REPOSITORY_COMMAND_V1 },
    snapshots: { contract: contracts.LIST_MANAGER_HEALTH_SNAPSHOTS_QUERY_V1 },
    save: { contract: contracts.SAVE_MANAGER_HEALTH_SCORES_COMMAND_V1, items: duplicateItems },
    history: {
        contract: contracts.LIST_MANAGER_HEALTH_HISTORY_QUERY_V1,
        managerIds: ['manager-1', 'manager-1', "manager-' OR 1=1 --"],
        periodDays: -1.25,
    },
}

try {
    check('all four request and result identifiers are exact literals', () => {
        assert.deepEqual({
            ENSURE_MANAGER_HEALTH_REPOSITORY_COMMAND_V1: contracts.ENSURE_MANAGER_HEALTH_REPOSITORY_COMMAND_V1,
            ENSURE_MANAGER_HEALTH_REPOSITORY_RESULT_V1: contracts.ENSURE_MANAGER_HEALTH_REPOSITORY_RESULT_V1,
            LIST_MANAGER_HEALTH_SNAPSHOTS_QUERY_V1: contracts.LIST_MANAGER_HEALTH_SNAPSHOTS_QUERY_V1,
            LIST_MANAGER_HEALTH_SNAPSHOTS_RESULT_V1: contracts.LIST_MANAGER_HEALTH_SNAPSHOTS_RESULT_V1,
            SAVE_MANAGER_HEALTH_SCORES_COMMAND_V1: contracts.SAVE_MANAGER_HEALTH_SCORES_COMMAND_V1,
            SAVE_MANAGER_HEALTH_SCORES_RESULT_V1: contracts.SAVE_MANAGER_HEALTH_SCORES_RESULT_V1,
            LIST_MANAGER_HEALTH_HISTORY_QUERY_V1: contracts.LIST_MANAGER_HEALTH_HISTORY_QUERY_V1,
            LIST_MANAGER_HEALTH_HISTORY_RESULT_V1: contracts.LIST_MANAGER_HEALTH_HISTORY_RESULT_V1,
        }, {
            ENSURE_MANAGER_HEALTH_REPOSITORY_COMMAND_V1: 'operations_observability.EnsureManagerHealthRepositoryCommand.v1',
            ENSURE_MANAGER_HEALTH_REPOSITORY_RESULT_V1: 'operations_observability.EnsureManagerHealthRepositoryResult.v1',
            LIST_MANAGER_HEALTH_SNAPSHOTS_QUERY_V1: 'operations_observability.ListManagerHealthSnapshotsQuery.v1',
            LIST_MANAGER_HEALTH_SNAPSHOTS_RESULT_V1: 'operations_observability.ListManagerHealthSnapshotsResult.v1',
            SAVE_MANAGER_HEALTH_SCORES_COMMAND_V1: 'operations_observability.SaveManagerHealthScoresCommand.v1',
            SAVE_MANAGER_HEALTH_SCORES_RESULT_V1: 'operations_observability.SaveManagerHealthScoresResult.v1',
            LIST_MANAGER_HEALTH_HISTORY_QUERY_V1: 'operations_observability.ListManagerHealthHistoryQuery.v1',
            LIST_MANAGER_HEALTH_HISTORY_RESULT_V1: 'operations_observability.ListManagerHealthHistoryResult.v1',
        })
        assert.deepEqual([...contracts.MANAGER_HEALTH_LEVELS_V1], ['healthy', 'warning', 'critical'])
    })

    check('strict parsers accept exact envelopes and preserve duplicate array identity and order', () => {
        assert.equal(contracts.parseEnsureManagerHealthRepositoryCommandV1(requests.ensure), requests.ensure)
        assert.equal(contracts.parseListManagerHealthSnapshotsQueryV1(requests.snapshots), requests.snapshots)
        const save = contracts.parseSaveManagerHealthScoresCommandV1(requests.save)
        const history = contracts.parseListManagerHealthHistoryQueryV1(requests.history)
        assert.equal(save, requests.save)
        assert.equal(save.items, duplicateItems)
        assert.deepEqual(save.items.map(item => item.managerId), duplicateItems.map(item => item.managerId))
        assert.equal(history, requests.history)
        assert.equal(history.managerIds, requests.history.managerIds)
        assert.equal(history.periodDays, -1.25)
        const fractionalScores = {
            contract: contracts.SAVE_MANAGER_HEALTH_SCORES_COMMAND_V1,
            items: [{
                managerId: 'manager-fractional',
                score: 72.5,
                declineStreak: -1.25,
                healthLevel: 'warning',
            }],
        }
        assert.equal(contracts.parseSaveManagerHealthScoresCommandV1(fractionalScores), fractionalScores)
        assert.equal(contracts.parseListManagerHealthHistoryQueryV1({
            ...requests.history,
            periodDays: 30,
        }).periodDays, 30)
        assert.deepEqual(
            contracts.parseSaveManagerHealthScoresCommandV1({
                contract: contracts.SAVE_MANAGER_HEALTH_SCORES_COMMAND_V1,
                items: [],
            }).items,
            [],
        )
        assert.deepEqual(
            contracts.parseListManagerHealthHistoryQueryV1({
                contract: contracts.LIST_MANAGER_HEALTH_HISTORY_QUERY_V1,
                managerIds: [],
                periodDays: 0.5,
            }).managerIds,
            [],
        )
    })

    check('strict parsers reject extras v2 malformed arrays invalid values and non-finite days', () => {
        const parserCases = [
            [contracts.parseEnsureManagerHealthRepositoryCommandV1, requests.ensure],
            [contracts.parseListManagerHealthSnapshotsQueryV1, requests.snapshots],
            [contracts.parseSaveManagerHealthScoresCommandV1, requests.save],
            [contracts.parseListManagerHealthHistoryQueryV1, requests.history],
        ]
        for (const [parse, request] of parserCases) {
            assert.throws(() => parse({ ...request, tableName: 'health_snapshots' }))
            assert.throws(
                () => parse({ ...request, contract: request.contract.replace('.v1', '.v2') }),
                error => error.code === 'UNSUPPORTED_CONTRACT_VERSION',
            )
        }
        assert.throws(() => contracts.parseSaveManagerHealthScoresCommandV1({ ...requests.save, items: null }))
        assert.throws(() => contracts.parseSaveManagerHealthScoresCommandV1({
            ...requests.save,
            items: [{ ...duplicateItems[0], sql: 'DELETE FROM health_snapshots' }],
        }))
        assert.throws(() => contracts.parseSaveManagerHealthScoresCommandV1({
            ...requests.save, items: [{ ...duplicateItems[0], managerId: '   ' }],
        }))
        assert.throws(() => contracts.parseSaveManagerHealthScoresCommandV1({
            ...requests.save, items: [{ ...duplicateItems[0], score: Number.NaN }],
        }))
        assert.throws(() => contracts.parseSaveManagerHealthScoresCommandV1({
            ...requests.save, items: [{ ...duplicateItems[0], declineStreak: Number.POSITIVE_INFINITY }],
        }))
        assert.throws(() => contracts.parseSaveManagerHealthScoresCommandV1({
            ...requests.save, items: [{ ...duplicateItems[0], healthLevel: 'unknown' }],
        }))
        assert.throws(() => contracts.parseListManagerHealthHistoryQueryV1({ ...requests.history, managerIds: 'x' }))
        assert.throws(() => contracts.parseListManagerHealthHistoryQueryV1({ ...requests.history, managerIds: [''] }))
        assert.throws(() => contracts.parseListManagerHealthHistoryQueryV1({ ...requests.history, periodDays: Number.NaN }))
        assert.throws(() => contracts.parseListManagerHealthHistoryQueryV1({ ...requests.history, periodDays: Infinity }))
        assert.throws(() => contracts.parseListManagerHealthHistoryQueryV1({ ...requests.history, periodDays: 30.0001 }))
    })

    await checkAsync('handlers map exact port inputs results Dates and preserve duplicate arrays', async () => {
        const calls = []
        const recordedAt = new Date('2026-08-09T12:00:00.000Z')
        const port = {
            async ensure() { calls.push(['ensure']) },
            async listSnapshots() {
                calls.push(['snapshots'])
                return [{ managerId: 'manager-1', score: 72, declineStreak: 3 }]
            },
            async saveScores(items) { calls.push(['save', items]) },
            async listHistory(managerIds, periodDays) {
                calls.push(['history', managerIds, periodDays])
                return [{ managerId: 'manager-1', score: 72, healthLevel: 'warning', recordedAt }]
            },
        }
        const results = [
            await handlers.createEnsureManagerHealthRepositoryHandlerV1(port)(requests.ensure),
            await handlers.createListManagerHealthSnapshotsHandlerV1(port)(requests.snapshots),
            await handlers.createSaveManagerHealthScoresHandlerV1(port)(requests.save),
            await handlers.createListManagerHealthHistoryHandlerV1(port)(requests.history),
        ]
        assert.deepEqual(calls.map(call => call[0]), ['ensure', 'snapshots', 'save', 'history'])
        assert.equal(calls[2][1], duplicateItems)
        assert.equal(calls[3][1], requests.history.managerIds)
        assert.equal(calls[3][2], -1.25)
        assert.equal(results[3].items[0].recordedAt, recordedAt)
        assert.deepEqual(results.map(result => result.contract), [
            contracts.ENSURE_MANAGER_HEALTH_REPOSITORY_RESULT_V1,
            contracts.LIST_MANAGER_HEALTH_SNAPSHOTS_RESULT_V1,
            contracts.SAVE_MANAGER_HEALTH_SCORES_RESULT_V1,
            contracts.LIST_MANAGER_HEALTH_HISTORY_RESULT_V1,
        ])
        assert.equal(results[0].completed, true)
        assert.equal(results[2].completed, true)
    })

    await checkAsync('invalid requests never reach ports and owner failures remain visible', async () => {
        let calls = 0
        const port = {
            async ensure() { calls += 1; throw new Error('owner down') },
            async listSnapshots() { calls += 1; return [] },
            async saveScores() { calls += 1 },
            async listHistory() { calls += 1; return [] },
        }
        await assert.rejects(handlers.createSaveManagerHealthScoresHandlerV1(port)({
            ...requests.save,
            items: [{ ...duplicateItems[0], healthLevel: 'unknown' }],
        }))
        assert.equal(calls, 0)
        await assert.rejects(handlers.createListManagerHealthHistoryHandlerV1(port)({
            ...requests.history,
            periodDays: 30.0001,
        }))
        assert.equal(calls, 0)
        await assert.rejects(handlers.createEnsureManagerHealthRepositoryHandlerV1(port)(requests.ensure), /owner down/)
        assert.equal(calls, 1)
    })

    await checkAsync('empty adapter operations return before ensure and issue no Prisma call', async () => {
        const calls = []
        const adapter = loadAdapter({
            async $executeRawUnsafe(...args) { calls.push(['write', ...args]); return 0 },
            async $queryRawUnsafe(...args) { calls.push(['read', ...args]); return [] },
        })
        await adapter.saveScores([])
        assert.deepEqual(plain(await adapter.listHistory([], -2.75)), [])
        assert.deepEqual(calls, [])
    })

    await checkAsync('adapter preserves DDL bytes fixed bound SQL mappings duplicate order and quote safety', async () => {
        const writes = []
        const reads = []
        const recordedAt = new Date('2026-08-09T12:00:00.000Z')
        const prisma = {
            async $executeRawUnsafe(sql, ...args) { writes.push([sql, args]); return 0 },
            async $queryRawUnsafe(sql, ...args) {
                reads.push([sql, args])
                if (sql === LIST_SNAPSHOTS_SQL) {
                    return [
                        { manager_id: 'manager-1', score: 81, decline_streak: 0 },
                        { manager_id: 'manager-1', score: 31, decline_streak: 4 },
                    ]
                }
                if (sql === LIST_HISTORY_SQL) {
                    return [
                        { manager_id: 'manager-1', score: 81, health_level: 'healthy', recorded_at: recordedAt },
                        { manager_id: 'manager-1', score: 31, health_level: 'critical', recorded_at: recordedAt },
                    ]
                }
                throw new Error(`unexpected read: ${sql}`)
            },
        }
        const adapter = loadAdapter(prisma)
        await adapter.ensure()
        await adapter.ensure()
        const snapshots = await adapter.listSnapshots()
        await adapter.saveScores(duplicateItems)
        const history = await adapter.listHistory(requests.history.managerIds, requests.history.periodDays)

        assert.deepEqual(writes.slice(0, 4).map(([sql]) => sql), FROZEN_DDL_SQL)
        assert.equal(writes.length, 6)
        assert.equal(writes[4][0], SAVE_SNAPSHOTS_SQL)
        assert.equal(writes[5][0], APPEND_HISTORY_SQL)
        assert.deepEqual(plain(writes[4][1]), [
            duplicateItems.map(item => item.managerId),
            duplicateItems.map(item => item.score),
            duplicateItems.map(item => item.declineStreak),
        ])
        assert.deepEqual(plain(writes[5][1]), [
            duplicateItems.map(item => item.managerId),
            duplicateItems.map(item => item.score),
            duplicateItems.map(item => item.healthLevel),
        ])
        assert.equal(SAVE_SNAPSHOTS_SQL.includes(duplicateItems[1].managerId), false)
        assert.equal(APPEND_HISTORY_SQL.includes(duplicateItems[1].managerId), false)
        assert.match(SAVE_SNAPSHOTS_SQL, /UNNEST\(\$1::text\[\], \$2::integer\[\], \$3::integer\[\]\)/)
        assert.match(SAVE_SNAPSHOTS_SQL, /WITH ORDINALITY[\s\S]*ORDER BY v\.ordinal[\s\S]*ON CONFLICT/)
        assert.match(APPEND_HISTORY_SQL, /UNNEST\(\$1::text\[\], \$2::integer\[\], \$3::text\[\]\)/)
        assert.match(APPEND_HISTORY_SQL, /recorded_at > NOW\(\) - INTERVAL '1 hour'/)
        assert.deepEqual(reads, [
            [LIST_SNAPSHOTS_SQL, []],
            [LIST_HISTORY_SQL, [requests.history.managerIds, -1.25]],
        ])
        assert.deepEqual(plain(snapshots), [
            { managerId: 'manager-1', score: 81, declineStreak: 0 },
            { managerId: 'manager-1', score: 31, declineStreak: 4 },
        ])
        assert.deepEqual(plain(history), [
            { managerId: 'manager-1', score: 81, healthLevel: 'healthy', recordedAt: recordedAt.toISOString() },
            { managerId: 'manager-1', score: 31, healthLevel: 'critical', recordedAt: recordedAt.toISOString() },
        ])
        assert.equal(history[0].recordedAt, recordedAt)
    })

    await checkAsync('primary failure propagates atomically and skips history', async () => {
        const calls = []
        const logs = []
        const adapter = loadAdapter({
            async $executeRawUnsafe(sql) {
                calls.push(sql)
                if (sql === SAVE_SNAPSHOTS_SQL) throw new Error('primary down')
                return 0
            },
        }, { error(...args) { logs.push(args) } })
        await assert.rejects(adapter.saveScores(duplicateItems), /primary down/)
        assert.equal(calls.filter(sql => sql === SAVE_SNAPSHOTS_SQL).length, 1)
        assert.equal(calls.includes(APPEND_HISTORY_SQL), false)
        assert.deepEqual(logs, [])
    })

    await checkAsync('history failure leaves primary committed logs exact error and resolves', async () => {
        const calls = []
        const logs = []
        const historyError = new Error('history down')
        const adapter = loadAdapter({
            async $executeRawUnsafe(sql) {
                calls.push(sql)
                if (sql === APPEND_HISTORY_SQL) throw historyError
                return 0
            },
        }, { error(...args) { logs.push(args) } })
        await adapter.saveScores(duplicateItems)
        assert.equal(calls.indexOf(SAVE_SNAPSHOTS_SQL) < calls.indexOf(APPEND_HISTORY_SQL), true)
        assert.deepEqual(logs, [[
            '[health-history] Failed to write history, continuing:',
            historyError,
        ]])
    })

    await checkAsync('failed DDL leaves latch false and retry reruns all four statements', async () => {
        const calls = []
        let failColumn = true
        const adapter = loadAdapter({
            async $executeRawUnsafe(sql) {
                calls.push(sql)
                if (failColumn && sql === FROZEN_DDL_SQL[1]) {
                    failColumn = false
                    throw new Error('column down')
                }
                return 0
            },
        })
        await assert.rejects(adapter.ensure(), /column down/)
        await adapter.ensure()
        assert.deepEqual(calls, [
            FROZEN_DDL_SQL[0],
            FROZEN_DDL_SQL[1],
            ...FROZEN_DDL_SQL,
        ])
    })

    await checkAsync('concurrent first ensures retain inherited four-statement race', async () => {
        const calls = []
        const adapter = loadAdapter({
            async $executeRawUnsafe(sql) { calls.push(sql); await Promise.resolve(); return 0 },
        })
        await Promise.all([adapter.ensure(), adapter.ensure()])
        assert.equal(calls.length, 8)
        for (const sql of FROZEN_DDL_SQL) assert.equal(calls.filter(value => value === sql).length, 2)
    })

    check('adapter source has no app clock transaction tagged interpolation or fragment capacity', () => {
        assert.equal(/\b(?:Date\.now|new Date)\b/.test(adapterSource), false)
        assert.equal(/\$transaction|Promise\.all|Prisma\.(?:raw|sql)/.test(adapterSource), false)
        assert.equal(/\$executeRaw`/.test(adapterSource), false)
        assert.equal(/\$executeRawUnsafe\(`[^`]*\$\{/.test(adapterSource), false)
        assert.equal(/tableName|whereClause|predicate|transactionHandle/.test(adapterSource), false)
        assert.match(LIST_HISTORY_SQL, /\$2::double precision \* INTERVAL '1 day'/)
    })
} finally {
    rmSync(out, { recursive: true, force: true })
}

process.stdout.write(`${JSON.stringify({ status: 'PASS', passed: checks.length, checks }, null, 2)}\n`)
