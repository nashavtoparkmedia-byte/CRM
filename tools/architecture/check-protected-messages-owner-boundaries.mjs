#!/usr/bin/env node
import { readFileSync } from 'node:fs'

const read = file => readFileSync(file, 'utf8')
const checks = []
const failures = []
const check = (name, condition, detail) => condition ? checks.push(name) : failures.push({ name, detail })

const parkRoute = read('gravity-mvp/src/app/api/contacts/[id]/parks/route.ts')
const fleetPark = read('gravity-mvp/src/modules/fleet-operations/public/v1/park-phone-search.ts')
const contactPark = read('gravity-mvp/src/modules/contacts/public/v1/contact-park-check.ts')
const telegramRoute = read('gravity-mvp/src/app/api/webhook/telegram/route.ts')
const botAdapter = read('gravity-mvp/src/modules/telegram-channel/public/v1/legacy-prisma-bot-user-profile-adapter.ts')
const botHandlerTest = read('gravity-mvp/src/modules/telegram-channel/public/v1/bot-user-profile-handler.test.ts')
const reactionRoute = read('gravity-mvp/src/app/api/messages/reaction/route.ts')
const maxRoute = read('gravity-mvp/src/app/api/webhooks/max/route.ts')
const contactAdapter = read('gravity-mvp/src/modules/contacts/public/v1/legacy-prisma-contact-conversation-adapter.ts')
const messagingAdapter = read('gravity-mvp/src/modules/messaging/public/v1/legacy-prisma-contact-conversation-adapter.ts')
const schema = read('gravity-mvp/prisma/schema.prisma')

check('park API is a Prisma-free owner-capability orchestrator',
  !parkRoute.includes('prisma.') && parkRoute.includes('searchYandexParksByPhonesV1') && parkRoute.includes('persistContactParkCheckResultV1') && parkRoute.includes('upsertParkMatchedDriverV1'),
  'park route bypasses an owner')
check('Fleet park writer is exact to one Driver upsert',
  (fleetPark.match(/prisma\.driver\.upsert/g) || []).length === 1 && !/prisma\.(?:contact|chat|message)\./.test(fleetPark),
  'Fleet park capability can write unrelated domains')
check('Contacts park snapshot writer is exact to one Contact update',
  (contactPark.match(/prisma\.contact\.update/g) || []).length === 1 && !/prisma\.(?:driver|chat|message)\./.test(contactPark),
  'Contacts park capability can write unrelated domains')
check('Telegram webhook uses the exact bot-profile capability',
  telegramRoute.includes('recordBotUserProfileV1') && !telegramRoute.includes('prisma.botUserRegistry'),
  'Telegram route writes registry directly')
check('Telegram owner adapter writes only BotUserRegistry once',
  (botAdapter.match(/prisma\.botUserRegistry\.upsert/g) || []).length === 1 && (botAdapter.match(/prisma\./g) || []).length === 1,
  'bot profile adapter has broader write power')
check('approved bot writer rejects an unrelated operation',
  botHandlerTest.includes("driverId: 'foreign'") && botHandlerTest.includes("rejects.toThrow('unsupported field')") && botHandlerTest.includes('not.toHaveBeenCalled()'),
  'negative unrelated writer property missing')
check('reaction persistence is routed through Messaging metadata capability',
  reactionRoute.includes('patchMessageMetadataV1') && !reactionRoute.includes('prisma.message.update('),
  'reaction route retains a direct message write')
check('MAX runtime retains owner writes and redacted trace instrumentation',
  maxRoute.includes('upsertExternalMessageV1') && maxRoute.includes('MAX_RUNTIME_TRACE_PREFIX') && maxRoute.includes("entry.textPreview = '[redacted]'") && maxRoute.includes("isOutgoing && !isHistoryReplay") && !maxRoute.includes('prisma.message.upsert('),
  'MAX required behavior or owner boundary missing')
check('selected phone is exact in Contacts identity preparation',
  (contactAdapter.match(/\.\.\.\(input\.phoneId \? \{ phoneId: input\.phoneId \} : \{\}\)/g) || []).length === 2 && contactAdapter.includes("...(input.phoneId ? { id: input.phoneId } : {})"),
  'selected phone can fall through to another contact phone')
check('selected phone can disable contact-wide Messaging fallback',
  messagingAdapter.includes('if (!conversation && input.allowContactFallback)') && messagingAdapter.includes('contactIdentityId: input.contactIdentityId'),
  'Messaging lookup remains contact-wide')
check('BotUserRegistry has durable schema and migration',
  schema.includes('model BotUserRegistry') && read('gravity-mvp/prisma/migrations/20260805073000_add_bot_user_registry/migration.sql').includes('CREATE TABLE IF NOT EXISTS "BotUserRegistry"'),
  'bot registry schema lineage missing')

process.stdout.write(`${JSON.stringify({ status: failures.length ? 'FAIL' : 'PASS', checks, failures }, null, 2)}\n`)
if (failures.length) process.exitCode = 1
