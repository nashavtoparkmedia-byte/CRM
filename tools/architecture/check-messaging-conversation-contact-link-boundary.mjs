#!/usr/bin/env node
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const read = file => fs.readFileSync(file, 'utf8')
const sha = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const checks = []
const failures = []
const check = (name, value, detail) => value
  ? checks.push(name)
  : failures.push({ check: name, detail })
const sliceBetween = (source, startMarker, endMarker) => {
  const start = source.indexOf(startMarker)
  if (start < 0) return ''
  const end = endMarker === null ? source.length : source.indexOf(endMarker, start + startMarker.length)
  return end < 0 ? '' : source.slice(start, end)
}
const walk = directory => fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
  const absolute = path.join(directory, entry.name)
  return entry.isDirectory() ? walk(absolute) : (/\.tsx?$/.test(entry.name) ? [absolute] : [])
})

const contract = read('gravity-mvp/src/contracts/messaging/v1/conversation-contact-link-command.ts')
const contractIndex = read('gravity-mvp/src/contracts/messaging/v1/index.ts')
const handler = read('gravity-mvp/src/modules/messaging/public/v1/conversation-contact-link-handler.ts')
const adapter = read('gravity-mvp/src/modules/messaging/public/v1/legacy-prisma-conversation-contact-link-adapter.ts')
const publicIndex = read('gravity-mvp/src/modules/messaging/public/v1/index.ts')
const contactService = read('gravity-mvp/src/lib/ContactService.ts')
const amendmentPath = 'architecture/isolation/messaging/conversation-contact-link-v1/module-manifest-amendments.json'
const amendment = JSON.parse(read(amendmentPath))
const migration = JSON.parse(read('architecture/isolation/messaging/conversation-contact-link-v1/migration-manifest.json'))
const verification = JSON.parse(read('architecture/isolation/messaging/conversation-contact-link-v1/verification.json'))
const behavior = JSON.parse(read('architecture/isolation/messaging/conversation-contact-link-v1/BEHAVIOR-FREEZE.json'))
const policy = JSON.parse(read('architecture/enforcement/v1/policy.json'))
const registry = JSON.parse(read('architecture/enforcement/v1/exceptions.json'))
const sourceFiles = walk('gravity-mvp/src')
const sources = new Map(sourceFiles.map(file => [file, read(file)]))
const consumers = [
  'gravity-mvp/src/app/messages/link-chat-actions.ts',
  'gravity-mvp/src/lib/whatsapp/WhatsAppService.ts',
  'gravity-mvp/src/app/api/messages/start-chat/route.ts',
  'gravity-mvp/src/app/api/webhook/telegram/route.ts',
  'gravity-mvp/src/app/tg-actions.ts',
  'gravity-mvp/src/app/api/webhook/max/route.ts',
  'gravity-mvp/src/app/api/webhooks/max/route.ts',
]
const consumerSource = consumers.map(file => sources.get(file)).join('\n')
const ensureBody = sliceBetween(adapter, 'async ensure(input)', '\n  },\n}')
const portSource = sliceBetween(handler, 'export interface ConversationContactLinkPersistencePortV1', 'export function')
const commandBodies = [...consumerSource.matchAll(/ensureConversationContactLinkV1\(\{([\s\S]*?)\}\)/g)]
  .map(match => match[1])

