#!/usr/bin/env node
import fs from 'node:fs'

const read = (file) => fs.readFileSync(file, 'utf8')
const checks = []
const failures = []
const check = (name, value, detail) => value ? checks.push(name) : failures.push({ check: name, detail })
const contract = read('gravity-mvp/src/contracts/fleet-operations/v1/clear-fleet-check-status-command.ts')
const handler = read('gravity-mvp/src/modules/fleet-operations/public/v1/clear-fleet-check-status-handler.ts')
const adapter = read('gravity-mvp/src/modules/fleet-operations/public/v1/legacy-prisma-clear-fleet-check-status-adapter.ts')
const consumer = read('gravity-mvp/src/scripts/force-clear-locks.ts')
const platform = JSON.parse(read('architecture/contexts/v1/manifests/platform_shell.json'))
const amendment = JSON.parse(read('architecture/isolation/fleet-operations/clear-check-status-v1/module-manifest-amendments.json'))

check('contract is provider neutral', !/(prisma|next\/|@\/lib|@\/app)/i.test(contract), 'implementation leaked into contract')
check('handler is implementation neutral', !/(prisma|next\/|@\/lib|@\/app)/i.test(handler), 'implementation leaked into handler')
check('write is isolated in Fleet adapter', adapter.includes('prisma.driver.updateMany') && !/prisma\.driver\.updateMany/.test(consumer), 'foreign write remains')
check('all-driver field clear retained', adapter.includes('data: { lastFleetCheckStatus: null }'), 'clear mapping drifted')
check('standalone client lifecycle retained', adapter.includes('new PrismaClient()') && adapter.indexOf("console.log(`Successfully cleared") < adapter.indexOf('await prisma.$disconnect()') && adapter.includes('finally'), 'client lifecycle drifted')
check('start log retained in script', consumer.includes("console.log('Force clearing all CRM driver lock statuses...')"), 'start log drifted')
check('success log retained in owner compatibility adapter', adapter.includes('`Successfully cleared ${result.count} locks!`'), 'success log drifted')
check('script invokes ClearFleetCheckStatus v1', consumer.includes('CLEAR_FLEET_CHECK_STATUS_COMMAND_V1') && consumer.includes('CLEAR_ALL_DRIVER_FLEET_CHECK_STATUSES_V1') && consumer.includes('clearFleetCheckStatusV1({'), 'owner command absent')
check('CLI failure visibility retained', consumer.includes('.catch(console.error)'), 'CLI error boundary drifted')
check('command amendment exact', amendment.amendments.length === 1 && amendment.amendments[0].context === 'fleet_operations' && amendment.amendments[0].add_commands?.length === 1 && amendment.amendments[0].add_commands[0] === 'ClearFleetCheckStatusCommand.v1', 'command amendment drifted')
check('Platform Fleet dependency pre-approved', platform.allowed_dependencies.some((item) => item.context === 'fleet_operations' && item.surface === 'fleet_operations.public'), 'approved dependency absent')
check('script no longer owns Prisma lifecycle', !consumer.includes('PrismaClient') && !consumer.includes('$disconnect'), 'Prisma lifecycle remains in caller')

process.stdout.write(`${JSON.stringify({ status: failures.length ? 'FAIL' : 'PASS', checks, failures }, null, 2)}\n`)
if (failures.length) process.exitCode = 1
