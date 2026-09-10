#!/usr/bin/env node
import fs from 'node:fs'

const read = (file) => fs.readFileSync(file, 'utf8')
const compact = (source) => source.replace(/\s+/g, '')
const checks = []
const failures = []
const check = (name, value, detail) => value ? checks.push(name) : failures.push({ check: name, detail })

const contract = read('gravity-mvp/src/contracts/telegram-channel/v1/bot-chat-message-commands.ts')
const handler = read('gravity-mvp/src/modules/telegram-channel/public/v1/bot-chat-message-handler.ts')
const adapter = read('gravity-mvp/src/modules/telegram-channel/public/v1/legacy-prisma-bot-chat-message-adapter.ts')
const adapterCompact = compact(adapter)
const users = read('gravity-mvp/src/app/api/bot-users/route.ts')
const webhook = read('gravity-mvp/src/app/api/webhooks/bot/route.ts')
const amendment = JSON.parse(read('architecture/isolation/telegram-channel/bot-chat-message-v1/module-manifest-amendments.json'))

const delStart = users.indexOf('export async function DELETE')
const del = users.slice(delStart)
const unlinkStart = del.indexOf("if (body.action === 'unlink')")
const requestStart = del.indexOf("if (body.action === 'dismiss')")
const requestEnd = del.indexOf("return NextResponse.json({ error: 'valid action required'", requestStart)
const requestBranch = del.slice(requestStart, requestEnd)
const syncUserStart = webhook.indexOf('async function handleSyncUser')
const fallbackStart = webhook.indexOf('await recordPendingBotLinkRequestV1', syncUserStart)
const fallback = webhook.slice(fallbackStart, webhook.indexOf('// Inject a system message', fallbackStart))
const syncUser = webhook.slice(syncUserStart, webhook.indexOf('// Inject a system message', syncUserStart))

check('contract neutral', !/(prisma|next\/|@\/lib|@\/app)/i.test(contract), 'contract leak')
check('handler neutral', !/(prisma|next\/|@\/lib|@\/app)/i.test(handler), 'handler leak')
check(
  'writes isolated',
  adapterCompact.includes('prisma.botChatMessage.deleteMany')
    && adapterCompact.includes('prisma.botChatMessage.create')
    && (adapterCompact.match(/prisma\.botChatMessage\.(?:deleteMany|create)/g) || []).length === 2
    && !users.includes('prisma.botChatMessage.deleteMany')
    && !webhook.includes('prisma.botChatMessage.create'),
  'foreign write remains',
)
check(
  'dismiss id mapping retained',
  adapterCompact.includes("asyncdismiss(requestId){constresult=awaitprisma.botChatMessage.deleteMany({where:{id:requestId,driverId:null,direction:'INCOMING',text:{startsWith:'[Запроспривязки]'}}});returnresult.count===1}"),
  'delete mapping drift',
)
check(
  'dismiss branch ordering retained',
  unlinkStart > -1
    && unlinkStart < requestStart
    && requestBranch.indexOf('dismissBotLinkRequestV1') < requestBranch.indexOf('NextResponse.json({ success: true })')
    && requestBranch.indexOf('error instanceof PendingBotLinkRequestNotFoundError') < requestBranch.indexOf('NextResponse.json({ success: true })')
    && requestStart < requestEnd,
  'delete response drift',
)
check(
  'record mapping retained',
  adapterCompact.includes("asyncrecordPending(input){awaitprisma.botChatMessage.create({data:{telegramId:BigInt(input.telegramId),text:input.text,direction:'INCOMING',driverId:null}})}"),
  'record mapping drift',
)
check('fallback text retained', fallback.includes("`[Запрос привязки] Телефон: ${normalizedPhone}, @${username || 'нет'}`"), 'fallback text drift')
check(
  'fallback order retained',
  fallback.indexOf('recordPendingBotLinkRequestV1') < fallback.indexOf('notifyManagerPendingLink')
    && fallback.indexOf('notifyManagerPendingLink') < fallback.indexOf('NextResponse.json({')
    && fallback.indexOf('autoLinked: false') > fallback.indexOf('NextResponse.json({'),
  'fallback order drift',
)
check(
  'string conversion precedes owner conversion',
  syncUser.indexOf('const telegramIdText = String(telegramId).trim()') < syncUser.indexOf('await recordPendingBotLinkRequestV1')
    && fallback.includes('telegramId: telegramIdText')
    && adapter.includes('BigInt(input.telegramId)'),
  'telegram id drift',
)
check(
  'generic phone ingress remains local only',
  !syncUser.includes('listYandexConnectionCredentialsV1')
    && !syncUser.includes('fleet-api.taxi.yandex.net')
    && !/\bfetch\s*\(/u.test(syncUser)
    && !syncUser.includes('upsertDriverTelegramLinkV1')
    && syncUser.includes("status: 'PENDING_MANAGER_LINK'"),
  'generic phone ingress provider boundary drift',
)
check(
  'commands amendment exact',
  JSON.stringify(amendment.amendments[0]?.add_commands) === JSON.stringify([
    'DismissBotLinkRequestCommand.v1',
    'RecordPendingBotLinkRequestCommand.v1',
  ]),
  'commands amendment drift',
)
check(
  'dependency amendment exact',
  JSON.stringify(amendment.amendments[1]?.add_allowed_dependencies) === JSON.stringify([
    { context: 'telegram_channel', surface: 'telegram_channel.public' },
  ]),
  'dependency amendment drift',
)
check('dependency source exact', amendment.amendments[1]?.context === 'platform_shell', 'dependency source drift')

process.stdout.write(`${JSON.stringify({ status: failures.length ? 'FAIL' : 'PASS', checks, failures }, null, 2)}\n`)
if (failures.length) process.exitCode = 1
