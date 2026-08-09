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
const action = read('gravity-mvp/src/modules/fleet-operations/public/v1/log-manager-call-action.ts')
const badge = read('gravity-mvp/src/modules/fleet-operations/public/v1/segment-badge.tsx')
const oldBadge = read('gravity-mvp/src/app/drivers/components/SegmentBadge.tsx')
const consumer = read('gravity-mvp/src/app/inbox/InboxClient.tsx')
const registry = JSON.parse(read('architecture/enforcement/v1/exceptions.json'))
const amendment = JSON.parse(read('architecture/isolation/fleet-operations/inbox-public-v1/module-manifest-amendments.json'))

check('contract is provider neutral', !/(prisma|next\/|@\/lib|@\/app)/i.test(contract), 'implementation leaked into contract')
check('handler is implementation neutral', !/(prisma|next\/|@\/lib|@\/app)/i.test(handler), 'implementation leaked into handler')
check('server compatibility action explicit', action.startsWith("'use server'") && action.includes('legacyLogManagerCall') && action.includes('createLogManagerCallHandlerV1'), 'compatibility action drifted')
check('legacy call implementation byte-identical', sha('gravity-mvp/src/app/drivers/actions.ts') === 'ebcf7d309cf4c468a173b41974189c81dd085a0760cb15d113d3757f16690512', 'legacy action changed')
check('Inbox uses versioned public call action', consumer.includes('LOG_MANAGER_CALL_COMMAND_V1') && consumer.includes('logManagerCallV1({'), 'versioned call absent')
check('Inbox call completion order retained', consumer.indexOf('await logManagerCallV1') < consumer.indexOf('setCallLogged(true)'), 'UI order drifted')
check('Inbox uses public badge', consumer.includes('@/modules/fleet-operations/public/v1/segment-badge') && !consumer.includes('../drivers/'), 'internal Fleet import remains')
check('badge behavior retained', ['Прибыльный', 'Средний', 'Малый', 'Спящий', '—', 'SEGMENT_CONFIG[segment] || SEGMENT_CONFIG.unknown'].every((value) => badge.includes(value)), 'badge behavior drifted')
check('legacy badge delegates to canonical public component', oldBadge.includes("export { SegmentBadge } from '@/modules/fleet-operations/public/v1/segment-badge'"), 'legacy component diverges')
check('exact command amendment', amendment.amendments[0].context === 'fleet_operations' && amendment.amendments[0].add_commands?.length === 1 && amendment.amendments[0].add_commands[0] === 'LogManagerCallCommand.v1', 'command amendment drifted')
check('all Inbox Fleet import exceptions retired', registry.exceptions.every((item) => !(item.file === 'gravity-mvp/src/app/inbox/InboxClient.tsx' && item.target_context === 'fleet_operations')), 'Inbox Fleet exception remains')

process.stdout.write(`${JSON.stringify({ status: failures.length ? 'FAIL' : 'PASS', checks, failures }, null, 2)}\n`)
if (failures.length) process.exitCode = 1
