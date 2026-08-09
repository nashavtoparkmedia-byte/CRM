#!/usr/bin/env node
import fs from 'node:fs'

const read = file => fs.readFileSync(file, 'utf8')
const checks = []
const failures = []
const check = (name, value, detail) => value ? checks.push(name) : failures.push({ check: name, detail })
const contract = read('gravity-mvp/src/contracts/fleet-operations/v1/driver-action-commands.ts')
const handler = read('gravity-mvp/src/modules/fleet-operations/public/v1/driver-action-handler.ts')
const adapter = read('gravity-mvp/src/modules/fleet-operations/public/v1/legacy-prisma-driver-action-adapter.ts')
const consumer = read('gravity-mvp/src/app/api/webhooks/bot/route.ts')
const platform = JSON.parse(read('architecture/contexts/v1/manifests/platform_shell.json'))
const amendment = JSON.parse(read('architecture/isolation/fleet-operations/driver-action-v1/module-manifest-amendments.json'))

check('contract is framework persistence and caller neutral', !/(prisma|next\/|@\/lib|@\/app|telegram|yandex|bot)/i.test(contract), 'contract leak')
check('handler is implementation neutral', !/(prisma|next\/|@\/lib|@\/app|telegram|yandex|bot)/i.test(handler), 'handler leak')
check('writes isolated in Fleet adapter', (adapter.match(/prisma\.driverAction\.(?:create|updateMany)/g) || []).length === 2 && !/prisma\.driverAction\.(?:create|updateMany)/.test(consumer), 'foreign DriverAction write remains')
check('dispatcher retains three action kinds', consumer.includes("handleDriverAction(payload, 'GET_PRICE')") && consumer.includes("handleDriverAction(payload, 'COMPLETE_ORDER')") && consumer.includes("handleDriverAction(payload, 'CANCEL_ORDER')"), 'dispatcher drift')
check('missing telegram guard retained', consumer.includes("if (!telegramId)") && consumer.includes("error: 'Missing telegramId'"), 'telegram guard drift')
check('driver resolution retained', consumer.indexOf('prisma.driverTelegram.findFirst') < consumer.indexOf('prisma.driver.findUnique') && consumer.includes('where: { yandexDriverId: mapping.driverId }'), 'driver resolution drift')
check('missing Yandex id best effort retained', consumer.includes("status: 'ESCALATED_TO_MANAGER'") && consumer.includes("errorMessage: 'driver has no yandexDriverId'") && consumer.indexOf('recordDriverActionV1({') < consumer.indexOf("error: 'NO_YANDEX_ID'"), 'escalation drift')
check('profile swap precedes scraper call', consumer.indexOf('profile swap detected') < consumer.indexOf('fetch(`${SCRAPER_URL}/api/driver-actions`'), 'swap guard order drift')
check('scraper request mapping retained', ['kind,', 'driverYandexId: effectiveYandexId', 'parkId: mapping.activeParkId || DRIVER_ACTIONS_PARK_ID', "reason: reason || (kind === 'CANCEL_ORDER' ? 'Отменено водителем' : null)"].every(value => consumer.includes(value)), 'scraper mapping drift')
check('scraper failure audit retained', consumer.includes("status: 'FAILED'") && consumer.includes('errorMessage: `scraper unreachable: ${e.message}`') && consumer.includes("error: 'SCRAPER_DOWN'"), 'failure mapping drift')
check('pending audit and response retained', consumer.includes("status: 'PENDING'") && consumer.includes('scraperTaskId,') && consumer.includes('actionId: action.id') && consumer.includes('taskId: scraperTaskId'), 'pending mapping drift')
check('poll fetch and guard retained', consumer.includes('if (!taskId)') && consumer.includes('fetch(`${SCRAPER_URL}/api/driver-actions/${taskId}`)') && consumer.includes("scraperState.status !== 'PENDING'"), 'poll flow drift')
check('mirror mapping and best effort retained', consumer.includes('MIRROR_DRIVER_ACTION_RESULT_COMMAND_V1') && consumer.includes('result: scraperState.result ?? undefined') && consumer.includes('shortOrderId: scraperState.result?.shortOrderId ?? undefined') && consumer.includes('orderId: scraperState.result?.orderLongId ?? undefined') && consumer.includes('completedAt: new Date()') && consumer.includes('}).catch(() => {})'), 'mirror drift')
check('command amendment exact', JSON.stringify(amendment.amendments[0]?.add_commands) === JSON.stringify(['RecordDriverActionCommand.v1', 'MirrorDriverActionResultCommand.v1']), 'amendment drift')
check('Platform Fleet dependency pre-approved', platform.allowed_dependencies.some(item => item.context === 'fleet_operations' && item.surface === 'fleet_operations.public'), 'approved dependency absent')

process.stdout.write(`${JSON.stringify({ status: failures.length ? 'FAIL' : 'PASS', checks, failures }, null, 2)}\n`)
if (failures.length) process.exitCode = 1
