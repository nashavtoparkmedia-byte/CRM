#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'

const root = process.cwd()
const paths = {
  contract: 'gravity-mvp/src/contracts/fleet-operations/v1/record-manager-driver-communication-command.ts',
  contractIndex: 'gravity-mvp/src/contracts/fleet-operations/v1/index.ts',
  handler: 'gravity-mvp/src/modules/fleet-operations/public/v1/record-manager-driver-communication-handler.ts',
  adapter: 'gravity-mvp/src/modules/fleet-operations/public/v1/legacy-prisma-record-manager-driver-communication-adapter.ts',
  publicIndex: 'gravity-mvp/src/modules/fleet-operations/public/v1/index.ts',
  orchestrator: 'gravity-mvp/src/modules/platform-shell/internal/manager-driver-communication-orchestrator.ts',
  route: 'gravity-mvp/src/app/api/platform/drivers/[id]/manager-communication/route.ts',
  legacyActions: 'gravity-mvp/src/app/drivers/actions.ts',
  retiredFacade: 'gravity-mvp/src/modules/fleet-operations/public/v1/log-manager-call-action.ts',
  historicalContract: 'gravity-mvp/src/contracts/fleet-operations/v1/log-manager-call-command.ts',
  historicalHandler: 'gravity-mvp/src/modules/fleet-operations/public/v1/log-manager-call-handler.ts',
  consumers: [
    'gravity-mvp/src/app/drivers/components/DriverCard.tsx',
    'gravity-mvp/src/app/drivers/DriversClient.tsx',
    'gravity-mvp/src/app/dashboard/components/RiskDriversTable.tsx',
    'gravity-mvp/src/app/inbox/InboxClient.tsx',
  ],
}
const read = (relative) => readFileSync(path.join(root, relative), 'utf8')
const require = createRequire(import.meta.url)
const typescript = require(path.join(root, 'gravity-mvp/node_modules/typescript/lib/typescript.js'))
const checks = []
const check = (name, run) => { run(); checks.push(name) }
const checkAsync = async (name, run) => { await run(); checks.push(name) }
const plain = (value) => JSON.parse(JSON.stringify(value))

function transpile(relative) {
  return typescript.transpileModule(read(relative), {
    compilerOptions: {
      module: typescript.ModuleKind.CommonJS,
      target: typescript.ScriptTarget.ES2022,
    },
  }).outputText
}

function evaluate(relative, imports) {
  const module = { exports: {} }
  vm.runInNewContext(transpile(relative), {
    module,
    exports: module.exports,
    Date,
    Object,
    Set,
    Error,
    require(specifier) {
      if (Object.hasOwn(imports, specifier)) return imports[specifier]
      throw new Error(`unexpected import in ${relative}: ${specifier}`)
    },
  })
  return module.exports
}

const contracts = evaluate(paths.contract, {})
const handler = evaluate(paths.handler, {
  '../../../../contracts/fleet-operations/v1': contracts,
})

const command = {
  contract: contracts.RECORD_MANAGER_DRIVER_COMMUNICATION_COMMAND_V1,
  driverId: 'driver-1',
  activity: 'call',
}

check('exact Fleet history contract and closed parser', () => {
  assert.equal(
    contracts.RECORD_MANAGER_DRIVER_COMMUNICATION_COMMAND_V1,
    'fleet_operations.RecordManagerDriverCommunicationCommand.v1',
  )
  assert.equal(
    contracts.RECORD_MANAGER_DRIVER_COMMUNICATION_RESULT_V1,
    'fleet_operations.RecordManagerDriverCommunicationResult.v1',
  )
  assert.deepEqual(contracts.parseRecordManagerDriverCommunicationCommandV1(command), command)
  assert.deepEqual(
    contracts.parseRecordManagerDriverCommunicationCommandV1({ ...command, activity: 'message' }),
    { ...command, activity: 'message' },
  )
  assert.throws(() => contracts.parseRecordManagerDriverCommunicationCommandV1({ ...command, activity: 'email' }))
  assert.throws(() => contracts.parseRecordManagerDriverCommunicationCommandV1({ ...command, driverId: ' ' }))
  assert.throws(() => contracts.parseRecordManagerDriverCommunicationCommandV1({ ...command, sql: 'x' }))
  assert.throws(
    () => contracts.parseRecordManagerDriverCommunicationCommandV1({
      ...command,
      contract: 'fleet_operations.RecordManagerDriverCommunicationCommand.v2',
    }),
    (error) => error.code === 'UNSUPPORTED_CONTRACT_VERSION',
  )
  assert.match(read(paths.contractIndex), /export \* from '\.\/record-manager-driver-communication-command'/)
})

