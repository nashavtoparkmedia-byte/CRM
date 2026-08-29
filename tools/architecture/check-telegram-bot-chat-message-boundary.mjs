#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const sourcePaths = {
  contract: 'gravity-mvp/src/contracts/telegram-channel/v1/bot-chat-message-commands.ts',
  handler: 'gravity-mvp/src/modules/telegram-channel/public/v1/bot-chat-message-handler.ts',
  adapter: 'gravity-mvp/src/modules/telegram-channel/public/v1/legacy-prisma-bot-chat-message-adapter.ts',
  users: 'gravity-mvp/src/app/api/bot-users/route.ts',
  webhook: 'gravity-mvp/src/app/api/webhooks/bot/route.ts',
  amendment: 'architecture/isolation/telegram-channel/bot-chat-message-v1/module-manifest-amendments.json',
}

const compact = (source) => source.replace(/\s+/gu, '')

const section = (source, startMarker, endMarker) => {
  const start = source.indexOf(startMarker)
  if (start < 0) return ''
  if (!endMarker) return source.slice(start)
  const end = source.indexOf(endMarker, start + startMarker.length)
  return end < 0 ? source.slice(start) : source.slice(start, end)
}

export function loadTelegramBotChatMessageBoundarySources(root = process.cwd()) {
  const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8')
  return {
    contract: read(sourcePaths.contract),
    handler: read(sourcePaths.handler),
    adapter: read(sourcePaths.adapter),
    users: read(sourcePaths.users),
    webhook: read(sourcePaths.webhook),
    amendment: JSON.parse(read(sourcePaths.amendment)),
  }
}

export function evaluateTelegramBotChatMessageBoundary(sources) {
  const checks = []
  const failures = []
  const check = (name, value, detail) => {
    if (value) checks.push(name)
    else failures.push({ check: name, detail })
  }

  const adapter = compact(sources.adapter)
  const users = compact(sources.users)
  const webhook = compact(sources.webhook)
  const dismiss = section(adapter, 'asyncdismiss(requestId)', 'asyncrecordPending(input)')
  const record = section(adapter, 'asyncrecordPending(input)', '')
  const deleteRoute = section(users, 'exportasyncfunctionDELETE', '')
  const requestStart = deleteRoute.indexOf('if(requestId)')
  const requestBranch = requestStart < 0
    ? ''
    : deleteRoute.slice(requestStart, deleteRoute.indexOf('returnNextResponse.json({error:', requestStart))
  const fallbackStart = webhook.indexOf('//2.Fallback:')
  const fallback = fallbackStart < 0
    ? ''
    : webhook.slice(fallbackStart, webhook.indexOf('//Injectasystemmessage', fallbackStart))
  const directBotChatWrite = /(?:prisma|tx)\.botChatMessage\.(?:create|createMany|delete|deleteMany|update|updateMany|upsert)\(/u

  check('contract neutral', !/(prisma|next\/|@\/lib|@\/app)/iu.test(sources.contract), 'contract leak')
  check('handler neutral', !/(prisma|next\/|@\/lib|@\/app)/iu.test(sources.handler), 'handler leak')
  check(
    'writes isolated',
    dismiss.includes('tx.botChatMessage.deleteMany(')
      && record.includes('prisma.botChatMessage.update(')
      && record.includes('prisma.botChatMessage.create(')
      && !directBotChatWrite.test(users)
      && !directBotChatWrite.test(webhook),
    'foreign write remains',
  )
  check(
    'dismiss id mapping retained',
    dismiss.includes('tx.botChatMessage.deleteMany({where:{id:requestId}})'),
    'delete mapping drift',
  )
  check(
    'dismiss transaction mapping retained',
    /awaitprisma\.\$transaction\(async\(?tx\)?=>\{/u.test(dismiss)
      && dismiss.includes('tx.botChatMessage.findUnique({where:{id:requestId},select:{telegramId:true}})')
      && dismiss.includes('tx.botUserRegistry.findUnique({where:{id:requestId},select:{telegramId:true}})')
      && dismiss.includes('consttelegramId=message?.telegramId||registry?.telegramId'),
    'dismiss transaction mapping drift',
  )
  check(
    'dismiss pending cleanup retained',
    /where:\{telegramId,driverId:null,direction:'INCOMING',text:\{startsWith:'\[Запроспривязки\]'\},?\}/u.test(dismiss)
      && dismiss.includes('tx.driverTelegram.findUnique({where:{telegramId},select:{id:true}})')
      && dismiss.includes('if(!linked)awaittx.botUserRegistry.deleteMany({where:{telegramId}})'),
    'dismiss pending cleanup drift',
  )
  check(
    'dismiss branch ordering retained',
    deleteRoute.indexOf('if(telegramId)') < requestStart
      && requestBranch.indexOf('dismissBotLinkRequestV1') < requestBranch.indexOf('NextResponse.json({success:true})')
      && requestStart < deleteRoute.indexOf('telegramIdorrequestIdrequired'),
    'delete response drift',
  )
  check(
    'record mapping retained',
    record.includes('consttelegramId=BigInt(input.telegramId)')
      && record.includes("data:{telegramId,text:input.text,direction:'INCOMING',driverId:null}"),
    'record mapping drift',
  )
  check(
    'record dedupe retained',
    record.includes('prisma.botChatMessage.findFirst({')
      && /where:\{telegramId,driverId:null,direction:'INCOMING',text:\{startsWith:'\[Запроспривязки\]'\},?\}/u.test(record)
      && record.includes('prisma.botChatMessage.update({where:{id:existing.id},data:{text:input.text}})')
      && record.indexOf('prisma.botChatMessage.findFirst(') < record.indexOf('prisma.botChatMessage.update(')
      && record.indexOf('prisma.botChatMessage.update(') < record.indexOf('prisma.botChatMessage.create('),
    'record dedupe drift',
  )
  check(
    'fallback text retained',
    fallback.includes("`[Запроспривязки]Телефон:${phone},@${username||'нет'}`"),
    'fallback text drift',
  )
  check(
    'fallback order retained',
    fallback.indexOf('recordPendingBotLinkRequestV1') < fallback.indexOf('notifyManagerPendingLink')
      && fallback.indexOf('notifyManagerPendingLink') < fallback.indexOf('NextResponse.json({success:true,autoLinked:false'),
    'fallback order drift',
  )
  check(
    'string conversion precedes owner conversion',
    fallback.includes('telegramId:String(telegramId)') && record.includes('BigInt(input.telegramId)'),
    'telegram id drift',
  )
  check(
    'commands amendment exact',
    JSON.stringify(sources.amendment.amendments[0]?.add_commands)
      === JSON.stringify(['DismissBotLinkRequestCommand.v1', 'RecordPendingBotLinkRequestCommand.v1']),
    'commands amendment drift',
  )
  check(
    'dependency amendment exact',
    JSON.stringify(sources.amendment.amendments[1]?.add_allowed_dependencies)
      === JSON.stringify([{ context: 'telegram_channel', surface: 'telegram_channel.public' }]),
    'dependency amendment drift',
  )
  check(
    'dependency source exact',
    sources.amendment.amendments[1]?.context === 'platform_shell',
    'dependency source drift',
  )

  return { status: failures.length ? 'FAIL' : 'PASS', checks, failures }
}

function main() {
  const result = evaluateTelegramBotChatMessageBoundary(loadTelegramBotChatMessageBoundarySources())
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  if (result.failures.length) process.exitCode = 1
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
