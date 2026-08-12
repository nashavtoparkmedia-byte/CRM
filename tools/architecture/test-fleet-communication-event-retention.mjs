#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import vm from 'node:vm'

const root = process.cwd()
const out = mkdtempSync(path.join(tmpdir(), 'yoko-fleet-communication-event-retention-'))
const sources = [
  'gravity-mvp/src/contracts/fleet-operations/v1/communication-event-retention-command.ts',
  'gravity-mvp/src/contracts/fleet-operations/v1/index.ts',
  'gravity-mvp/src/modules/fleet-operations/public/v1/communication-event-retention-handler.ts',
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
const { createRunCommunicationEventRetentionHandlerV1 } = require(
  path.join(out, 'modules/fleet-operations/public/v1/communication-event-retention-handler.js'),
)
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
  const command = {
    contract: contracts.RUN_COMMUNICATION_EVENT_RETENTION_COMMAND_V1,
    dryRun: true,
  }

  check('identifier explicit', () => {
    assert.equal(
      contracts.RUN_COMMUNICATION_EVENT_RETENTION_COMMAND_V1,
      'fleet_operations.RunCommunicationEventRetentionCommand.v1',
    )
    assert.equal(
      contracts.RUN_COMMUNICATION_EVENT_RETENTION_RESULT_V1,
      'fleet_operations.RunCommunicationEventRetentionResult.v1',
    )
  })
  check('command parses exactly', () => {
    assert.deepEqual(contracts.parseRunCommunicationEventRetentionCommandV1(command), command)
  })
  check('v2 rejected', () => {
    assert.throws(
      () => contracts.parseRunCommunicationEventRetentionCommandV1({
        ...command,
        contract: 'fleet_operations.RunCommunicationEventRetentionCommand.v2',
      }),
      error => error.code === 'UNSUPPORTED_CONTRACT_VERSION',
    )
  })
  check('policy fields rejected', () => {
    const forbidden = {
      tableName: 'CommunicationEvent',
      ageDays: 180,
      limit: 100,
      predicate: 'createdAt',
      sql: 'DELETE',
    }
    for (const [field, value] of Object.entries(forbidden)) {
      assert.throws(() => contracts.parseRunCommunicationEventRetentionCommandV1({
        ...command,
        [field]: value,
      }))
    }
  })
  check('dryRun type required', () => {
    assert.throws(() => contracts.parseRunCommunicationEventRetentionCommandV1({
      contract: command.contract,
    }))
    assert.throws(() => contracts.parseRunCommunicationEventRetentionCommandV1({
      ...command,
      dryRun: 1,
    }))
  })

  const calls = []
  const port = {
    async runCommunicationEventRetention(input) {
      calls.push(input)
      return { selectedCount: 5 }
    },
  }
  const result = await createRunCommunicationEventRetentionHandlerV1(port)(command)

  check('exact owner mapping', () => assert.deepEqual(calls, [{ dryRun: true }]))
  check('result explicit', () => {
    assert.deepEqual(result, {
      contract: contracts.RUN_COMMUNICATION_EVENT_RETENTION_RESULT_V1,
      selectedCount: 5,
    })
  })
  await checkAsync('invalid never persists', async () => {
    const before = calls.length
    await assert.rejects(createRunCommunicationEventRetentionHandlerV1(port)({
      contract: command.contract,
    }))
    assert.equal(calls.length, before)
  })
  await checkAsync('owner failures visible', async () => {
    const failingPort = {
      async runCommunicationEventRetention() { throw new Error('communication retention down') },
    }
    await assert.rejects(
      createRunCommunicationEventRetentionHandlerV1(failingPort)(command),
      /communication retention down/,
    )
  })
  await checkAsync('typed Fleet adapter preserves DB-clock selection and exact selected-id deletion', async () => {
    const queryCalls = []
    const deleteCalls = []
    const selections = [[{ id: 'communication-2' }, { id: 'communication-1' }], []]
    const prisma = {
      async $queryRaw(strings) {
        const sql = strings.join('')
        queryCalls.push(sql)
        return selections.shift()
      },
      communicationEvent: {
        async deleteMany(input) { deleteCalls.push(input); return { count: 0 } },
      },
    }
    const typescript = require(path.join(root, 'gravity-mvp/node_modules/typescript/lib/typescript.js'))
    const adapterSource = readFileSync(
      path.join(root, 'gravity-mvp/src/modules/fleet-operations/public/v1/legacy-prisma-communication-event-retention-adapter.ts'),
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
    const adapter = module.exports.legacyPrismaCommunicationEventRetentionPortV1
    const result = await adapter.runCommunicationEventRetention({ dryRun: false })
    const emptyResult = await adapter.runCommunicationEventRetention({ dryRun: false })

    assert.equal(queryCalls.length, 2)
    assert.match(queryCalls[0], /NOW\(\) AT TIME ZONE 'UTC'.*INTERVAL '180 days'/s)
    assert.equal(deleteCalls.length, 1)
    assert.deepEqual(Array.from(deleteCalls[0].where.id.in), ['communication-2', 'communication-1'])
    assert.equal(result.selectedCount, 2)
    assert.equal(emptyResult.selectedCount, 0)
  })
} finally {
  rmSync(out, { recursive: true, force: true })
}

process.stdout.write(`${JSON.stringify({ status: 'PASS', passed: checks.length, checks }, null, 2)}\n`)
