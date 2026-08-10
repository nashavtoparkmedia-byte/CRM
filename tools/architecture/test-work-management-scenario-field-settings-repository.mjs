#!/usr/bin/env node

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import vm from 'node:vm'

const root = process.cwd()
const out = mkdtempSync(path.join(tmpdir(), 'yoko-scenario-field-settings-'))
const contractPath = 'gravity-mvp/src/contracts/work-management/v1/scenario-field-settings.ts'
const handlerPath = 'gravity-mvp/src/modules/work-management/public/v1/scenario-field-settings-handler.ts'
const adapterPath = 'gravity-mvp/src/modules/work-management/public/v1/legacy-prisma-scenario-field-settings-adapter.ts'
const compileSources = [
  contractPath,
  'gravity-mvp/src/contracts/work-management/v1/index.ts',
  handlerPath,
].map((value) => path.join(root, value))

const compiled = spawnSync(process.execPath, [
  path.join(root, 'gravity-mvp/node_modules/typescript/bin/tsc'),
  '--target', 'ES2022', '--module', 'commonjs', '--moduleResolution', 'node',
  '--strict', '--skipLibCheck', '--rootDir', path.join(root, 'gravity-mvp/src'), '--outDir', out,
  ...compileSources,
], { encoding: 'utf8' })
if (compiled.status !== 0) {
  process.stderr.write(compiled.stdout + compiled.stderr)
  process.exit(1)
}