await checkAsync('owner handler validates and maps only exact persistence input', async () => {
  const calls = []
  const record = handler.createRecordManagerDriverCommunicationHandlerV1({
    async recordManagerDriverCommunication(input) { calls.push(input) },
  })
  assert.deepEqual(plain(await record(command)), {
    contract: contracts.RECORD_MANAGER_DRIVER_COMMUNICATION_RESULT_V1,
    logged: true,
  })
  assert.deepEqual(plain(calls), [{ driverId: 'driver-1', activity: 'call' }])
  await assert.rejects(record({ ...command, activity: 'email' }))
  assert.equal(calls.length, 1)
  const failing = handler.createRecordManagerDriverCommunicationHandlerV1({
    async recordManagerDriverCommunication() { throw new Error('persistence down') },
  })
  await assert.rejects(failing(command), /persistence down/)
})

await checkAsync('Fleet history adapter preserves exact call and message event rows', async () => {
  const calls = []
  const adapter = evaluate(paths.adapter, {
    '@/lib/prisma': {
      prisma: { communicationEvent: { async create(input) { calls.push(input) } } },
    },
  }).legacyPrismaRecordManagerDriverCommunicationPortV1
  await adapter.recordManagerDriverCommunication({ driverId: 'driver-1', activity: 'call' })
  await adapter.recordManagerDriverCommunication({ driverId: 'driver-2', activity: 'message' })
  assert.deepEqual(plain(calls), [
    { data: {
      driverId: 'driver-1', channel: 'phone', direction: 'outbound', eventType: 'call',
      content: 'Звонок менеджера', createdBy: 'manager',
    } },
    { data: {
      driverId: 'driver-2', channel: 'telegram', direction: 'outbound', eventType: 'message',
      content: 'Сообщение менеджера', createdBy: 'manager',
    } },
  ])
  const source = read(paths.adapter)
  assert.doesNotMatch(source, /driverDaySummary|\$transaction|Promise\.all|\bretry\b/)
})

