#!/usr/bin/env node
import fs from 'node:fs'

const read = (file) => fs.readFileSync(file, 'utf8')
const checks = []
const failures = []
const check = (name, value, detail) => value ? checks.push(name) : failures.push({ check: name, detail })
const contract = read('gravity-mvp/src/contracts/messaging/v1/receive-message-command.ts')
const handler = read('gravity-mvp/src/modules/messaging/public/v1/receive-message-handler.ts')
const adapter = read('gravity-mvp/src/modules/messaging/public/v1/legacy-prisma-receive-message-adapter.ts')
const consumer = read('gravity-mvp/src/lib/leads/intake.ts')
const messaging = JSON.parse(read('architecture/contexts/v1/manifests/messaging.json'))
const avito = JSON.parse(read('architecture/contexts/v1/manifests/avito_acquisition.json'))

check('contract is provider neutral', !/(prisma|next\/|@\/lib|@\/app)/i.test(contract), 'implementation leaked into contract')
check('handler is implementation neutral', !/(prisma|next\/|@\/lib|@\/app)/i.test(handler), 'implementation leaked into handler')
check('write is isolated in Messaging adapter', adapter.includes('prisma.message.create') && !/prisma\.message\.create/.test(consumer), 'foreign write remains')
check('owner idempotency retained', adapter.includes('prisma.message.findUnique') && adapter.includes('created: false'), 'external-id lookup drifted')
check('fixed inbound semantics retained', ["direction: 'inbound'", "type: 'text'", "status: 'delivered'"].every((value) => adapter.includes(value)), 'fixed message semantics drifted')
check('Avito invokes ReceiveMessage v1', consumer.includes('RECEIVE_MESSAGE_COMMAND_V1') && consumer.includes('receiveMessageV1({'), 'owner command absent')
check('content fallback retained', ['input.preview.trim()', '`Новый отклик от ${input.candidateName}`', "'Новый отклик'"].every((value) => consumer.includes(value)), 'content derivation drifted')
check('external id retained', consumer.includes('`${input.source}:msg:${input.sourceExternalId}`'), 'external id drifted')
check('received instant retained', consumer.includes('sentAt: input.receivedAt.toISOString()'), 'sentAt drifted')
check('metadata retained', consumer.includes('source: input.source') && consumer.includes('sourceExternalId: input.sourceExternalId') && consumer.includes('...input.sourceMeta'), 'metadata drifted')
check('owner message id returned', consumer.includes('messageId: receivedMessage.messageId'), 'result semantics drifted')
check('adjacent Chat plan uses accepted owner route', !/prisma\.chat\.(create|update)/.test(consumer) && consumer.includes('ENSURE_LEAD_CONVERSATION_COMMAND_V1') && consumer.includes('ensureLeadConversationV1({'), 'neighboring plan is neither legacy nor isolated')
check('ReceiveMessage command predeclared', messaging.commands.includes('ReceiveMessageCommand.v1'), 'manifest command absent')
check('Avito Messaging dependency pre-approved', avito.allowed_dependencies.some((item) => item.context === 'messaging' && item.surface === 'messaging.public'), 'approved dependency absent')

process.stdout.write(`${JSON.stringify({ status: failures.length ? 'FAIL' : 'PASS', checks, failures }, null, 2)}\n`)
if (failures.length) process.exitCode = 1
