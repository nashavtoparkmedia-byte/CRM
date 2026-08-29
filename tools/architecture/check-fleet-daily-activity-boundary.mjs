#!/usr/bin/env node
import fs from 'node:fs'

const read = (file) => fs.readFileSync(file, 'utf8')
const checks = []
const failures = []
const check = (name, value, detail) => value ? checks.push(name) : failures.push({ check: name, detail })
const contract = read('gravity-mvp/src/contracts/fleet-operations/v1/record-driver-daily-activity-command.ts')
const handler = read('gravity-mvp/src/modules/fleet-operations/public/v1/record-driver-daily-activity-handler.ts')
const adapter = read('gravity-mvp/src/modules/fleet-operations/public/v1/legacy-prisma-driver-daily-activity-adapter.ts')
const consumer = read('gravity-mvp/src/app/drivers/[id]/timeline-actions.ts')
const amendment = JSON.parse(read('architecture/isolation/fleet-operations/daily-activity-v1/module-manifest-amendments.json'))
const registry = JSON.parse(read('architecture/enforcement/v1/exceptions.json'))

check('contract is provider neutral', !/(prisma|next\/|@\/lib)/i.test(contract), 'implementation leaked into contract')
check('handler is provider neutral', !/(prisma|next\/|@\/lib)/i.test(handler), 'implementation leaked into handler')
check('write is isolated in Fleet adapter', adapter.includes('prisma.driverDaySummary.upsert') && !/prisma\.driverDaySummary\.upsert/.test(consumer), 'foreign write remains')
check('activity mapping exact', ['manager_message: \'hadManagerMessage\'', 'manager_call: \'hadManagerCall\'', 'auto_message: \'hadAutoMessage\'', 'goal_achieved: \'hadGoalAchieved\''].every((value) => adapter.includes(value)), 'activity mapping drifted')
check('Fleet consumer invokes public v1', consumer.includes('RECORD_DRIVER_DAILY_ACTIVITY_COMMAND_V1') && (consumer.match(/recordDriverDailyActivityV1\(\{/g) || []).length === 2, 'public command absent')
check('event persists before summary', (consumer.match(/recordDriverCommunicationEventV1\(\{/g) || []).length === 2 && consumer.indexOf('recordDriverCommunicationEventV1({') < consumer.indexOf('recordDriverDailyActivityV1({') && consumer.lastIndexOf('recordDriverCommunicationEventV1({') < consumer.lastIndexOf('recordDriverDailyActivityV1({'), 'operation order drifted')
check('local day boundary retained', consumer.includes('today.setHours(0, 0, 0, 0)') && (consumer.match(/dayStart,/g) || []).length === 2, 'day boundary drifted')
check('activity classifications retained', ["activity: 'manager_message'", "activity: 'manager_call'"].every((value) => consumer.includes(value)), 'classification drifted')
check('unrelated activity capacity absent from consumer', !/(auto_message|goal_achieved)/.test(consumer), 'unrelated daily activity leaked into consumer')
check('command amendment exact', amendment.amendments.some((item) => item.context === 'fleet_operations' && item.add_commands?.includes('RecordDriverDailyActivityCommand.v1')), 'command amendment drifted')
check('obsolete Messaging dependency retired', amendment.amendments.every((item) => item.context !== 'messaging'), 'obsolete Messaging dependency remains')
check('later Inbox debt retirement remains explicit', registry.exceptions.every((item) => !(item.file === 'gravity-mvp/src/app/inbox/InboxClient.tsx' && item.target_context === 'fleet_operations')), 'retired Inbox Fleet exception returned')

process.stdout.write(`${JSON.stringify({ status: failures.length ? 'FAIL' : 'PASS', checks, failures }, null, 2)}\n`)
if (failures.length) process.exitCode = 1
