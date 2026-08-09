#!/usr/bin/env node
import fs from 'node:fs'

const read = (file) => fs.readFileSync(file, 'utf8')
const checks = []
const failures = []
const check = (name, value, detail) => value ? checks.push(name) : failures.push({ check: name, detail })
const contract = read('gravity-mvp/src/contracts/fleet-operations/v1/record-driver-daily-activity-command.ts')
const handler = read('gravity-mvp/src/modules/fleet-operations/public/v1/record-driver-daily-activity-handler.ts')
const adapter = read('gravity-mvp/src/modules/fleet-operations/public/v1/legacy-prisma-driver-daily-activity-adapter.ts')
const consumer = read('gravity-mvp/src/lib/communications.ts')
const amendment = JSON.parse(read('architecture/isolation/fleet-operations/daily-activity-v1/module-manifest-amendments.json'))
const registry = JSON.parse(read('architecture/enforcement/v1/exceptions.json'))

check('contract is provider neutral', !/(prisma|next\/|@\/lib)/i.test(contract), 'implementation leaked into contract')
check('handler is provider neutral', !/(prisma|next\/|@\/lib)/i.test(handler), 'implementation leaked into handler')
check('write is isolated in Fleet adapter', adapter.includes('prisma.driverDaySummary.upsert') && !/prisma\.driverDaySummary\.upsert/.test(consumer), 'foreign write remains')
check('activity mapping exact', ['manager_message: \'hadManagerMessage\'', 'manager_call: \'hadManagerCall\'', 'auto_message: \'hadAutoMessage\'', 'goal_achieved: \'hadGoalAchieved\''].every((value) => adapter.includes(value)), 'activity mapping drifted')
check('Messaging invokes public v1', consumer.includes('RECORD_DRIVER_DAILY_ACTIVITY_COMMAND_V1') && consumer.includes('recordDriverDailyActivityV1({'), 'public command absent')
check('event persists before summary', consumer.indexOf('await prisma.communicationEvent.create') < consumer.indexOf('await recordDriverDailyActivityV1'), 'operation order drifted')
check('local day boundary retained', consumer.includes('today.setHours(0, 0, 0, 0)') && consumer.includes('dayStart: today.toISOString()'), 'day boundary drifted')
check('activity classifications retained', ['eventType === \'message\' && direction === \'outbound\'', "channel === 'auto'", "eventType === 'call'", "eventType === 'auto_message'", "eventType === 'goal_achieved'"].every((value) => consumer.includes(value)), 'classification drifted')
check('unmatched events skip summary', consumer.includes('if (dailyActivity) {'), 'no-op guard drifted')
check('command amendment exact', amendment.amendments.some((item) => item.context === 'fleet_operations' && item.add_commands?.includes('RecordDriverDailyActivityCommand.v1')), 'command amendment drifted')
check('dependency amendment exact', amendment.amendments.some((item) => item.context === 'messaging' && item.add_allowed_dependencies?.some((dependency) => dependency.context === 'fleet_operations' && dependency.surface === 'fleet_operations.public')), 'dependency amendment drifted')
check('legacy Inbox non-public debt remains explicit', registry.exceptions.filter((item) => item.file === 'gravity-mvp/src/app/inbox/InboxClient.tsx' && item.target_context === 'fleet_operations' && ['internal_module_import', 'non_public_cross_context_import'].includes(item.rule)).length === 4, 'dependency edge masked non-public imports')

process.stdout.write(`${JSON.stringify({ status: failures.length ? 'FAIL' : 'PASS', checks, failures }, null, 2)}\n`)
if (failures.length) process.exitCode = 1