check(
  'contract and handler are provider and infrastructure neutral',
  !/(prisma|next\/|@\/lib|@\/app|whatsapp|telegram|max-bot|modesl)/i.test(contract + handler),
  'public boundary leaks infrastructure or provider details',
)
check(
  'command and result identities are exact versioned literals',
  contract.includes("'messaging.EnsureConversationContactLinkCommand.v1' as const") &&
    contract.includes("'messaging.EnsureConversationContactLinkResult.v1' as const") &&
    contract.includes('completed: true'),
  'versioned command/result identity drift',
)
check(
  'command exposes only the exact three identifiers',
  contract.includes("const supportedFields = ['contract', 'chatId', 'contactId', 'contactIdentityId']") &&
    !/(patch|table|sql|predicate|whereClause|transaction|select|include|orderBy|page|driverId)/i.test(
      sliceBetween(contract, 'export interface EnsureConversationContactLinkCommandV1', 'export interface EnsureConversationContactLinkResultV1'),
    ),
  'generic persistence or owner policy leaked into the command',
)
check(
  'strict parser rejects extras versions and empty identifiers',
  contract.includes('Object.keys(input).filter') &&
    contract.includes("startsWith('messaging.EnsureConversationContactLinkCommand.')") &&
    contract.includes("input[field].trim() === ''") &&
    contract.includes("['chatId', 'contactId', 'contactIdentityId'] as const"),
  'strict parser coverage drift',
)
check(
  'one named port owns only the exact link operation',
  handler.includes('export interface ConversationContactLinkPersistencePortV1') &&
    (portSource.match(/\bensure\(/g) || []).length === 1 &&
    !/(find|read|query|patch|delete|create|transaction)\(/.test(portSource),
  'port widened beyond the exact use case',
)
check(
  'handler parses before one port call and returns the exact result',
  handler.indexOf('parseEnsureConversationContactLinkCommandV1(command)') < handler.indexOf('await port.ensure({') &&
    (handler.match(/await port\.ensure/g) || []).length === 1 &&
    handler.includes('contract: ENSURE_CONVERSATION_CONTACT_LINK_RESULT_V1') &&
    handler.includes('completed: true') &&
    !/\b(?:try|catch)\b/.test(handler),
  'handler mapping, result or failure visibility drift',
)
check(
  'public facade binds only the owner adapter and indexes export the contract',
  contractIndex.includes("export * from './conversation-contact-link-command'") &&
    publicIndex.includes('createEnsureConversationContactLinkHandlerV1') &&
    publicIndex.includes('legacyPrismaConversationContactLinkPortV1') &&
    publicIndex.includes('ensureConversationContactLinkV1=createEnsureConversationContactLinkHandlerV1(legacyPrismaConversationContactLinkPortV1)'),
  'contract export or owner binding drift',
)
check(
  'owner reads Chat then Contact then Driver with exact projections',
  ensureBody.indexOf('prisma.chat.findUnique({') < ensureBody.indexOf('prisma.contact.findUnique({') &&
    ensureBody.indexOf('prisma.contact.findUnique({') < ensureBody.indexOf('prisma.driver.findUnique({') &&
    ensureBody.includes('where: { id: input.chatId }') &&
    ensureBody.includes('select: { driverId: true }') &&
    ensureBody.includes('where: { id: input.contactId }') &&
    ensureBody.includes('select: { yandexDriverId: true }') &&
    ensureBody.includes('where: { yandexDriverId: contact.yandexDriverId }') &&
    ensureBody.includes('select: { id: true }'),
  'owner read order, predicates or projections drift',
)
check(
  'driver enrichment preserves inherited truthy short circuits',
  ensureBody.includes('if (chat && !chat.driverId)') &&
    ensureBody.includes('if (contact?.yandexDriverId)') &&
    ensureBody.includes('if (driver) updateData.driverId = driver.id'),
  'driver lookup or preservation semantics drift',
)
check(
  'missing Chat still reaches one exact update',
  (ensureBody.match(/prisma\.chat\.update\(/g) || []).length === 1 &&
    ensureBody.indexOf('await prisma.chat.update({') > ensureBody.indexOf('if (chat && !chat.driverId)') &&
    ensureBody.includes('where: { id: input.chatId }') &&
    ensureBody.includes('data: updateData'),
  'missing-Chat behavior or final update mapping drift',
)
check(
  'base link fields are always set and driverId remains optional',
  adapter.includes('contactId: input.contactId') &&
    adapter.includes('contactIdentityId: input.contactIdentityId') &&
    adapter.includes('driverId?: string') &&
    !adapter.includes('driverId: chat.driverId'),
  'contact link or existing driver preservation drift',
)
check(
  'owner adds no transaction retry logging or generic escape hatch',
  !/(\$transaction|Promise\.all|console\.|catch\s*\(|retry|sleep|setTimeout|\$queryRaw|\$executeRaw|RawUnsafe)/.test(adapter) &&
    !/(tableName|sql|predicate|whereClause|transaction|select|include|orderBy|page)\s*:/i.test(contract + portSource),
  'owner acquired forbidden orchestration or generic capacity',
)
check(
  'Contacts compatibility method is removed without reverse dependency',
  !/ensureChatLinked/.test(contactService) &&
    !/from\s*['"]@\/(?:contracts|modules)\/messaging\//.test(contactService),
  'Contacts wrapper or Contacts-to-Messaging import remains',
)
check(
  'exactly twelve calls exist across the seven accepted consumers',
  (consumerSource.match(/await ensureConversationContactLinkV1\(\{/g) || []).length === 12 &&
    consumers.every(file => sources.get(file).includes('ensureConversationContactLinkV1')) &&
    [...sources.entries()]
      .filter(([file, source]) => source.includes('ensureConversationContactLinkV1') && !file.includes('/modules/messaging/public/v1/'))
      .every(([file]) => consumers.includes(file)),
  'consumer population or awaited call count drift',
)
check(
  'all consumer commands use the exact mapping with no generic fields',
  commandBodies.length === 12 &&
    commandBodies.every(body => (body.match(/contract: ENSURE_CONVERSATION_CONTACT_LINK_COMMAND_V1/g) || []).length === 1) &&
    commandBodies.every(body => (body.match(/contactId: contactResult\.contact\.id/g) || []).length === 1) &&
    commandBodies.every(body => (body.match(/contactIdentityId: contactResult\.identity\.id/g) || []).length === 1) &&
    !/(patch:|driverId:|tableName:|sql:|transaction:)/.test(
      commandBodies.join('\n'),
    ),
  'consumer payload mapping widened or drifted',
)
check(
  'legacy method references are absent from all source',
  [...sources.values()].every(source => !/ContactService\s*\.\s*ensureChatLinked\b|static\s+async\s+ensureChatLinked\b/.test(source)),
  'legacy call or definition remains',
)
check(
  'the signed baseline retirement remains explicitly bounded to one site',
  'arch_3a32113e59d6d5250460be8d'.length === 29 &&
    adapter.includes('prisma.chat.update') &&
    !contactService.includes('prisma.chat.update'),
  'planned single-site relocation boundary drift',
)
check(
  'manifest amendment exposes only the exact owner command without a dependency amendment',
  amendment.amendments?.length === 1 &&
    amendment.amendments[0].context === 'messaging' &&
    JSON.stringify(amendment.amendments[0].add_commands) === JSON.stringify([
      'EnsureConversationContactLinkCommand.v1',
    ]) &&
    amendment.amendments[0].add_public_surface === undefined &&
    amendment.amendments[0].add_allowed_dependencies === undefined,
  'manifest amendment widened or added a dependency',
)
check(
  'strict policy and migration bind the slice to the accepted manager-health parent',
  policy.manifest_amendments.includes(amendmentPath) &&
    policy.registry_milestone === 'CRM-ARCH-007R-CONVERSATION-CONTACT-LINK' &&
    policy.registry_base_commit === '9765eb7202bfe07aa54e137d5e96c8d728c0372f' &&
    migration.base_commit === '9765eb7202bfe07aa54e137d5e96c8d728c0372f' &&
    migration.source_commit === '3c59b2733a6032a7cb1f02be3c42af8a13a0f3ab',
  'policy or evidence identity drift',
)
check(
  'exact current strict registry retires only the accepted write without owner-local replacement capacity',
  registry.milestone === 'CRM-ARCH-007R-CONVERSATION-CONTACT-LINK' &&
    registry.base_commit === '9765eb7202bfe07aa54e137d5e96c8d728c0372f' &&
    registry.finding_digest === '5b21c2b965d736b5451a92a56fb6dfb4dff17c179919b25a795c7ed584349e73' &&
    registry.exceptions.length === 1407 &&
    registry.summary?.direct_foreign_prisma_write === 84 &&
    registry.summary?.direct_provider_transport_access === 38 &&
    registry.summary?.internal_module_import === 379 &&
    registry.summary?.non_public_cross_context_import === 536 &&
    registry.summary?.undeclared_dependency === 370 &&
    !registry.exceptions.some(entry => entry.fingerprint === 'arch_3a32113e59d6d5250460be8d') &&
    !registry.exceptions.some(entry => entry.file.includes('legacy-prisma-conversation-contact-link-adapter.ts')),
  'strict registry identity, counts or owner-local classification drift',
)
check(
  'verified registry evidence preserves the exact one-removal zero-addition comparison',
  migration.enforcement?.baseline_findings === 1408 &&
    migration.enforcement?.actual_findings === 1407 &&
    migration.enforcement?.actual_direct_foreign_prisma_write === 84 &&
    migration.enforcement?.actual_removed === 1 &&
    migration.enforcement?.actual_added === 0 &&
    migration.enforcement?.actual_changed_shared_entries === 0 &&
    migration.enforcement?.finding_digest === '5b21c2b965d736b5451a92a56fb6dfb4dff17c179919b25a795c7ed584349e73' &&
    migration.enforcement?.registry_sha256 === '26d55bc9013a72c23670aefa99ae1202ead65b36182159d31e4707ac8e645cd0' &&
    migration.enforcement?.registry_deterministic === true,
  'verified registry comparison drift',
)
check(
  'behavior hashes and verification retain the frozen source-only non-execution boundary',
  behavior.source_commit === '3c59b2733a6032a7cb1f02be3c42af8a13a0f3ab' &&
    behavior.legacy_owner_before_sha256 === '25a35f2e8306a84cab4f6976abb0ae09550c203d7faef2d4f5fbc0032fa53659' &&
    behavior.legacy_owner_after_sha256 === sha('gravity-mvp/src/lib/ContactService.ts') &&
    behavior.consumer_hashes?.length === 7 &&
    behavior.consumer_hashes.every(entry => sha(entry.file) === entry.after) &&
    verification.database_accessed === false &&
    verification.conversation_link_executed_against_database === false &&
    verification.webhooks_or_providers_invoked === false &&
    verification.production_mutated === false &&
    verification.secret_values_read_or_emitted === false,
  'source hash or non-execution evidence drift',
)

process.stdout.write(`${JSON.stringify({
  status: failures.length > 0 ? 'FAIL' : 'PASS',
  checks,
  failures,
}, null, 2)}\n`)
if (failures.length > 0) process.exitCode = 1
