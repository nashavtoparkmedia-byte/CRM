#!/usr/bin/env node
import fs from 'node:fs'

const read = file => fs.readFileSync(file, 'utf8')
const checks = []
const failures = []
const check = (name, value, detail) => value
  ? checks.push(name)
  : failures.push({ check: name, detail })

const fleetContract = read('gravity-mvp/src/contracts/fleet-operations/v1/event-retention-commands.ts')
const fleetHandler = read('gravity-mvp/src/modules/fleet-operations/public/v1/event-retention-handler.ts')
const fleetAdapter = read('gravity-mvp/src/modules/fleet-operations/public/v1/legacy-prisma-event-retention-adapter.ts')
const communicationContract = read('gravity-mvp/src/contracts/fleet-operations/v1/communication-event-retention-command.ts')
const communicationHandler = read('gravity-mvp/src/modules/fleet-operations/public/v1/communication-event-retention-handler.ts')
const communicationAdapter = read('gravity-mvp/src/modules/fleet-operations/public/v1/legacy-prisma-communication-event-retention-adapter.ts')
const consumer = read('gravity-mvp/src/lib/RetentionCleanup.ts')
const amendmentPath = 'architecture/isolation/operations-observability/event-retention-v1/module-manifest-amendments.json'
const amendment = JSON.parse(read(amendmentPath))
const migration = JSON.parse(read('architecture/isolation/operations-observability/event-retention-v1/migration-manifest.json'))
const policy = JSON.parse(read('architecture/enforcement/v1/policy.json'))
const registry = JSON.parse(read('architecture/enforcement/v1/exceptions.json'))
const contracts = fleetContract + communicationContract
const handlers = fleetHandler + communicationHandler
const adapters = fleetAdapter + communicationAdapter
const sliceBetween = (source, startMarker, endMarker) => {
  const start = source.indexOf(startMarker)
  if (start < 0) return ''
  const end = endMarker === null ? source.length : source.indexOf(endMarker, start + startMarker.length)
  return end < 0 ? '' : source.slice(start, end)
}
const driverHandlerBody = sliceBetween(
  fleetHandler,
  'return async function runDriverEventRetentionV1',
  'export function createRunApiLogRetentionHandlerV1',
)
const apiLogHandlerBody = sliceBetween(
  fleetHandler,
  'return async function runApiLogRetentionV1',
  null,
)
const communicationHandlerBody = sliceBetween(
  communicationHandler,
  'return async function runCommunicationEventRetentionV1',
  null,
)
const handlerBodies = driverHandlerBody + apiLogHandlerBody + communicationHandlerBody
const driverPhase = sliceBetween(consumer, '// 4. Old DriverEvent', '// 5. Old CommunicationEvent')
const communicationPhase = sliceBetween(consumer, '// 5. Old CommunicationEvent', '// 6. Old ApiLog')
const apiLogPhase = sliceBetween(consumer, '// 6. Old ApiLog', '// 7. Archived contacts')
const phaseHasExactTimeoutCall = (phase, commandCall, countProjection) => {
  const timeout = phase.indexOf('if (!checkTimeout())')
  const command = phase.indexOf(commandCall)
  const projection = phase.indexOf(countProjection)
  return timeout >= 0 &&
    command > timeout &&
    projection > command &&
    (phase.match(/if \(!checkTimeout\(\)\)/g) || []).length === 1 &&
    (phase.match(/\bawait\b/g) || []).length === 1 &&
    !/\b(?:try|catch)\b/.test(phase)
}
const parsesBeforePort = (body, parseCall, portCall) => {
  const parse = body.indexOf(parseCall)
  const port = body.indexOf(portCall)
  return parse >= 0 &&
    port > parse &&
    (body.match(new RegExp(parseCall, 'g')) || []).length === 1 &&
    (body.match(new RegExp(portCall.replace('.', '\\.'), 'g')) || []).length === 1
}

