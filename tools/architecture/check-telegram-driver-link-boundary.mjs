#!/usr/bin/env node
import fs from 'node:fs'

const read = file => fs.readFileSync(file, 'utf8')
const checks = []
const failures = []
const check = (name, value, detail) => value
  ? checks.push(name)
  : failures.push({ check: name, detail })

const contract = read('gravity-mvp/src/contracts/telegram-channel/v1/driver-telegram-commands.ts')
const manualContract = read('gravity-mvp/src/contracts/telegram-channel/v1/manual-driver-telegram-link-commands.ts')
const handler = read('gravity-mvp/src/modules/telegram-channel/public/v1/driver-telegram-handler.ts')
const manualHandler = read('gravity-mvp/src/modules/telegram-channel/public/v1/manual-driver-telegram-link-handler.ts')
const adapter = read('gravity-mvp/src/modules/telegram-channel/public/v1/legacy-prisma-driver-telegram-adapter.ts')
const manualAdapter = read('gravity-mvp/src/modules/telegram-channel/public/v1/legacy-prisma-manual-driver-telegram-link-adapter.ts')
const authority = read('gravity-mvp/src/modules/telegram-channel/public/v1/manual-driver-telegram-link-authority.ts')
const notification = read('gravity-mvp/src/modules/telegram-channel/public/v1/legacy-bot-api-manual-driver-telegram-link-notification-adapter.ts')
const botActions = read('gravity-mvp/src/app/tg-bot-actions.ts')
const link = read('gravity-mvp/src/app/api/bot-link/route.ts')
const users = read('gravity-mvp/src/app/api/bot-users/route.ts')
const webhook = read('gravity-mvp/src/app/api/webhooks/bot/route.ts')
const telegramWebhook = read('gravity-mvp/src/app/api/webhook/telegram/route.ts')
const platformRoute = read('gravity-mvp/src/app/api/platform/drivers/[id]/telegram-link/route.ts')
const botDriverActionCallers = [
  'balanceLimit.js',
  'quickLimit.js',
  'carManagement.js',
  'driverOrder.js',
  'parkSelect.js',
].map(file => read(`tg-bot/src/handlers/${file}`))
const amendment = JSON.parse(read('architecture/isolation/telegram-channel/driver-link-v1/module-manifest-amendments.json'))

const localLinkStart = link.lastIndexOf('const driver = await prisma.driver.findUnique')
const localLink = link.slice(localLinkStart)
const parkLinkStart = link.indexOf('if (yandexDriverId && parkId && driverName)')
const parkLink = link.slice(parkLinkStart, localLinkStart)
const syncUserStart = webhook.indexOf('async function handleSyncUser')
const syncUser = webhook.slice(syncUserStart, webhook.indexOf('// Inject a system message', syncUserStart))

