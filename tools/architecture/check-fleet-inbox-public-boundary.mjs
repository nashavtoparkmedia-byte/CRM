#!/usr/bin/env node
import fs from 'node:fs'
import crypto from 'node:crypto'

const read = (file) => fs.readFileSync(file, 'utf8')
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const checks = []
const failures = []
const check = (name, value, detail) => value ? checks.push(name) : failures.push({ check: name, detail })
const contract = read('gravity-mvp/src/contracts/fleet-operations/v1/log-manager-call-command.ts')
const handler = read('gravity-mvp/src/modules/fleet-operations/public/v1/log-manager-call-handler.ts')
const actionPath = 'gravity-mvp/src/modules/fleet-operations/public/v1/log-manager-call-action.ts'
const action = fs.existsSync(actionPath) ? read(actionPath) : null
const badge = read('gravity-mvp/src/modules/fleet-operations/public/v1/segment-badge.tsx')
const oldBadge = read('gravity-mvp/src/app/drivers/components/SegmentBadge.tsx')
const consumer = read('gravity-mvp/src/app/inbox/InboxClient.tsx')
const riskConsumer = read('gravity-mvp/src/app/dashboard/components/RiskDriversTable.tsx')
const legacyActions = read('gravity-mvp/src/app/drivers/actions.ts')
const successorRoutePath = 'gravity-mvp/src/app/api/platform/drivers/[id]/manager-communication/route.ts'
const successorRoute = fs.existsSync(successorRoutePath) ? read(successorRoutePath) : null
const registry = JSON.parse(read('architecture/enforcement/v1/exceptions.json'))
const amendment = JSON.parse(read('architecture/isolation/fleet-operations/inbox-public-v1/module-manifest-amendments.json'))
const legacyCompatibilityActive = action !== null
const platformSuccessorActive = action === null
    && successorRoute !== null
    && !legacyActions.includes('export async function logManagerCall(')
    && consumer.includes('/manager-communication`')
    && consumer.includes('recordManagerCommunication(task.driverId, "call")')
    && successorRoute.includes('recordManagerDriverCommunication(id, activity)')

check('contract is provider neutral', !/(prisma|next\/|@\/lib|@\/app)/i.test(contract), 'implementation leaked into contract')
check('handler is implementation neutral', !/(prisma|next\/|@\/lib|@\/app)/i.test(handler), 'implementation leaked into handler')
check('call delivery uses historical facade or explicit Platform successor', (
    legacyCompatibilityActive
        ? action.startsWith("'use server'") && action.includes('legacyLogManagerCall') && action.includes('createLogManagerCallHandlerV1')
        : platformSuccessorActive
), 'neither historical compatibility facade nor Platform successor is valid')
check('legacy call stays frozen while active or is fully retired by successor', (
    legacyCompatibilityActive
        ? sha('gravity-mvp/src/app/drivers/actions.ts') === 'ebcf7d309cf4c468a173b41974189c81dd085a0760cb15d113d3757f16690512'
        : platformSuccessorActive
), 'legacy behavior drifted without a valid successor')
check('Inbox uses historical command or Platform successor', (
    legacyCompatibilityActive
        ? consumer.includes('LOG_MANAGER_CALL_COMMAND_V1') && consumer.includes('logManagerCallV1({')
        : platformSuccessorActive
), 'Inbox call delivery is absent')
check('Inbox call completion order retained', (
    legacyCompatibilityActive
        ? consumer.indexOf('await logManagerCallV1') < consumer.indexOf('setCallLogged(true)')
        : consumer.indexOf('await recordManagerCommunication') < consumer.indexOf('setCallLogged(true)')
), 'UI order drifted')
check('Inbox uses public badge', consumer.includes('@/modules/fleet-operations/public/v1/segment-badge') && !consumer.includes('../drivers/'), 'internal Fleet import remains')
check('Analytics risk view uses public badge', riskConsumer.includes('@/modules/fleet-operations/public/v1/segment-badge') && !riskConsumer.includes('@/app/drivers/components/SegmentBadge'), 'Analytics internal Fleet import remains')
check('badge behavior retained', ['Прибыльный', 'Средний', 'Малый', 'Спящий', '—', 'SEGMENT_CONFIG[segment] || SEGMENT_CONFIG.unknown'].every((value) => badge.includes(value)), 'badge behavior drifted')
check('badge exposes one exact component', [...badge.matchAll(/export\s+function\s+(\w+)/g)].map((match) => match[1]).join(',') === 'SegmentBadge', 'badge surface widened')
check('legacy badge delegates to canonical public component', oldBadge.includes("export { SegmentBadge } from '@/modules/fleet-operations/public/v1/segment-badge'"), 'legacy component diverges')
check('exact command amendment', amendment.amendments[0].context === 'fleet_operations' && amendment.amendments[0].add_commands?.length === 1 && amendment.amendments[0].add_commands[0] === 'LogManagerCallCommand.v1', 'command amendment drifted')
check('all Inbox Fleet import exceptions retired', registry.exceptions.every((item) => !(item.file === 'gravity-mvp/src/app/inbox/InboxClient.tsx' && item.target_context === 'fleet_operations')), 'Inbox Fleet exception remains')
check('all Analytics badge exceptions retired', registry.exceptions.every((item) => !(item.file === 'gravity-mvp/src/app/dashboard/components/RiskDriversTable.tsx' && item.target_context === 'fleet_operations')), 'Analytics Fleet badge exception remains')

process.stdout.write(`${JSON.stringify({ status: failures.length ? 'FAIL' : 'PASS', checks, failures }, null, 2)}\n`)
if (failures.length) process.exitCode = 1
