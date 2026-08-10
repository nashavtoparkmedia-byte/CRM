#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import vm from 'node:vm'

const root = process.cwd()
const out = mkdtempSync(path.join(tmpdir(), 'yoko-fleet-event-retention-'))
const sources = [
  'gravity-mvp/src/contracts/fleet-operations/v1/event-retention-commands.ts',
  'gravity-mvp/src/contracts/fleet-operations/v1/index.ts',
  'gravity-mvp/src/modules/fleet-operations/public/v1/event-retention-handler.ts',
].map(value => path.join(root, value))
const compiled = spawnSync(
  process.execPath,
  [
    path.join(root, 'gravity-mvp/node_modules/typescript/bin/tsc'),
    '--target', 'ES2022',
    '--module', 'commonjs',
    '--moduleResolution', 'node',
    '--strict',
    '--skipLibCheck',
    '--rootDir', path.join(root, 'gravity-mvp/src'),
    '--outDir', out,
    ...sources,
  ],
  { encoding: 'utf8' },
)

if (compiled.status !== 0) {
  process.stderr.write(compiled.stdout + compiled.stderr)
  process.exit(1)
}

const require = createRequire(import.meta.url)
const contracts = require(path.join(out, 'contracts/fleet-operations/v1/index.js'))
const {
  createRunApiLogRetentionHandlerV1,
  createRunDriverEventRetentionHandlerV1,
} = require(path.join(out, 'modules/fleet-operations/public/v1/event-retention-handler.js'))
const checks = []
const check = (name, fn) => {
  fn()
  checks.push(name)
}
const checkAsync = async (name, fn) => {
  await fn()
  checks.push(name)
}

