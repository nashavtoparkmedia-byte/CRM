#!/usr/bin/env node
import fs from 'node:fs'

const read = file => fs.readFileSync(file, 'utf8')
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
const parseBeforePort = (body, parseCall, portCall) => {
  const parse = body.indexOf(parseCall)
  const port = body.indexOf(portCall)
  return parse >= 0 && port > parse &&
    (body.match(new RegExp(parseCall, 'g')) || []).length === 1 &&
    (body.match(new RegExp(portCall.replace('.', '\\.'), 'g')) || []).length === 1
}

const contactsContract = read('gravity-mvp/src/contracts/contacts/v1/contact-retention-command.ts')
const messagingContract = read('gravity-mvp/src/contracts/messaging/v1/contact-retention-command.ts')
const workContract = read('gravity-mvp/src/contracts/work-management/v1/contact-retention-command.ts')
const contactsHandler = read('gravity-mvp/src/modules/contacts/public/v1/contact-retention-handler.ts')
const messagingHandler = read('gravity-mvp/src/modules/messaging/public/v1/contact-retention-handler.ts')
const workHandler = read('gravity-mvp/src/modules/work-management/public/v1/contact-retention-handler.ts')
const contactsAdapter = read('gravity-mvp/src/modules/contacts/public/v1/legacy-prisma-contact-retention-adapter.ts')
const messagingAdapter = read('gravity-mvp/src/modules/messaging/public/v1/legacy-prisma-contact-retention-adapter.ts')
const workAdapter = read('gravity-mvp/src/modules/work-management/public/v1/legacy-prisma-contact-retention-adapter.ts')
const contactsIndex = read('gravity-mvp/src/modules/contacts/public/v1/index.ts')
const messagingIndex = read('gravity-mvp/src/modules/messaging/public/v1/index.ts')
const workIndex = read('gravity-mvp/src/modules/work-management/public/v1/index.ts')
const consumer = read('gravity-mvp/src/lib/RetentionCleanup.ts')
const amendmentPath = 'architecture/isolation/operations-observability/archived-contact-purge-v1/module-manifest-amendments.json'
const amendment = JSON.parse(read(amendmentPath))
const policy = JSON.parse(read('architecture/enforcement/v1/policy.json'))
const registry = JSON.parse(read('architecture/enforcement/v1/exceptions.json'))
const contracts = contactsContract + messagingContract + workContract
const handlers = contactsHandler + messagingHandler + workHandler
const adapters = contactsAdapter + messagingAdapter + workAdapter
const contactsBody = sliceBetween(contactsHandler, 'return async function deleteContactForRetentionV1', null)
const messagingBody = sliceBetween(messagingHandler, 'return async function detachContactConversationsV1', null)
const workBody = sliceBetween(workHandler, 'return async function detachContactTasksV1', null)
const archivedMethod = sliceBetween(consumer, 'private static async _cleanupArchivedContacts', null)
const dependencyRead = sliceBetween(archivedMethod, 'const deps = await prisma.$queryRaw', 'const dep = deps[0]')
const mutationBlock = sliceBetween(archivedMethod, 'if (!dryRun) {', 'deleted++')
const archivedPhase = sliceBetween(consumer, '// 7. Archived contacts', '} catch (err: any)')