check(
  'contracts infrastructure neutral',
  !/(prisma|next\/|@\/lib|@\/app)/i.test(contracts),
  'contract leaks infrastructure',
)
check(
  'handlers infrastructure neutral',
  !/(prisma|next\/|@\/lib|@\/app)/i.test(handlers),
  'handler leaks infrastructure',
)
check(
  'public policy fixed',
  !/(tableName|ageDays|limit|predicate|sql)/.test(contracts) &&
    (contracts.match(/^  dryRun: boolean$/gm) || []).length === 3,
  'public contract exposes a policy or lacks exact dryRun commands',
)
check(
  'contract versions exact',
  fleetContract.includes('fleet_operations.RunDriverEventRetentionCommand.v1') &&
    fleetContract.includes('fleet_operations.RunApiLogRetentionCommand.v1') &&
    communicationContract.includes('fleet_operations.RunCommunicationEventRetentionCommand.v1'),
  'contract identifier drift',
)
check(
  'strict parser fields exact',
  (contracts.match(/!\['contract', 'dryRun'\]\.includes\(key\)/g) || []).length === 2 &&
    (contracts.match(/typeof input\.dryRun !== 'boolean'/g) || []).length === 2,
  'contract field or type validation drift',
)
check(
  'named ports exact',
  fleetHandler.includes('runDriverEventRetention(input: { dryRun: boolean })') &&
    fleetHandler.includes('runApiLogRetention(input: { dryRun: boolean })') &&
    communicationHandler.includes('runCommunicationEventRetention(input: { dryRun: boolean })'),
  'owner port mapping drift',
)
check(
  'handler bodies parse before exact port call',
  parsesBeforePort(
    driverHandlerBody,
    'parseRunDriverEventRetentionCommandV1',
    'port.runDriverEventRetention',
  ) &&
    parsesBeforePort(
      apiLogHandlerBody,
      'parseRunApiLogRetentionCommandV1',
      'port.runApiLogRetention',
    ) &&
    parsesBeforePort(
      communicationHandlerBody,
      'parseRunCommunicationEventRetentionCommandV1',
      'port.runCommunicationEventRetention',
    ),
  'a concrete handler body does not parse exactly once before its exact port call',
)
check(
  'owner failures remain visible without generic helper',
  !/\bcatch\b/.test(handlerBodies + adapters) &&
    !/(?:_?cleanupTable|tableName|ageDays|policyArgs|retentionPolicy)/.test(contracts + handlers + adapters),
  'owner path catches a failure or exposes a generic policy helper',
)
check(
  'read-only raw selection and typed owner deletion only',
  !/\$(?:query|execute)RawUnsafe/.test(adapters + consumer) &&
    (adapters.match(/prisma\.\$queryRaw</g) || []).length === 3 &&
    !/prisma\.\$executeRaw/.test(adapters) &&
    (adapters.match(/\.deleteMany\(/g) || []).length === 3,
  'unsafe/raw deletion remains or read/delete call count drifted',
)
check(
  'DriverEvent policy exact',
  fleetAdapter.includes('SELECT id FROM "DriverEvent"') &&
    fleetAdapter.includes("INTERVAL '180 days'") &&
    fleetAdapter.includes('prisma.driverEvent.deleteMany({ where: { id: { in: ids } } })'),
  'DriverEvent policy drift',
)
check(
  'ApiLog policy exact',
  fleetAdapter.includes('SELECT id FROM "ApiLog"') &&
    fleetAdapter.includes("INTERVAL '30 days'") &&
    fleetAdapter.includes('prisma.apiLog.deleteMany({ where: { id: { in: ids } } })'),
  'ApiLog policy drift',
)
check(
  'CommunicationEvent policy exact',
  communicationAdapter.includes('SELECT id FROM "CommunicationEvent"') &&
    communicationAdapter.includes("INTERVAL '180 days'") &&
    communicationAdapter.includes('prisma.communicationEvent.deleteMany({ where: { id: { in: ids } } })'),
  'CommunicationEvent policy drift',
)
check(
  'UTC cutoff oldest-first and bound exact',
  (adapters.match(/NOW\(\) AT TIME ZONE 'UTC'/g) || []).length === 3 &&
    (adapters.match(/ORDER BY "createdAt" ASC/g) || []).length === 3 &&
    (adapters.match(/LIMIT 100/g) || []).length === 3,
  'selection semantics drift',
)
check(
  'dry-run and empty guards exact',
  (adapters.match(/if \(dryRun \|\| rows\.length === 0\) return \{ selectedCount: rows\.length \}/g) || []).length === 3,
  'dry-run/empty behavior drift',
)
check(
  'selected count projection exact',
  (adapters.match(/return \{ selectedCount: ids\.length \}/g) || []).length === 3 &&
    (handlers.match(/selectedCount: result\.selectedCount/g) || []).length === 3,
  'selected count behavior drift',
)
check(
  'generic cleanup removed',
  !consumer.includes('_cleanupTable') &&
    !consumer.includes('$queryRawUnsafe') &&
    !consumer.includes('$executeRawUnsafe'),
  'generic retention helper remains',
)
check(
  'consumer commands complete',
  (consumer.match(/await runDriverEventRetentionV1/g) || []).length === 1 &&
    (consumer.match(/await runCommunicationEventRetentionV1/g) || []).length === 1 &&
    (consumer.match(/await runApiLogRetentionV1/g) || []).length === 1,
  'owner command call count drift',
)
check(
  'consumer count accumulation exact',
  consumer.includes('result.deletedEvents += driverEvents.selectedCount') &&
    consumer.includes('result.deletedEvents += communicationEvents.selectedCount') &&
    consumer.includes('result.deletedEvents += apiLogs.selectedCount'),
  'caller count accumulation drift',
)
check(
  'each event phase retains exact timeout call and count order',
  phaseHasExactTimeoutCall(
    driverPhase,
    'await runDriverEventRetentionV1',
    'result.deletedEvents += driverEvents.selectedCount',
  ) &&
    phaseHasExactTimeoutCall(
      communicationPhase,
      'await runCommunicationEventRetentionV1',
      'result.deletedEvents += communicationEvents.selectedCount',
    ) &&
    phaseHasExactTimeoutCall(
      apiLogPhase,
      'await runApiLogRetentionV1',
      'result.deletedEvents += apiLogs.selectedCount',
    ),
  'an event phase lost its direct timeout guard, single awaited command, count projection, or acquired a catch',
)
check(
  'event phase sequence remains DriverEvent CommunicationEvent ApiLog contacts',
  driverPhase.length > 0 &&
    communicationPhase.length > 0 &&
    apiLogPhase.length > 0 &&
    consumer.indexOf('// 4. Old DriverEvent') < consumer.indexOf('// 5. Old CommunicationEvent') &&
    consumer.indexOf('// 5. Old CommunicationEvent') < consumer.indexOf('// 6. Old ApiLog') &&
    consumer.indexOf('// 6. Old ApiLog') < consumer.indexOf('// 7. Archived contacts'),
  'sequential event phase order drift',
)
check(
  'outer error policy retained',
  consumer.includes("opsLog('error', 'retention_cleanup_error', { error: err.message, dryRun })"),
  'runAll error policy drift',
)
check(
  'owner manifest commands exact',
  amendment.amendments?.length === 1 &&
    amendment.amendments[0].context === 'fleet_operations' &&
    JSON.stringify(amendment.amendments[0].add_commands) === JSON.stringify([
      'RunDriverEventRetentionCommand.v1',
      'RunApiLogRetentionCommand.v1',
      'RunCommunicationEventRetentionCommand.v1',
    ]),
  'owner manifest command amendment drift',
)
check(
  'accepted event-retention evidence stays bound to the AI parent',
  policy.manifest_amendments.includes(amendmentPath) &&
    migration.base_commit === '2ff1a6ff7a0605f11bdd8e9e6157c93dd1415056' &&
    migration.enforcement?.before === 1430 &&
    migration.enforcement?.after === 1429 &&
    migration.enforcement?.direct_before === 100 &&
    migration.enforcement?.direct_after === 99,
  'accepted event-retention evidence identity drift',
)
check(
  'exact generic dynamic write remains retired with no replacement capacity',
  (registry.summary?.direct_foreign_prisma_write ?? 0) <= 99 &&
    registry.exceptions.length <= 1429 &&
    !registry.exceptions.some((entry) => entry.fingerprint === 'arch_d6b0723094e2555809f66a51') &&
    !registry.exceptions.some((entry) => [
      'gravity-mvp/src/modules/fleet-operations/public/v1/legacy-prisma-event-retention-adapter.ts',
      'gravity-mvp/src/modules/fleet-operations/public/v1/legacy-prisma-communication-event-retention-adapter.ts',
    ].includes(entry.file)),
  'strict exception retirement or owner-local classification drift',
)

process.stdout.write(`${JSON.stringify({
  status: failures.length > 0 ? 'FAIL' : 'PASS',
  checks,
  failures,
}, null, 2)}\n`)
if (failures.length > 0) process.exitCode = 1