try {
  const driver = { contract: contracts.RUN_DRIVER_EVENT_RETENTION_COMMAND_V1, dryRun: true }
  const apiLog = { contract: contracts.RUN_API_LOG_RETENTION_COMMAND_V1, dryRun: false }

  check('identifiers explicit', () => {
    assert.equal(
      contracts.RUN_DRIVER_EVENT_RETENTION_COMMAND_V1,
      'fleet_operations.RunDriverEventRetentionCommand.v1',
    )
    assert.equal(
      contracts.RUN_API_LOG_RETENTION_COMMAND_V1,
      'fleet_operations.RunApiLogRetentionCommand.v1',
    )
    assert.equal(
      contracts.RUN_DRIVER_EVENT_RETENTION_RESULT_V1,
      'fleet_operations.RunDriverEventRetentionResult.v1',
    )
    assert.equal(
      contracts.RUN_API_LOG_RETENTION_RESULT_V1,
      'fleet_operations.RunApiLogRetentionResult.v1',
    )
  })
  check('commands parse exactly', () => {
    assert.deepEqual(contracts.parseRunDriverEventRetentionCommandV1(driver), driver)
    assert.deepEqual(contracts.parseRunApiLogRetentionCommandV1(apiLog), apiLog)
  })
  check('v2 rejected', () => {
    assert.throws(
      () => contracts.parseRunDriverEventRetentionCommandV1({
        ...driver,
        contract: 'fleet_operations.RunDriverEventRetentionCommand.v2',
      }),
      error => error.code === 'UNSUPPORTED_CONTRACT_VERSION',
    )
    assert.throws(
      () => contracts.parseRunApiLogRetentionCommandV1({
        ...apiLog,
        contract: 'fleet_operations.RunApiLogRetentionCommand.v2',
      }),
      error => error.code === 'UNSUPPORTED_CONTRACT_VERSION',
    )
  })
  check('policy fields rejected', () => {
    const forbidden = {
      tableName: 'DriverEvent',
      ageDays: 180,
      limit: 100,
      predicate: 'createdAt',
      sql: 'DELETE',
    }
    for (const [field, value] of Object.entries(forbidden)) {
      assert.throws(() => contracts.parseRunDriverEventRetentionCommandV1({
        ...driver,
        [field]: value,
      }))
      assert.throws(() => contracts.parseRunApiLogRetentionCommandV1({
        ...apiLog,
        [field]: value,
      }))
    }
  })
  check('dryRun type required', () => {
    assert.throws(() => contracts.parseRunDriverEventRetentionCommandV1({
      contract: driver.contract,
    }))
    assert.throws(() => contracts.parseRunApiLogRetentionCommandV1({
      contract: apiLog.contract,
    }))
    assert.throws(() => contracts.parseRunDriverEventRetentionCommandV1({ ...driver, dryRun: 'true' }))
    assert.throws(() => contracts.parseRunApiLogRetentionCommandV1({ ...apiLog, dryRun: null }))
  })

  const calls = []
  const port = {
    async runDriverEventRetention(input) {
      calls.push(['driver', input])
      return { selectedCount: 4 }
    },
    async runApiLogRetention(input) {
      calls.push(['api-log', input])
      return { selectedCount: 7 }
    },
  }
  const driverResult = await createRunDriverEventRetentionHandlerV1(port)(driver)
  const apiLogResult = await createRunApiLogRetentionHandlerV1(port)(apiLog)

  check('exact owner mappings', () => {
    assert.deepEqual(calls, [
      ['driver', { dryRun: true }],
      ['api-log', { dryRun: false }],
    ])
  })
  check('results explicit', () => {
    assert.deepEqual(driverResult, {
      contract: contracts.RUN_DRIVER_EVENT_RETENTION_RESULT_V1,
      selectedCount: 4,
    })
    assert.deepEqual(apiLogResult, {
      contract: contracts.RUN_API_LOG_RETENTION_RESULT_V1,
      selectedCount: 7,
    })
  })
  await checkAsync('invalid never persists', async () => {
    const before = calls.length
    await assert.rejects(createRunDriverEventRetentionHandlerV1(port)({
      contract: driver.contract,
    }))
    await assert.rejects(createRunApiLogRetentionHandlerV1(port)({ ...apiLog, limit: 1 }))
    assert.equal(calls.length, before)
  })
  await checkAsync('owner failures visible', async () => {
    const failingPort = {
      async runDriverEventRetention() { throw new Error('driver retention down') },
      async runApiLogRetention() { throw new Error('api-log retention down') },
    }
    await assert.rejects(
      createRunDriverEventRetentionHandlerV1(failingPort)(driver),
      /driver retention down/,
    )
    await assert.rejects(
      createRunApiLogRetentionHandlerV1(failingPort)(apiLog),
      /api-log retention down/,
    )
  })
  await checkAsync('typed fleet adapter preserves DB-clock selection and exact selected-id deletion', async () => {
    const queryCalls = []
    const deleteCalls = []
    const selected = {
      DriverEvent: [[{ id: 'driver-2' }, { id: 'driver-1' }]],
      ApiLog: [[{ id: 'api-dry' }], []],
    }
    const prisma = {
      async $queryRaw(strings) {
        const sql = strings.join('')
        const model = sql.includes('"DriverEvent"') ? 'DriverEvent' : 'ApiLog'
        queryCalls.push([model, sql])
        return selected[model].shift()
      },
      driverEvent: {
        async deleteMany(input) { deleteCalls.push(['DriverEvent', input]); return { count: 0 } },
      },
      apiLog: {
        async deleteMany(input) { deleteCalls.push(['ApiLog', input]); return { count: 0 } },
      },
    }
    const typescript = require(path.join(root, 'gravity-mvp/node_modules/typescript/lib/typescript.js'))
    const adapterSource = readFileSync(
      path.join(root, 'gravity-mvp/src/modules/fleet-operations/public/v1/legacy-prisma-event-retention-adapter.ts'),
      'utf8',
    )
    const output = typescript.transpileModule(adapterSource, {
      compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2022 },
    }).outputText
    const module = { exports: {} }
    vm.runInNewContext(output, {
      module,
      exports: module.exports,
      require(specifier) {
        if (specifier === '@/lib/prisma') return { prisma }
        throw new Error(`unexpected adapter import: ${specifier}`)
      },
    })
    const adapter = module.exports.legacyPrismaFleetEventRetentionPortV1
    const driverResult = await adapter.runDriverEventRetention({ dryRun: false })
    const dryApiResult = await adapter.runApiLogRetention({ dryRun: true })
    const emptyApiResult = await adapter.runApiLogRetention({ dryRun: false })

    assert.deepEqual(queryCalls.map(([model]) => model), ['DriverEvent', 'ApiLog', 'ApiLog'])
    assert.match(queryCalls[0][1], /NOW\(\) AT TIME ZONE 'UTC'.*INTERVAL '180 days'/s)
    assert.match(queryCalls[1][1], /NOW\(\) AT TIME ZONE 'UTC'.*INTERVAL '30 days'/s)
    assert.deepEqual(deleteCalls.map(([model]) => model), ['DriverEvent'])
    assert.deepEqual(Array.from(deleteCalls[0][1].where.id.in), ['driver-2', 'driver-1'])
    assert.equal(driverResult.selectedCount, 2)
    assert.equal(dryApiResult.selectedCount, 1)
    assert.equal(emptyApiResult.selectedCount, 0)
  })
} finally {
  rmSync(out, { recursive: true, force: true })
}

process.stdout.write(`${JSON.stringify({ status: 'PASS', passed: checks.length, checks }, null, 2)}\n`)
