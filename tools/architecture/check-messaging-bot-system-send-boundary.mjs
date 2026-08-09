#!/usr/bin/env node
import fs from 'node:fs'

const read = (file) => fs.readFileSync(file, 'utf8')
const checks = []
const failures = []
const check = (name, value, detail) => value ? checks.push(name) : failures.push({ check: name, detail })
const contract = read('gravity-mvp/src/contracts/messaging/v1/send-message-command.ts')
const handler = read('gravity-mvp/src/modules/messaging/public/v1/send-message-handler.ts')
const adapter = read('gravity-mvp/src/modules/messaging/public/v1/legacy-prisma-send-message-adapter.ts')
const consumer = read('gravity-mvp/src/app/api/webhooks/bot/route.ts')
const messaging = JSON.parse(read('architecture/contexts/v1/manifests/messaging.json'))
const platform = JSON.parse(read('architecture/contexts/v1/manifests/platform_shell.json'))

check('contract is provider neutral', !/(prisma|next\/|@\/lib|@\/app)/i.test(contract), 'implementation leaked into contract')
check('handler is implementation neutral', !/(prisma|next\/|@\/lib|@\/app)/i.test(handler), 'implementation leaked into handler')
check('write is isolated in Messaging adapter', adapter.includes('prisma.message.create') && !/prisma\.message\.create/.test(consumer), 'foreign write remains')
check('fixed system semantics retained', ["direction: 'system'", "type: 'system'", "status: 'sent'"].every((value) => adapter.includes(value)), 'fixed fields drifted')
check('bot invokes SendMessage v1', consumer.includes('SEND_MESSAGE_COMMAND_V1') && consumer.includes('APPEND_SYSTEM_NOTIFICATION_V1') && consumer.includes('sendMessageV1({'), 'owner command absent')
check('notification text retained', ['Запрос привязки TG Бота', 'не найден в Яндекс Флит', 'Привяжите вручную'].every((value) => consumer.includes(value)), 'notification content drifted')
check('external id retained', consumer.includes('`bot_link_req_${telegramId}_${Date.now()}`'), 'external id drifted')
check('fresh sent instant retained', consumer.includes('sentAt: new Date().toISOString()'), 'sentAt drifted')
check('message precedes Chat update', consumer.indexOf('await sendMessageV1') < consumer.indexOf('await prisma.chat.update'), 'operation order drifted')
check('nonblocking outer catch retained', consumer.includes("console.error('[notifyManagerPendingLink] Error:'"), 'failure handling drifted')
check('neighboring Chat update remains explicit', /prisma\.chat\.update/.test(consumer), 'neighboring plan moved')
check('SendMessage command predeclared', messaging.commands.includes('SendMessageCommand.v1'), 'manifest command absent')
check('Platform Messaging dependency pre-approved', platform.allowed_dependencies.some((item) => item.context === 'messaging' && item.surface === 'messaging.public'), 'approved dependency absent')
check('secret references unchanged in kind', consumer.includes('process.env.BOT_CRM_SECRET') && consumer.includes('process.env.BOT_API_URL'), 'secret reference drifted')

process.stdout.write(`${JSON.stringify({ status: failures.length ? 'FAIL' : 'PASS', checks, failures }, null, 2)}\n`)
if (failures.length) process.exitCode = 1