await checkAsync('Platform composes exact Fleet summary then history capabilities and exposes no provider path', async () => {
  const ownerCalls = []
  const orchestratorModule = evaluate(paths.orchestrator, {
    '@/contracts/fleet-operations/v1': {
      RECORD_DRIVER_DAILY_ACTIVITY_COMMAND_V1: 'fleet_operations.RecordDriverDailyActivityCommand.v1',
      RECORD_MANAGER_DRIVER_COMMUNICATION_COMMAND_V1:
        contracts.RECORD_MANAGER_DRIVER_COMMUNICATION_COMMAND_V1,
    },
    '@/modules/fleet-operations/public/v1': {
      recordDriverDailyActivityV1() {},
      recordManagerDriverCommunicationV1() {},
    },
  })
  const fixedTime = new Date(2026, 7, 10, 13, 42, 17, 900).getTime()
  const orchestrate = orchestratorModule.createManagerDriverCommunicationOrchestratorV1({
    async recordDriverDailyActivityV1(input) { ownerCalls.push(['fleet_summary', input]) },
    async recordManagerDriverCommunicationV1(input) { ownerCalls.push(['fleet_history', input]) },
  }, { now: () => fixedTime })
  await orchestrate('driver-1', 'call')
  assert.deepEqual(ownerCalls.map(([owner]) => owner), ['fleet_summary', 'fleet_history'])
  assert.equal(ownerCalls[0][1].driverId, 'driver-1')
  assert.equal(ownerCalls[0][1].activity, 'manager_call')
  assert.equal(ownerCalls[0][1].dayStart, new Date(2026, 7, 10).toISOString())
  assert.deepEqual(plain(ownerCalls[1][1]), command)

  ownerCalls.length = 0
  await orchestrate('driver-2', 'message')
  assert.equal(ownerCalls[0][1].activity, 'manager_message')
  assert.equal(ownerCalls[1][1].activity, 'message')

  const source = read(paths.orchestrator)
  assert.doesNotMatch(source, /@\/lib\/prisma|\bprisma\.|\bfetch\s*\(|BOT_API_URL|Promise\.all|\$transaction|\bretry\b/)
  assert.doesNotMatch(source, /@\/contracts\/messaging|@\/modules\/messaging/)
  assert.ok(source.indexOf('recordDriverDailyActivityV1({') < source.indexOf('recordManagerDriverCommunicationV1({'))
  assert.match(read(paths.publicIndex), /recordManagerDriverCommunicationV1\s*=\s*createRecordManagerDriverCommunicationHandlerV1/)
})

check('Platform route is same-origin JSON-only with an exact closed body', () => {
  const route = read(paths.route)
  for (const expected of [
    'x-forwarded-host',
    'x-forwarded-proto',
    'forwardedHost.toLowerCase() !== host.toLowerCase()',
    'parsedOrigin.protocol === `${protocol}:`',
    'parsedOrigin.host.toLowerCase() === host.toLowerCase()',
    'application/json',
    'status: 403',
    'status: 415',
    'status: 400',
    "Object.keys(body).length !== 1",
    "body.activity === 'call' || body.activity === 'message'",
    'await recordManagerDriverCommunication(id, activity)',
    'NextResponse.json({ success: true })',
  ]) assert.ok(route.includes(expected), `route is missing ${expected}`)
  assert.doesNotMatch(route, /@\/lib\/prisma|\bprisma\.|BOT_API_URL|\bfetch\s*\(/)
  assert.ok(route.indexOf('await recordManagerDriverCommunication(id, activity)') > route.lastIndexOf('catch'))
})

check('all four live consumers use one hardened relative delivery helper', () => {
  for (const relative of paths.consumers) {
    const source = read(relative)
    assert.match(source, /`\/api\/platform\/drivers\/\$\{encodeURIComponent\(driverId\)\}\/manager-communication`/)
    assert.match(source, /method: "POST"/)
    assert.match(source, /"Content-Type": "application\/json"/)
    assert.match(source, /body: JSON\.stringify\(\{ activity \}\)/)
    assert.match(source, /if \(!response\.ok\) throw new Error/)
    assert.doesNotMatch(source, /logManagerCallV1|LOG_MANAGER_CALL_COMMAND_V1/)
    const helper = source.match(/async function recordManagerCommunication[\s\S]*?if \(!response\.ok\) throw new Error[^\n]*\n\}/)?.[0]
    assert.ok(helper, `delivery helper missing from ${relative}`)
    assert.doesNotMatch(helper, /sendTelegramMessage|sendMaxMessage|BOT_API_URL|provider/)
  }
})

check('five live invocations and UI completion order retain exact parity', () => {
  const [driverCard, driversClient, riskTable, inbox] = paths.consumers.map(read)
  const combined = [driverCard, driversClient, riskTable, inbox].join('\n')
  assert.equal((combined.match(/recordManagerCommunication\([^\n]+, "call"\)/g) || []).length, 4)
  assert.equal((combined.match(/recordManagerCommunication\([^\n]+, "message"\)/g) || []).length, 1)
  assert.ok(driverCard.indexOf('e.stopPropagation()') < driverCard.indexOf('await recordManagerCommunication'))
  assert.ok(driverCard.indexOf('await recordManagerCommunication') < driverCard.indexOf('setCallLogged(true)'))
  assert.ok(driversClient.indexOf('e.stopPropagation()') < driversClient.lastIndexOf('await recordManagerCommunication'))
  assert.ok(riskTable.indexOf('await recordManagerCommunication(driver.id, "call")') < riskTable.indexOf('setActionDone("call")'))
  assert.ok(riskTable.indexOf('await recordManagerCommunication(driver.id, "message")') < riskTable.indexOf('setActionDone("message")'))
  assert.ok(inbox.indexOf('await recordManagerCommunication') < inbox.indexOf('setCallLogged(true)'))
})

check('legacy runtime actions and facade retire while pure historical API remains', () => {
  const legacy = read(paths.legacyActions)
  assert.doesNotMatch(legacy, /export async function logManager(?:Call|Message)\s*\(/)
  assert.doesNotMatch(legacy, /communicationEvent\.create/)
  assert.equal(existsSync(path.join(root, paths.retiredFacade)), false)
  assert.match(read(paths.historicalContract), /LOG_MANAGER_CALL_COMMAND_V1/)
  assert.match(read(paths.historicalHandler), /createLogManagerCallHandlerV1/)
})

process.stdout.write(`${JSON.stringify({ status: 'PASS', passed: checks.length, checks }, null, 2)}\n`)