const require = createRequire(import.meta.url)
const contracts = require(path.join(out, 'contracts/work-management/v1/index.js'))
const handlers = require(path.join(
  out,
  'modules/work-management/public/v1/scenario-field-settings-handler.js',
))
const ts = require(path.join(root, 'gravity-mvp/node_modules/typescript/lib/typescript.js'))
const adapterSource = readFileSync(path.join(root, adapterPath), 'utf8')
const adapterOutput = ts.transpileModule(adapterSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText
const legacyMergeSource = readFileSync(path.join(root, 'gravity-mvp/src/lib/tasks/scenario-settings.ts'), 'utf8')
const legacyMergeOutput = ts.transpileModule(legacyMergeSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText

const checks = []
const check = (name, fn) => { fn(); checks.push(name) }
const checkAsync = async (name, fn) => { await fn(); checks.push(name) }
const plain = (value) => JSON.parse(JSON.stringify(value))

const getCommand = {
  contract: contracts.GET_MERGED_SCENARIO_FIELDS_QUERY_V1,
  scenarioId: 'driver_return',
}
const upsertCommand = {
  contract: contracts.UPSERT_SCENARIO_FIELD_SETTING_COMMAND_V1,
  scenarioId: 'driver_return',
  fieldId: 'reason',
  patch: { showInList: false, showInCard: true, order: 0 },
  userId: 'operator-1',
}
const resetCommand = {
  contract: contracts.RESET_SCENARIO_FIELD_SETTING_COMMAND_V1,
  scenarioId: 'driver_return',
  fieldId: 'reason',
}

const defaults = [
  {
    id: 'reason', label: 'Reason', type: 'enum', source: 'manual', priorityWeight: 1,
    showInList: true, showInCard: true, filterable: true, sortable: true, groupable: false,
  },
  {
    id: 'score', label: 'Score', type: 'number', source: 'derived', priorityWeight: 2,
    showInList: false, showInCard: true, filterable: false,
  },
]

const FROZEN_UPSERT_SQL = `
INSERT INTO scenario_field_settings (
  id, "scenarioId", "fieldId",
  "showInList", "showInCard", "filterable", "sortable", "groupable", "order",
  "updatedAt", "updatedBy"
)
VALUES (
  $1, $2, $3,
  $4, $5, $6, $7, $8, $9,
  $10::timestamp, $11
)
ON CONFLICT ("scenarioId", "fieldId") DO UPDATE SET
  "showInList" = COALESCE(EXCLUDED."showInList", scenario_field_settings."showInList"),
  "showInCard" = COALESCE(EXCLUDED."showInCard", scenario_field_settings."showInCard"),
  "filterable" = COALESCE(EXCLUDED."filterable", scenario_field_settings."filterable"),
  "sortable"   = COALESCE(EXCLUDED."sortable",   scenario_field_settings."sortable"),
  "groupable"  = COALESCE(EXCLUDED."groupable",  scenario_field_settings."groupable"),
  "order"      = COALESCE(EXCLUDED."order",      scenario_field_settings."order"),
  "updatedAt"  = EXCLUDED."updatedAt",
  "updatedBy"  = EXCLUDED."updatedBy"`

const FROZEN_RESET_SQL = `
DELETE FROM scenario_field_settings
WHERE "scenarioId" = $1 AND "fieldId" = $2`

function loadAdapter(prisma, options = {}) {
  const module = { exports: {} }
  const calls = options.calls ?? []
  const getMergedFieldsForScenario = options.getMergedFieldsForScenario ?? (async (scenarioId) => {
    calls.push(['getMergedFieldsForScenario', scenarioId])
    return options.mergedFields ?? []
  })
  vm.runInNewContext(adapterOutput, {
    module,
    exports: module.exports,
    Date: options.Date ?? Date,
    require(specifier) {
      if (specifier === '@/lib/prisma') return { prisma }
      if (specifier === '@/lib/tasks/scenario-settings') return { getMergedFieldsForScenario }
      throw new Error(`unexpected adapter import: ${specifier}`)
    },
  })
  return module.exports
}

function loadLegacyMerge(prisma, getScenarioFields) {
  const module = { exports: {} }
  vm.runInNewContext(legacyMergeOutput, {
    module,
    exports: module.exports,
    require(specifier) {
      if (specifier === '@/lib/prisma') return { prisma }
      if (specifier === './scenario-config') return { getScenarioFields }
      if (specifier === './scenario-settings-types') return { MAX_LIST_PREVIEW_FIELDS: 8 }
      throw new Error(`unexpected scenario settings import: ${specifier}`)
    },
  })
  return module.exports
}

try {
  check('contract and result identifiers plus preview constant are exact', () => {
    assert.equal(contracts.GET_MERGED_SCENARIO_FIELDS_QUERY_V1, 'work_management.GetMergedScenarioFieldsQuery.v1')
    assert.equal(contracts.GET_MERGED_SCENARIO_FIELDS_RESULT_V1, 'work_management.GetMergedScenarioFieldsResult.v1')
    assert.equal(contracts.UPSERT_SCENARIO_FIELD_SETTING_COMMAND_V1, 'work_management.UpsertScenarioFieldSettingCommand.v1')
    assert.equal(contracts.UPSERT_SCENARIO_FIELD_SETTING_RESULT_V1, 'work_management.UpsertScenarioFieldSettingResult.v1')
    assert.equal(contracts.RESET_SCENARIO_FIELD_SETTING_COMMAND_V1, 'work_management.ResetScenarioFieldSettingCommand.v1')
    assert.equal(contracts.RESET_SCENARIO_FIELD_SETTING_RESULT_V1, 'work_management.ResetScenarioFieldSettingResult.v1')
    assert.equal(contracts.MAX_LIST_PREVIEW_FIELDS, 8)
  })

  check('strict parsers accept exact commands including false zero null and empty patches', () => {
    assert.deepEqual(contracts.parseGetMergedScenarioFieldsQueryV1(getCommand), getCommand)
    assert.deepEqual(contracts.parseUpsertScenarioFieldSettingCommandV1(upsertCommand), upsertCommand)
    assert.deepEqual(contracts.parseResetScenarioFieldSettingCommandV1(resetCommand), resetCommand)
    for (const patch of [
      {},
      { showInList: false, showInCard: false, filterable: false, sortable: false, groupable: false, order: 0 },
      { showInList: null, showInCard: null, filterable: null, sortable: null, groupable: null, order: null },
    ]) {
      const input = { ...upsertCommand, patch }
      assert.deepEqual(contracts.parseUpsertScenarioFieldSettingCommandV1(input), input)
    }
  })

  check('strict parsers reject extras v2 empty identifiers and invalid patch values', () => {
    const cases = [
      [contracts.parseGetMergedScenarioFieldsQueryV1, getCommand],
      [contracts.parseUpsertScenarioFieldSettingCommandV1, upsertCommand],
      [contracts.parseResetScenarioFieldSettingCommandV1, resetCommand],
    ]
    for (const [parse, command] of cases) {
      assert.throws(() => parse({ ...command, sql: 'SELECT 1' }), (error) => error.code === 'INVALID_CONTRACT')
      assert.throws(() => parse({ ...command, contract: command.contract.replace('.v1', '.v2') }), (error) =>
        error.code === 'UNSUPPORTED_CONTRACT_VERSION')
      assert.throws(() => parse({ ...command, scenarioId: '  ' }), (error) => error.code === 'INVALID_CONTRACT')
    }
    assert.throws(() => contracts.parseUpsertScenarioFieldSettingCommandV1({
      ...upsertCommand, fieldId: '',
    }))
    assert.throws(() => contracts.parseResetScenarioFieldSettingCommandV1({ ...resetCommand, fieldId: '' }))
    assert.throws(() => contracts.parseUpsertScenarioFieldSettingCommandV1({
      ...upsertCommand, patch: { showInList: 0 },
    }))
    assert.throws(() => contracts.parseUpsertScenarioFieldSettingCommandV1({
      ...upsertCommand, patch: { order: Number.NaN },
    }))
    assert.throws(() => contracts.parseUpsertScenarioFieldSettingCommandV1({
      ...upsertCommand, patch: { hidden: true },
    }))
    assert.throws(() => contracts.parseUpsertScenarioFieldSettingCommandV1({
      ...upsertCommand, userId: '',
    }))
  })

  await checkAsync('handlers validate before ports and preserve exact mappings and results', async () => {
    const calls = []
    const fields = [{ ...defaults[0], order: 0, hasOverride: false }]
    const port = {
      async getMerged(scenarioId) { calls.push(['getMerged', scenarioId]); return fields },
      async upsert(input) { calls.push(['upsert', input]) },
      async reset(scenarioId, fieldId) { calls.push(['reset', scenarioId, fieldId]) },
    }
    const got = await handlers.createGetMergedScenarioFieldsHandlerV1(port)(getCommand)
    const upserted = await handlers.createUpsertScenarioFieldSettingHandlerV1(port)(upsertCommand)
    const reset = await handlers.createResetScenarioFieldSettingHandlerV1(port)(resetCommand)
    assert.deepEqual(calls, [
      ['getMerged', 'driver_return'],
      ['upsert', {
        scenarioId: 'driver_return', fieldId: 'reason',
        patch: { showInList: false, showInCard: true, order: 0 }, userId: 'operator-1',
      }],
      ['reset', 'driver_return', 'reason'],
    ])
    assert.deepEqual(got, { contract: contracts.GET_MERGED_SCENARIO_FIELDS_RESULT_V1, fields })
    assert.deepEqual(upserted, { contract: contracts.UPSERT_SCENARIO_FIELD_SETTING_RESULT_V1, completed: true })
    assert.deepEqual(reset, { contract: contracts.RESET_SCENARIO_FIELD_SETTING_RESULT_V1, completed: true })
    await assert.rejects(handlers.createUpsertScenarioFieldSettingHandlerV1(port)({ ...upsertCommand, raw: true }))
    assert.equal(calls.length, 3)
  })

  await checkAsync('handler and repository errors remain visible', async () => {
    const failingPort = {
      async getMerged() { throw new Error('read failed') },
      async upsert() { throw new Error('upsert failed') },
      async reset() { throw new Error('reset failed') },
    }
    await assert.rejects(handlers.createGetMergedScenarioFieldsHandlerV1(failingPort)(getCommand), /read failed/)
    await assert.rejects(handlers.createUpsertScenarioFieldSettingHandlerV1(failingPort)(upsertCommand), /upsert failed/)
    await assert.rejects(handlers.createResetScenarioFieldSettingHandlerV1(failingPort)(resetCommand), /reset failed/)
  })

  await checkAsync('adapter merged query delegates once and preserves result identity including unknown scenarios', async () => {
    const calls = []
    const mergedFields = [{ ...defaults[0], order: 0, hasOverride: false }]
    const prisma = { async $executeRawUnsafe() { throw new Error('unexpected write') } }
    const adapterModule = loadAdapter(prisma, { calls, mergedFields })
    const fields = await adapterModule.legacyPrismaScenarioFieldSettingsPortV1.getMerged('driver_return')
    assert.equal(fields, mergedFields)
    assert.deepEqual(calls, [['getMergedFieldsForScenario', 'driver_return']])
    const unknownCalls = []
    const unknown = await loadAdapter(prisma, { calls: unknownCalls, mergedFields: [] })
      .legacyPrismaScenarioFieldSettingsPortV1.getMerged('unknown_scenario')
    assert.deepEqual(unknown, [])
    assert.deepEqual(unknownCalls, [['getMergedFieldsForScenario', 'unknown_scenario']])
  })

  await checkAsync('legacy merged query retains default override nullish sorting and unknown-field behavior', async () => {
    const rows = [
      {
        scenarioId: 'driver_return', fieldId: 'score', showInList: true, showInCard: null,
        filterable: null, sortable: false, groupable: true, order: 0,
        updatedAt: null, updatedBy: null,
      },
      {
        scenarioId: 'driver_return', fieldId: 'unknown', showInList: false, showInCard: false,
        filterable: false, sortable: false, groupable: false, order: -100,
        updatedAt: null, updatedBy: null,
      },
    ]
    const reads = []
    const prisma = {
      async $queryRaw(strings, ...args) { reads.push([Array.from(strings), args]); return rows },
    }
    const legacy = loadLegacyMerge(
      prisma,
      (scenarioId) => scenarioId === 'driver_return' ? defaults : [],
    )
    const fields = await legacy.getMergedFieldsForScenario('driver_return')
    assert.equal(reads.length, 1)
    assert.deepEqual(reads[0][1], ['driver_return'])
    assert.deepEqual(plain(fields), [
      { ...defaults[0], order: 0, hasOverride: false },
      {
        ...defaults[1], showInList: true, showInCard: true, filterable: false,
        sortable: false, groupable: true, order: 0, hasOverride: true,
      },
    ])
    const unknown = await legacy.getMergedFieldsForScenario('unknown_scenario')
    assert.deepEqual(plain(unknown), [])
  })

  await checkAsync('upsert uses deterministic id one timestamp and exact bind order', async () => {
    const calls = []
    let dateConstructions = 0
    class FixedDate extends Date {
      constructor(...args) {
        super(...(args.length ? args : ['2026-08-10T12:34:56.789Z']))
        dateConstructions += 1
      }
    }
    const prisma = {
      async $executeRawUnsafe(sql, ...args) { calls.push([sql, args]); return 1 },
    }
    const adapterModule = loadAdapter(prisma, { Date: FixedDate })
    await adapterModule.legacyPrismaScenarioFieldSettingsPortV1.upsert({
      scenarioId: 'driver_return', fieldId: 'reason',
      patch: { showInList: false, showInCard: null, filterable: true, sortable: false, groupable: null, order: 0 },
      userId: null,
    })
    assert.equal(dateConstructions, 1)
    assert.equal(calls.length, 1)
    assert.equal(calls[0][0], FROZEN_UPSERT_SQL)
    assert.deepEqual(calls[0][1], [
      'driver_return_reason', 'driver_return', 'reason',
      false, null, true, false, null, 0,
      '2026-08-10T12:34:56.789Z', null,
    ])
  })

  await checkAsync('absent explicit-null and empty patches bind identically while false and zero survive', async () => {
    const invocations = []
    const prisma = {
      async $executeRawUnsafe(sql, ...args) { invocations.push([sql, args]); return 1 },
    }
    const adapter = loadAdapter(prisma).legacyPrismaScenarioFieldSettingsPortV1
    await adapter.upsert({ scenarioId: 's', fieldId: 'f', patch: {}, userId: 'u' })
    await adapter.upsert({
      scenarioId: 's', fieldId: 'f',
      patch: { showInList: null, showInCard: null, filterable: null, sortable: null, groupable: null, order: null },
      userId: 'u',
    })
    assert.deepEqual(invocations[0][1].slice(0, 9), ['s_f', 's', 'f', null, null, null, null, null, null])
    assert.deepEqual(invocations[1][1].slice(0, 9), invocations[0][1].slice(0, 9))
  })

  await checkAsync('reset delegates one exact fixed statement with scenario then field binds', async () => {
    const calls = []
    const prisma = {
      async $executeRawUnsafe(sql, ...args) { calls.push([sql, args]); return 1 },
    }
    const adapterModule = loadAdapter(prisma)
    await adapterModule.legacyPrismaScenarioFieldSettingsPortV1.reset('driver_return', 'reason')
    assert.deepEqual(calls, [[FROZEN_RESET_SQL, ['driver_return', 'reason']]])
  })

  check('repository is fixed-policy and exposes no generic SQL transaction or retry capability', () => {
    assert.doesNotMatch(adapterSource, /\$transaction|\bcatch\b|\bretry\b|console\./i)
    assert.doesNotMatch(adapterSource, /tableName|rawSql|whereClause|orderBy|transactionHandle/i)
    assert.equal((adapterSource.match(/\$queryRawUnsafe/g) ?? []).length, 0)
    assert.equal((adapterSource.match(/\$executeRawUnsafe/g) ?? []).length, 2)
  })
} finally {
  rmSync(out, { recursive: true, force: true })
}

process.stdout.write(`${JSON.stringify({ status: 'PASS', passed: checks.length, checks }, null, 2)}\n`)