check('contract neutral', !/(prisma|next\/|@\/lib|@\/app)/i.test(contract + manualContract), 'contract leak')
check('handler neutral', !/(prisma|next\/|@\/lib|@\/app)/i.test(handler + manualHandler), 'handler leak')
check(
  'writes isolated',
  !/(?:prisma|tx)\.driverTelegram\.(?:create|update|upsert|deleteMany)/.test(
    link + users + webhook + botActions + platformRoute,
  ) && (adapter.match(/(?:prisma|tx)\.driverTelegram\.(?:create|update|upsert|deleteMany)/g) || []).length === 6,
  'foreign write remains',
)
check(
  'replace atomic',
  adapter.includes('prisma.$transaction(async tx=>')
    && adapter.indexOf('driverId:input.driverId') < adapter.indexOf('telegramId:input.telegramId')
    && adapter.indexOf('telegramId:input.telegramId') < adapter.indexOf('tx.driverTelegram.create'),
  'replace ordering drift',
)
check(
  'manual link authority retained',
  authority.includes('externalChatId: `telegram:${target}`')
    && authority.includes("chat.chatType !== 'private'")
    && authority.includes("metadata.chatKind !== 'private'")
    && authority.includes('prepareOutboundConversationV1(chat)')
    && authority.includes('isContactConfirmedMainDriverV1(outbound.contactId, driverId)')
    && authority.includes('revalidatePreparedManualDriverTelegramLinkAuthorityV1')
    && manualAdapter.indexOf('prepareManualDriverTelegramLinkAuthorityV1(input)') < manualAdapter.indexOf('transaction.driverTelegram.create')
    && manualAdapter.includes('CONTACT_OWNERSHIP_ADVISORY_CLASS_ID_V1')
    && manualAdapter.includes('CONTACT_OWNERSHIP_ADVISORY_OBJECT_ID_V1')
    && manualAdapter.includes('FROM "Chat"')
    && manualAdapter.includes('FOR UPDATE')
    && manualAdapter.lastIndexOf('await transaction.$queryRaw') < manualAdapter.indexOf('revalidatePreparedManualDriverTelegramLinkAuthorityV1(')
    && manualAdapter.indexOf('revalidatePreparedManualDriverTelegramLinkAuthorityV1(') < manualAdapter.indexOf('transaction.driverTelegram.create')
    && manualAdapter.indexOf('prepareManualDriverTelegramLinkAuthorityV1(existing)') < manualAdapter.indexOf('prisma.driverTelegram.deleteMany')
    && !/driverTelegram\.(?:upsert|update)/.test(manualAdapter)
    && !/phoneVerified\s*:/.test(manualAdapter),
  'manual authority or contradiction policy drift',
)
check(
  'manual notification exact',
  notification.includes('prisma.driverTelegram.findUnique')
    && notification.includes('prepareManualDriverTelegramLinkAuthorityV1')
    && notification.includes('sendExactTelegramBotMessageV1')
    && !/BOT_API_URL|\bfetch\s*\(/.test(notification)
    && !/BOT_API_URL|notifyDriverLinked/.test(webhook),
  'manual notification bypass drift',
)
check(
  'active manual surfaces use owner command',
  link.includes('saveManualDriverTelegramLinkV1')
    && !/replaceDriverTelegramLinkV1|upsertDriverTelegramLinkV1|upsertParkMatchedDriverV1/.test(link)
    && botActions.includes('saveManualDriverTelegramLinkV1')
    && !/driverTelegram\.upsert|phoneVerified\s*:/.test(botActions)
    && (
      platformRoute.includes('getCurrentUserIdentityV1')
      || platformRoute.includes('getIntegrationAdminPrincipal')
    ),
  'manual surface authority drift',
)
check(
  'bot Driver mutations reauthorize current person and transport',
  telegramWebhook.includes('prepareManualDriverTelegramLinkAuthorityV1')
    && (telegramWebhook.match(/requireCurrentDriverTelegramAuthority\(/g) || []).length >= 7
    && telegramWebhook.indexOf('requireCurrentDriverTelegramAuthority({') < telegramWebhook.indexOf('prisma.driverTelegram.update')
    && webhook.includes('prepareManualDriverTelegramLinkAuthorityV1')
    && webhook.includes("error: 'DRIVER_TELEGRAM_CURRENT_AUTHORITY_REQUIRED'")
    && webhook.includes('authority.providerAccountId !== providerAccountId')
    && webhook.includes('authority.connectionId !== connectionId')
    && (webhook.match(/requireCurrentBotDriverAuthority\(/g) || []).length >= 14
    && botDriverActionCallers.every(source => source.includes('exactTelegramActionBinding(ctx)')),
  'bot Driver mutation authority drift',
)
check(
  'link response ordering retained',
  localLinkStart >= 0
    && localLink.indexOf('prisma.driver.findUnique') < localLink.indexOf('saveConfirmedTelegramLink(driver.id')
    && localLink.indexOf('saveConfirmedTelegramLink(driver.id') < localLink.indexOf('driverName: driver.fullName')
    && parkLinkStart >= 0
    && parkLink.indexOf('prisma.driver.findUnique') < parkLink.indexOf('saveConfirmedTelegramLink(driver.id')
    && parkLink.indexOf('saveConfirmedTelegramLink(driver.id') < parkLink.indexOf('driverName: profile.fullName'),
  'link response drift',
)
check(
  'unlink mapping retained',
  users.includes('DELETE_DRIVER_TELEGRAM_LINK_COMMAND_V1')
    && users.includes('telegramId: BigInt(telegramId)'),
  'unlink drift',
)
check(
  'car cache best effort retained',
  (webhook.match(/patch: \{ carLabel: carInfo \} \}\)\.catch\(\(\) => \{\}\)/g) || []).length === 2,
  'car cache policy drift',
)
check(
  'generic phone ingress cannot create a first-result link',
  syncUserStart >= 0
    && !syncUser.includes('upsertDriverTelegramLinkV1')
    && !syncUser.includes('UPSERT_DRIVER_TELEGRAM_LINK_COMMAND_V1')
    && !syncUser.includes('listYandexConnectionCredentialsV1')
    && !/\bfetch\s*\(/u.test(syncUser),
  'generic phone ingress link boundary drift',
)
check(
  'stable local Telegram owner is retained',
  syncUser.includes('prisma.driverTelegram.findUnique')
    && syncUser.includes('existingLink?.driverId')
    && syncUser.includes('driverId: existingLink.driverId')
    && syncUser.indexOf('existingLink?.driverId') < syncUser.indexOf('recordPendingBotLinkRequestV1'),
  'stable Telegram owner handling drift',
)
check(
  'insufficient local evidence pends manager linking',
  syncUser.includes('recordPendingBotLinkRequestV1')
    && syncUser.includes("status: 'PENDING_MANAGER_LINK'"),
  'manager-link fallback drift',
)
check(
  'park mapping retained',
  webhook.includes('mappingId: mapping.id, patch: { activeParkId: parkId, carLabel: null, carId: null }'),
  'park reset drift',
)
check(
  'reads remain caller-owned',
  link.includes('prisma.driverTelegram.findFirst')
    && users.includes('prisma.driverTelegram.findMany')
    && webhook.includes('prisma.driverTelegram.findFirst'),
  'read ownership drift',
)
check(
  'transport and security remain caller-owned',
  webhook.includes("request.headers.get('x-bot-signature')")
    && webhook.includes('process.env.BOT_CRM_SECRET')
    && webhook.includes('findCarById('),
  'security/transport drift',
)
check(
  'amendment exact',
  JSON.stringify(amendment.amendments[0]?.add_commands) === JSON.stringify([
    'ReplaceDriverTelegramLinkCommand.v1',
    'DeleteDriverTelegramLinkCommand.v1',
    'PatchDriverTelegramLinkCommand.v1',
    'UpsertDriverTelegramLinkCommand.v1',
  ]),
  'amendment drift',
)

process.stdout.write(`${JSON.stringify({
  status: failures.length ? 'FAIL' : 'PASS',
  checks,
  failures,
}, null, 2)}\n`)
if (failures.length) process.exitCode = 1