check(
  'contracts and handlers remain infrastructure neutral',
  !/(prisma|next\/|@\/lib|@\/app)/i.test(contracts + handlers),
  'public contract or handler leaks infrastructure',
)
check(
  'literal command and result identities exact',
  contactsContract.includes("'contacts.DeleteContactForRetentionCommand.v1'") &&
    contactsContract.includes("'contacts.DeleteContactForRetentionResult.v1'") &&
    messagingContract.includes("'messaging.DetachContactConversationsCommand.v1'") &&
    messagingContract.includes("'messaging.DetachContactConversationsResult.v1'") &&
    workContract.includes("'work_management.DetachContactTasksCommand.v1'") &&
    workContract.includes("'work_management.DetachContactTasksResult.v1'"),
  'public identity drift',
)
check(
  'contracts expose only contract and contactId',
  (contracts.match(/!\['contract', 'contactId'\]\.includes\(key\)/g) || []).length === 3 &&
    (contracts.match(/contactId: string/g) || []).length === 3 &&
    !/(callContactId|contactIdentityId|dryRun|transaction|sql|predicate)/.test(contracts),
  'contract field scope widened',
)
check(
  'each concrete handler parses before its exact port',
  parseBeforePort(contactsBody, 'parseDeleteContactForRetentionCommandV1', 'port.deleteContactForRetention') &&
    parseBeforePort(messagingBody, 'parseDetachContactConversationsCommandV1', 'port.detachContactConversations') &&
    parseBeforePort(workBody, 'parseDetachContactTasksCommandV1', 'port.detachContactTasks'),
  'handler parse/port order drift',
)
check(
  'handlers return exact completed results and expose owner failure',
  (handlers.match(/completed: true/g) || []).length === 3 &&
    !/\b(?:try|catch)\b/.test(handlers + adapters),
  'handler result or failure propagation drift',
)
check(
  'public indexes bind all three owner adapters',
  contactsIndex.includes('deleteContactForRetentionV1 = createDeleteContactForRetentionHandlerV1(legacyPrismaContactRetentionPortV1)') &&
    messagingIndex.includes('detachContactConversationsV1=createDetachContactConversationsHandlerV1(legacyPrismaContactConversationRetentionPortV1)') &&
    workIndex.includes('detachContactTasksV1 = createDetachContactTasksHandlerV1(legacyPrismaContactTaskRetentionPortV1)'),
  'owner public binding missing',
)
check(
  'Messaging detach keeps exact literal positional SQL',
  messagingAdapter.includes("'UPDATE \"Chat\" SET \"contactId\" = NULL, \"contactIdentityId\" = NULL WHERE \"contactId\" = $1'") &&
    messagingAdapter.includes('prisma.$executeRawUnsafe(') &&
    !/\$executeRaw`|updateMany|\bOR\b|"contactIdentityId"\s*=\s*\$1/.test(messagingAdapter),
  'Messaging detach broadened scope or changed raw execution semantics',
)
check(
  'Work detach keeps exact literal positional SQL',
  workAdapter.includes("'UPDATE \"tasks\" SET \"contactId\" = NULL WHERE \"contactId\" = $1'") &&
    workAdapter.includes('prisma.$executeRawUnsafe(') &&
    !/\$executeRaw`|updateMany|\bOR\b/.test(workAdapter),
  'Work detach broadened scope or changed raw execution semantics',
)
check(
  'Contacts typed deleteMany preserves zero-row success',
  contactsAdapter.includes('await prisma.contact.deleteMany({ where: { id: contactId } })') &&
    !/\.delete\(|\$(?:query|execute)Raw|\.count|throw/.test(contactsAdapter),
  'Contacts adapter changed missing-row completion semantics',
)
check(
  'archived candidate read exact and equal-time order unspecified',
  archivedMethod.includes('WHERE "isArchived" = true') &&
    archivedMethod.includes('"updatedAt" < (NOW() AT TIME ZONE \'UTC\') - CAST(${ageDays + \' days\'} AS INTERVAL)') &&
    archivedMethod.includes('ORDER BY "updatedAt" ASC') &&
    archivedMethod.includes('LIMIT ${limit}') &&
    !/ORDER BY "updatedAt" ASC[^\n]*(?:,|\bid\b)/.test(archivedMethod),
  'candidate selection or equal-time ordering drift',
)
check(
  'dependency read remains Chat Message ContactMerge only',
  dependencyRead.includes('FROM "Chat" WHERE "contactId" = ${id} AND status != \'resolved\'') &&
    dependencyRead.includes('FROM "Message" m') &&
    dependencyRead.includes('JOIN "Chat" c ON c.id = m."chatId"') &&
    dependencyRead.includes('WHERE c."contactId" = ${id}') &&
    dependencyRead.includes("INTERVAL '30 days'") &&
    dependencyRead.includes('FROM "ContactMerge" WHERE "survivorId" = ${id} OR "mergedId" = ${id}') &&
    !/\bCall\b|ContactIdentity|inconsistent/i.test(dependencyRead),
  'dependency safety scope broadened',
)
check(
  'skip accounting retains the exact three dependency classes',
  archivedMethod.includes('if (dep.activeChats > 0 || dep.recentMessages > 0 || dep.merges > 0)') &&
    archivedMethod.indexOf('skipped++') < archivedMethod.indexOf('continue'),
  'skip predicate or count drift',
)
check(
  'real mutation order remains Messaging then Work then Contacts',
  mutationBlock.length > 0 &&
    mutationBlock.indexOf('await detachContactConversationsV1') < mutationBlock.indexOf('await detachContactTasksV1') &&
    mutationBlock.indexOf('await detachContactTasksV1') < mutationBlock.indexOf('await deleteContactForRetentionV1') &&
    (mutationBlock.match(/\bawait\b/g) || []).length === 3 &&
    !/Promise\.all|\$transaction|\b(?:try|catch)\b/.test(mutationBlock),
  'nontransactional owner sequence drift',
)
check(
  'dry run and missing final row preserve deleted count behavior',
  archivedMethod.indexOf('if (!dryRun) {') < archivedMethod.indexOf('await detachContactConversationsV1') &&
    archivedMethod.indexOf('await deleteContactForRetentionV1') < archivedMethod.indexOf('deleted++') &&
    (archivedMethod.match(/deleted\+\+/g) || []).length === 1,
  'dry-run or successful zero-row count behavior drift',
)
check(
  'deadline remains between phases only',
  (archivedPhase.match(/if \(!checkTimeout\(\)\)/g) || []).length === 1 &&
    archivedPhase.indexOf('if (!checkTimeout())') < archivedPhase.indexOf('await this._cleanupArchivedContacts') &&
    !archivedMethod.includes('checkTimeout'),
  'deadline moved inside the archived-contact loop or phase guard vanished',
)
check(
  'outer result assignment remains after complete workflow return',
  archivedPhase.indexOf('const contactResult = await this._cleanupArchivedContacts') <
    archivedPhase.indexOf('result.deletedArchivedContacts = contactResult.deleted') &&
    archivedPhase.indexOf('result.deletedArchivedContacts = contactResult.deleted') <
    archivedPhase.indexOf('result.skippedContacts = contactResult.skipped'),
  'partial workflow failure could publish contact counts',
)
check(
  'consumer no longer performs the three foreign writes directly',
  !consumer.includes('UPDATE "Chat" SET "contactId" = NULL') &&
    !consumer.includes('UPDATE "tasks" SET "contactId" = NULL') &&
    !consumer.includes('DELETE FROM "Contact"') &&
    !consumer.includes('prisma.contact.delete'),
  'direct foreign archived-contact write remains',
)
check(
  'owner commands and two direct Operations dependencies are exact',
  amendment.amendments?.length === 4 &&
    amendment.amendments[0].context === 'messaging' &&
    JSON.stringify(amendment.amendments[0].add_commands) === JSON.stringify(['DetachContactConversationsCommand.v1']) &&
    amendment.amendments[1].context === 'work_management' &&
    JSON.stringify(amendment.amendments[1].add_commands) === JSON.stringify(['DetachContactTasksCommand.v1']) &&
    amendment.amendments[2].context === 'contacts' &&
    JSON.stringify(amendment.amendments[2].add_commands) === JSON.stringify(['DeleteContactForRetentionCommand.v1']) &&
    amendment.amendments[3].context === 'operations_observability' &&
    JSON.stringify(amendment.amendments[3].add_allowed_dependencies) === JSON.stringify([
      { context: 'work_management', surface: 'work_management.public' },
      { context: 'contacts', surface: 'contacts.public' },
    ]),
  'manifest amendment widened or drifted',
)
check(
  'strict policy binds archived-contact milestone to event-retention parent',
  policy.manifest_amendments.includes(amendmentPath) &&
    policy.registry_milestone === 'CRM-ARCH-007R-ARCHIVED-CONTACT-PURGE' &&
    policy.registry_base_commit === 'fb16db6ef7759c4a1bd73e0012485a5e6777a03a',
  'policy identity drift',
)
check(
  'exact three writes and seven redundant dependency findings retire with no new capacity',
  registry.summary?.direct_foreign_prisma_write === 96 &&
    registry.summary?.undeclared_dependency === 370 &&
    registry.exceptions.length === 1419 &&
    [
      'arch_268626904318c85d53361d4e',
      'arch_76d3bcc4d7b0267149f18cf2',
      'arch_b5f33a4a29e14f22da9a05ec',
      'arch_2f0731db82ab64962a25bd42',
      'arch_3afb0d0704ed7e43a95d098b',
      'arch_4a9d0523cce679b947b0263d',
      'arch_63ba5b4a4669d613e6cd16f1',
      'arch_7650208958f7be1610e5230d',
      'arch_9310b6d863a190924cf95bd2',
      'arch_f04a8b9f2910b9c345227d1f',
    ].every(fingerprint => !registry.exceptions.some(entry => entry.fingerprint === fingerprint)) &&
    !registry.exceptions.some(entry =>
      entry.file === 'gravity-mvp/src/lib/RetentionCleanup.ts' || entry.file.includes('contact-retention'),
    ) &&
    [
      'gravity-mvp/src/app/api/cron/auto-close-tasks/route.ts',
      'gravity-mvp/src/app/api/cron/sla-escalation/route.ts',
      'gravity-mvp/src/app/api/health/route.ts',
      'gravity-mvp/src/app/api/cron/enforce-followup/route.ts',
      'gravity-mvp/src/app/monitoring/system-health/actions.ts',
      'gravity-mvp/src/app/api/cron/pattern-alerts/route.ts',
      'gravity-mvp/src/app/api/cron/escalations/route.ts',
    ].every(file => registry.exceptions.some(entry =>
      entry.file === file && entry.rule === 'non_public_cross_context_import',
    )),
  'registry delta, owner classification, or retained non-public protection drift',
)

process.stdout.write(`${JSON.stringify({
  status: failures.length > 0 ? 'FAIL' : 'PASS',
  checks,
  failures,
}, null, 2)}\n`)
if (failures.length > 0) process.exitCode = 1
