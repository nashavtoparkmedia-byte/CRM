#!/usr/bin/env node
import fs from 'node:fs'

const read = file => fs.readFileSync(file, 'utf8')
const checks = []
const failures = []
const check = (name, value, detail) => value
  ? checks.push(name)
  : failures.push({ check: name, detail })

const contract = read('gravity-mvp/src/contracts/messaging/v1/external-conversation-commands.ts')
const handler = read('gravity-mvp/src/modules/messaging/public/v1/external-conversation-handler.ts')
const adapter = read('gravity-mvp/src/modules/messaging/public/v1/legacy-prisma-external-conversation-adapter.ts')
const webhook = read('gravity-mvp/src/app/api/webhooks/max/route.ts')
const legacyWebhook = read('gravity-mvp/src/app/api/webhook/max/route.ts')
const sync = read('gravity-mvp/src/app/api/webhook/max/sync-names/route.ts')
const amendment = JSON.parse(read('architecture/isolation/messaging/max-chat-v1/module-manifest-amendments.json'))
const contractWithoutChannelLiteral = contract.replace(/'max'/g, "'provider'")

check('contract neutral', !/(prisma|next\/|@\/lib|@\/app|max)/i.test(contractWithoutChannelLiteral), 'contract leak')
check('handler neutral', !/(prisma|next\/|@\/lib|@\/app|max)/i.test(handler), 'handler leak')
check(
  'writes isolated',
  (adapter.match(/prisma\.chat\.(?:update|create)/g) || []).length === 2
    && !/prisma\.chat\.(?:update|create)\s*\(/.test(webhook)
    && !/prisma\.chat\.(?:update|create)\s*\(/.test(sync)
    && !/prisma\.chat\.(?:update|create)\s*\(/.test(legacyWebhook),
  'foreign write remains',
)
check(
  'legacy metadata ingress routes are retired',
  sync.includes('MAX_NAME_SYNC_RETIRED')
    && legacyWebhook.includes('MAX_LEGACY_WEBHOOK_RETIRED')
    && !/await\s+(?:request|req)\.json/.test(sync + legacyWebhook),
  'legacy ingress retirement drift',
)
check(
  'canonical webhook requires an opaque provider chat id',
  webhook.includes("if (!chatId)")
    && webhook.includes("return NextResponse.json({ error: 'chatId is required' }")
    && webhook.includes('const externalChatId = normalizeMaxChatId(chatId)'),
  'provider chat identity drift',
)
check(
  'primary lookup retained',
  webhook.includes('prisma.chat.findUnique({') && webhook.includes('where: { externalChatId }'),
  'primary lookup drift',
)
check(
  'sender lookup is account scoped and ambiguity checked',
  webhook.includes("metadata: { path: ['senderId'], equals: peerSenderIdString }")
    && webhook.includes("metadata: { path: ['providerAccountId'], equals: maxProviderAccountId }")
    && webhook.includes('selectUniqueExactMaxSenderCandidate(senderCandidates)'),
  'sender lookup drift',
)
check(
  'phone-only conversation lookup remains absent',
  !webhook.includes("phone: { contains: last10 }")
    && !webhook.includes('existingByPhone')
    && !webhook.includes('previousExternalChatId: existingByPhone'),
  'mutable phone metadata can select a conversation',
)
check(
  'sender replacement retains exact account and prior conversation key',
  webhook.includes('previousExternalChatId: existingBySender.externalChatId')
    && webhook.includes('providerAccountId: maxProviderAccountId')
    && webhook.includes("connectionId: existingMetadata.connectionId || 'max_scraper'"),
  'sender replacement drift',
)
check(
  'create mapping retains opaque provider key and account evidence',
  webhook.includes('CREATE_EXTERNAL_CONVERSATION_COMMAND_V1')
    && webhook.includes('externalChatId,')
    && webhook.includes("peerSenderName || (peerSenderIdString ? `MAX:${peerSenderIdString}` : `MAX:${externalChatId}`)")
    && webhook.includes("status:        'new'")
    && webhook.includes('providerAccountId: maxProviderAccountId')
    && webhook.includes("connectionId: 'max_scraper'"),
  'create drift',
)
check(
  'final patch uses the Messaging owner capability',
  webhook.includes('chatId: chat.id')
    && webhook.includes("peerSenderName && chat.name?.startsWith('MAX:')")
    && webhook.includes('isHistoryReplay ? {} : { lastMessageAt: sentAt }')
    && webhook.includes('patchExternalConversationV1({'),
  'final patch drift',
)
check(
  'adapter exact',
  adapter.includes('prisma.chat.update({where:{id:chatId}')
    && adapter.includes('prisma.chat.create({data:{channel:input.channel'),
  'adapter drift',
)
check(
  'commands amendment exact',
  JSON.stringify(amendment.amendments[0]?.add_commands)
    === JSON.stringify(['PatchExternalConversationCommand.v1', 'CreateExternalConversationCommand.v1']),
  'amendment drift',
)

process.stdout.write(`${JSON.stringify({ status: failures.length ? 'FAIL' : 'PASS', checks, failures }, null, 2)}\n`)
if (failures.length) process.exitCode = 1
