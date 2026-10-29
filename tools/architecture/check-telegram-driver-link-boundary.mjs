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
const uniqueMatchStart = webhook.indexOf('async function uniqueUnlinkedDriverForPhone')
const uniqueMatch = webhook.slice(uniqueMatchStart, webhook.indexOf('async function handleChangeLimit', uniqueMatchStart))
const botAuthorityStart = webhook.indexOf('async function resolveCurrentBotDriverAuthority')
const botAuthority = webhook.slice(botAuthorityStart, webhook.indexOf('async function requireCurrentBotDriverAuthority', botAuthorityStart))
const telegramPhoneStart = webhook.indexOf('function telegramRussianPhone(')
const telegramPhone = webhook.slice(telegramPhoneStart, webhook.indexOf('\n}\n', telegramPhoneStart) + 3)
const cashProofStart = webhook.indexOf('async function proveCompensationTelegramPerson')
const cashProof = webhook.slice(cashProofStart, webhook.indexOf('function compensationProofFields', cashProofStart))
const linkPostStart = link.indexOf('export async function POST')
const linkPost = link.slice(linkPostStart)
const settingsLinkStart = botActions.indexOf('export async function linkTelegramUserToDriver')
const settingsLink = botActions.slice(settingsLinkStart)

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
    // Chat.chatType is the single canonical private/group source. metadata.chatKind
    // must NOT be a second source: no production row carries it and the conversation
    // adapter never writes metadata onto an existing row, so requiring it refused
    // every conversation forever.
    && !authority.includes("metadata.chatKind !== 'private'")
    // Proving a person must not call an outbound routing proof: a Chat is the shared
    // peer identity, so person authority may not depend on a transport.
    && !authority.includes('prepareOutboundConversationV1(chat)')
    && authority.includes('isContactConfirmedMainDriverV1(contactId, driverId)')
    // The manual link authority takes its transport from Telegram-owned
    // configuration, never from the shared Chat.
    && authority.includes('canonicalTelegramBotConnectionIdV1()')
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
  // Owner decision 2026-10-28: the manager's choice is the link. Both manual
  // surfaces relink in one action through the owner's atomic replace command.
  link.includes('replaceDriverTelegramLinkV1')
    && !/saveManualDriverTelegramLinkV1|upsertDriverTelegramLinkV1|upsertParkMatchedDriverV1/.test(link)
    && botActions.includes('replaceDriverTelegramLinkV1')
    && !/saveManualDriverTelegramLinkV1|upsertDriverTelegramLinkV1/.test(botActions)
    && !/driverTelegram\.upsert|phoneVerified\s*:/.test(botActions)
    // With the Contacts gate gone, integration-admin, same-origin and the exact
    // Yandex profile are the whole authority of a manual link.
    && settingsLinkStart >= 0
    && settingsLink.includes('await requireIntegrationAdminAccess()')
    && settingsLink.indexOf('await requireIntegrationAdminAccess()') < settingsLink.indexOf('replaceDriverTelegramLinkV1(')
    && linkPostStart >= 0
    && linkPost.indexOf('if (!isSameOriginMutationRequest(req)) {') >= 0
    && linkPost.indexOf('if (!isSameOriginMutationRequest(req)) {') < linkPost.indexOf("if (body.action === 'link') {")
    && linkPost.indexOf('if (!(await hasIntegrationAdminAccess())) {') >= 0
    && linkPost.indexOf('if (!(await hasIntegrationAdminAccess())) {') < linkPost.indexOf("if (body.action === 'link') {")
    && parkLink.includes('if (!profile.driverId || profile.driverId !== driverId || !driver || !carriesExactProfile) {')
    && parkLink.indexOf('!carriesExactProfile) {') < parkLink.indexOf('return NextResponse.json(DRIVER_PROFILE_UNVERIFIED, { status: 409 })')
    && parkLink.indexOf('return NextResponse.json(DRIVER_PROFILE_UNVERIFIED, { status: 409 })') < parkLink.indexOf('saveConfirmedTelegramLink(driver.id')
    && (
      platformRoute.includes('getCurrentUserIdentityV1')
      || platformRoute.includes('getIntegrationAdminPrincipal')
    ),
  'manual surface authority drift',
)
check(
  'bot Driver mutations reauthorize current link and transport',
  telegramWebhook.includes('prepareDriverTelegramConversationAuthorityV1')
    && (telegramWebhook.match(/requireCurrentDriverTelegramAuthority\(/g) || []).length >= 7
    && telegramWebhook.indexOf('requireCurrentDriverTelegramAuthority({') < telegramWebhook.indexOf('prisma.driverTelegram.update')
    && telegramWebhook.includes('canonicalTelegramBotConnectionIdV1()')
    // Owner decision 2026-10-28: the exact Telegram -> Driver link, read again
    // at every check, is the driver-bot authority; Contacts' person proof is
    // asked only by Cash, which pays a person.
    && botAuthorityStart >= 0
    && botAuthority.includes('connectionId !== canonicalTelegramBotConnectionIdV1()')
    && botAuthority.includes('prisma.driverTelegram.findUnique({')
    && botAuthority.includes('where: { telegramId: input.telegramId }')
    && botAuthority.includes('link.driverId !== input.driverId')
    // One success, and only after the link row was read and compared.
    && (botAuthority.match(/return \{ driverId: input\.driverId, target:/g) || []).length === 1
    && (botAuthority.match(/return\s*\{/g) || []).length === 1
    && botAuthority.indexOf('prisma.driverTelegram.findUnique({') < botAuthority.indexOf('link.driverId !== input.driverId')
    && botAuthority.indexOf('link.driverId !== input.driverId') < botAuthority.indexOf('return { driverId: input.driverId, target:')
    && !botAuthority.includes('prepareDriverTelegramConversationAuthorityV1')
    && (webhook.match(/prepareDriverTelegramConversationAuthorityV1\(/g) || []).length === 1
    && cashProofStart >= 0
    && cashProof.includes('prepareDriverTelegramConversationAuthorityV1(')
    && webhook.includes("error: 'DRIVER_TELEGRAM_CURRENT_AUTHORITY_REQUIRED'")
    // The Bot runtime transport is proven against configuration. Comparing it to
    // the shared Chat's stored binding is the defect this boundary now forbids:
    // that binding may legitimately name the MTProto personal account.
    && webhook.includes('connectionId !== canonicalTelegramBotConnectionIdV1()')
    && !webhook.includes('authority.providerAccountId !== providerAccountId')
    && !webhook.includes('authority.connectionId !== connectionId')
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
  'generic phone ingress links only a unique verified local match',
  // Owner decision 2026-10-28: the driver's own verified number may link the
  // bot by itself, never by a first result: only the single unlinked local
  // Driver profile it names exactly, and never a provider search.
  syncUserStart >= 0
    && uniqueMatchStart >= 0
    && !/listYandexConnectionCredentialsV1|replaceDriverTelegramLinkV1|saveManualDriverTelegramLinkV1/.test(syncUser + uniqueMatch)
    && !/\bfetch\s*\(/u.test(syncUser + uniqueMatch)
    && (syncUser.match(/upsertDriverTelegramLinkV1\(/g) || []).length === 1
    && syncUser.includes('if (existingLink?.driverId) {')
    && syncUser.indexOf('if (existingLink?.driverId) {') < syncUser.indexOf('if (hasContactOwnershipEvidence) {')
    && syncUser.indexOf('if (hasContactOwnershipEvidence) {') < syncUser.indexOf('uniqueUnlinkedDriverForPhone(')
    && syncUser.indexOf('uniqueUnlinkedDriverForPhone(') < syncUser.indexOf('upsertDriverTelegramLinkV1(')
    && syncUser.includes("const phone = typeof input.phone === 'string' ? input.phone.trim() : ''")
    && (syncUser.match(/uniqueUnlinkedDriverForPhone\(/g) || []).length === 1
    && syncUser.includes('const match = await uniqueUnlinkedDriverForPhone(phone)')
    && syncUser.indexOf('upsertDriverTelegramLinkV1(') < syncUser.indexOf('recordPendingBotLinkRequestV1')
    && uniqueMatch.includes('if (matches.length !== 1) return null')
    && uniqueMatch.includes('where: { driverId: row.id }')
    && uniqueMatch.includes("row.personResolutionStatus === 'conflict'")
    // The shared number is read only in its international Russian form.
    && telegramPhoneStart >= 0
    && telegramPhone.includes("return digits.length === 11 && digits[0] === '7' ? digits : null")
    && (telegramPhone.match(/return /g) || []).length === 1
    && uniqueMatch.includes('const exact = telegramRussianPhone(phone)')
    && uniqueMatch.includes('const matches = rows.filter(row => exactRussianPhone(row.phone) === exact)')
    && uniqueMatch.includes('dismissedAt: null')
    && uniqueMatch.includes('if (!parkId || !yandexContractorProfileId(row)')
    && uniqueMatch.includes('return taken ? null :')
    && !/\btake\s*:/.test(uniqueMatch)
    // One link writer in the whole webhook, inside sync_user.
    && (webhook.match(/upsertDriverTelegramLinkV1\(/g) || []).length === 1
    && webhook.indexOf('upsertDriverTelegramLinkV1(') > syncUserStart
    && webhook.indexOf('upsertDriverTelegramLinkV1(') < syncUserStart + syncUser.length,
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
