#!/usr/bin/env node
import fs from 'node:fs'

const read = (file) => fs.readFileSync(file, 'utf8')
const checks = []
const failures = []
const check = (name, value, detail) => value ? checks.push(name) : failures.push({ check: name, detail })
const contract = read('gravity-mvp/src/contracts/messaging/v1/update-conversation-command.ts')
const handler = read('gravity-mvp/src/modules/messaging/public/v1/update-conversation-handler.ts')
const adapter = read('gravity-mvp/src/modules/messaging/public/v1/legacy-prisma-update-conversation-adapter.ts')
const consumer = read('gravity-mvp/src/app/api/webhooks/bot/route.ts')
const inventoryTest = read('gravity-mvp/src/lib/__tests__/max-contact-resolution-shadow.test.ts')
const platform = JSON.parse(read('architecture/contexts/v1/manifests/platform_shell.json'))
const amendment = JSON.parse(read('architecture/isolation/messaging/bot-chat-state-v1/module-manifest-amendments.json'))

check('contract is provider neutral', !/(prisma|next\/|@\/lib|@\/app)/i.test(contract), 'implementation leaked into contract')
check('handler is implementation neutral', !/(prisma|next\/|@\/lib|@\/app)/i.test(handler), 'implementation leaked into handler')
check('write is isolated in Messaging adapter', adapter.includes('prisma.chat.update') && !/prisma\.chat\.update/.test(consumer), 'foreign write remains')
check('fixed response semantics retained', ["status: 'open'", 'requiresResponse: true', 'unreadCount: { increment: 1 }'].every((value) => adapter.includes(value)), 'fixed fields drifted')
check('owner selects exact chat identity', adapter.includes('where: { id: input.chatId }') && adapter.includes('select: { id: true }'), 'chat identity drifted')
check('bot invokes UpdateConversation v1', consumer.includes('UPDATE_CONVERSATION_COMMAND_V1') && consumer.includes('MARK_REQUIRES_RESPONSE_V1') && consumer.includes('updateConversationV1({'), 'owner command absent')
check('message still precedes state update', consumer.indexOf('await sendMessageV1') < consumer.indexOf('await updateConversationV1'), 'operation order drifted')
check('fresh last-message instant retained', consumer.includes('lastMessageAt: new Date().toISOString()'), 'lastMessageAt drifted')
check('nonblocking outer catch retained', consumer.includes("console.error('[notifyManagerPendingLink] Error:'"), 'failure handling drifted')
check('command amendment exact', amendment.amendments.length === 1 && amendment.amendments[0].context === 'messaging' && amendment.amendments[0].add_commands?.length === 1 && amendment.amendments[0].add_commands[0] === 'UpdateConversationCommand.v1', 'command amendment drifted')
check('Platform Messaging dependency pre-approved', platform.allowed_dependencies.some((item) => item.context === 'messaging' && item.surface === 'messaging.public'), 'approved dependency absent')
check('unrelated MAX shadow assertion recognizes accepted owner route', inventoryTest.includes("route.indexOf('await patchExternalConversationV1')") && inventoryTest.includes("route.indexOf('await createExternalConversationV1')") && inventoryTest.includes('src/app/api/webhooks/max/route.ts'), 'unrelated MAX shadow owner-route assertion drifted')
check('secret references unchanged in kind', consumer.includes('process.env.BOT_CRM_SECRET') && consumer.includes('process.env.BOT_API_URL'), 'secret reference drifted')

process.stdout.write(`${JSON.stringify({ status: failures.length ? 'FAIL' : 'PASS', checks, failures }, null, 2)}\n`)
if (failures.length) process.exitCode = 1
