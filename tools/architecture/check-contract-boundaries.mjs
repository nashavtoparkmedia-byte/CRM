#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'

import { extractPrismaWrites } from './enforce-architecture.mjs'

const root = process.cwd()
const failures = []
const checks = []

function source(relative) {
    return fs.readFileSync(path.join(root, relative), 'utf8')
}

function assertCheck(name, condition, detail) {
    if (condition) checks.push(name)
    else failures.push({ check: name, detail })
}

const contractRoot = path.join(root, 'gravity-mvp/src/contracts')
const contractFiles = []
function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const candidate = path.join(directory, entry.name)
        if (entry.isDirectory()) walk(candidate)
        else if (/\.ts$/.test(entry.name)) contractFiles.push(candidate)
    }
}
walk(contractRoot)

const forbiddenContractImports = [
    /from\s+['"]@\/lib\//,
    /from\s+['"]@prisma\//,
    /from\s+['"].*\/app\//,
    /from\s+['"].*\/providers?\//,
]

for (const file of contractFiles) {
    const body = fs.readFileSync(file, 'utf8')
    assertCheck(
        `provider-neutral contract: ${path.relative(root, file)}`,
        forbiddenContractImports.every((pattern) => !pattern.test(body)),
        'contract imports a persistence, framework, application, or provider implementation',
    )
}

const consumerFiles = [
    'gravity-mvp/src/app/api/ai-calls/mock/route.ts',
    'gravity-mvp/src/app/api/ai-calls/sessions/[id]/finalize/route.ts',
]

for (const file of consumerFiles) {
    const body = source(file)
    assertCheck(
        `representative consumer uses CreateTaskCommand.v1: ${file}`,
        body.includes('CREATE_TASK_COMMAND_V1') && body.includes('createTaskV1({'),
        'versioned command invocation is absent',
    )
    assertCheck(
        `foreign Task write removed: ${file}`,
        !/prisma\.task\.create\s*\(/.test(body),
        'direct foreign Prisma Task create remains',
    )
}

const reassignmentConsumer = source('gravity-mvp/src/app/api/tasks/reassign/route.ts')
assertCheck(
    'representative reassignment route uses ReassignTasksCommand.v1',
    reassignmentConsumer.includes('REASSIGN_TASKS_COMMAND_V1')
        && reassignmentConsumer.includes('taskReassignmentV1.reassignTasks({'),
    'versioned batch assignment command invocation is absent',
)
assertCheck(
    'foreign Task update removed from reassignment route',
    !/prisma\.task\.update\s*\(/.test(reassignmentConsumer),
    'direct foreign Prisma Task update remains',
)
assertCheck(
    'reassignment route does not import owner-internal task event service',
    !reassignmentConsumer.includes("from '@/lib/tasks/task-event-service'"),
    'owner-internal task event import remains',
)

const inboxConsumer = source('gravity-mvp/src/app/inbox/actions.ts')
assertCheck(
    'representative Messaging consumer uses CompleteTaskCommand.v1',
    inboxConsumer.includes('COMPLETE_TASK_COMMAND_V1')
        && inboxConsumer.includes('completeTaskV1({'),
    'versioned completion command invocation is absent',
)
assertCheck(
    'foreign ManagerTask update removed from Messaging consumer',
    !/prisma\.managerTask\.update\s*\(/.test(inboxConsumer),
    'direct foreign Prisma ManagerTask update remains',
)

const maxContactConsumer = source('gravity-mvp/src/app/api/webhook/max/sync-names/route.ts')
assertCheck(
    'representative MAX consumer uses ResolveContactCommand.v1',
    maxContactConsumer.includes('RESOLVE_CONTACT_COMMAND_V1')
        && maxContactConsumer.includes('resolveContactV1({'),
    'versioned contact-resolution command invocation is absent',
)
assertCheck(
    'foreign Contact update removed from MAX consumer',
    !/prisma\.contact\.update\s*\(/.test(maxContactConsumer),
    'direct foreign Prisma Contact update remains',
)

const telegramIdentityConsumer = source('gravity-mvp/src/app/api/webhook/telegram/route.ts')
assertCheck('representative Telegram consumer uses AttachContactIdentityCommand.v1', telegramIdentityConsumer.includes('ATTACH_CONTACT_IDENTITY_COMMAND_V1') && telegramIdentityConsumer.includes('attachContactIdentityV1({'), 'versioned identity command absent')
assertCheck('foreign ContactIdentity update removed from Telegram consumer', !/prisma\.contactIdentity\.update\s*\(/.test(telegramIdentityConsumer), 'direct ContactIdentity update remains')
assertCheck('Telegram channel-name consumer uses ResolveContactCommand.v2', telegramIdentityConsumer.includes('RESOLVE_CONTACT_COMMAND_V2') && telegramIdentityConsumer.includes('resolveContactV2({'), 'versioned v2 contact command absent')
assertCheck('foreign Contact update removed from Telegram consumer', !/prisma\.contact\.update\s*\(/.test(telegramIdentityConsumer), 'direct Contact update remains')
const attentionConsumer=source('gravity-mvp/src/app/api/monitoring/attention/[id]/route.ts')
assertCheck('Operations consumer uses UpdateDriverStateCommand.v1',attentionConsumer.includes('UPDATE_DRIVER_STATE_COMMAND_V1')&&attentionConsumer.includes('updateDriverStateV1({'),'fleet owner command absent')
assertCheck('foreign DriverAttention update removed',!/prisma\.driverAttention\.update/.test(attentionConsumer),'direct DriverAttention update remains')
const scoringConsumer=source('gravity-mvp/src/app/settings/scoring/actions.ts')
assertCheck('Configuration consumer uses UpdateScoringThresholdsCommand.v1',scoringConsumer.includes('UPDATE_SCORING_THRESHOLDS_COMMAND_V1')&&scoringConsumer.includes('updateScoringThresholdsV1({'),'Fleet scoring command absent')
assertCheck('foreign ScoringThreshold upsert removed',!/prisma\.scoringThreshold\.upsert/.test(scoringConsumer),'direct ScoringThreshold upsert remains')
const manualLinkConsumer=source('gravity-mvp/src/app/messages/link-chat-actions.ts')
assertCheck('Messaging manual-link consumer uses SetContactDisplayNameCommand.v1',manualLinkConsumer.includes('SET_CONTACT_DISPLAY_NAME_COMMAND_V1')&&manualLinkConsumer.includes('setContactDisplayNameV1({'),'Contacts display-name command absent')
assertCheck('foreign manual-link Contact update removed',!/prisma\.contact\.update/.test(manualLinkConsumer),'direct manual-link Contact update remains')
const contactMergeFacade=source('gravity-mvp/src/lib/ContactMergeService.ts')
assertCheck('Contacts merge facade uses MergeContactsCommand.v1',contactMergeFacade.includes('MERGE_CONTACTS_COMMAND_V1')&&contactMergeFacade.includes('mergeContactsV1({'),'Contacts merge owner command absent')
assertCheck('foreign Chat and Task writes removed from Contacts merge facade',!/(?:prisma|transaction)\.(?:chat|task)\.(?:create|createMany|update|updateMany|upsert|delete|deleteMany)/.test(contactMergeFacade),'direct foreign merge write remains')
const communicationConsumer=source('gravity-mvp/src/app/drivers/[id]/timeline-actions.ts')
assertCheck('Fleet timeline consumer uses RecordDriverDailyActivityCommand.v1',communicationConsumer.includes('RECORD_DRIVER_DAILY_ACTIVITY_COMMAND_V1')&&communicationConsumer.includes('recordDriverDailyActivityV1({'),'Fleet daily-activity command absent')
assertCheck('direct DriverDaySummary upsert remains absent',!/prisma\.driverDaySummary\.upsert/.test(communicationConsumer),'direct DriverDaySummary upsert remains')
assertCheck('driver communication history stays inside Fleet public capabilities',communicationConsumer.includes('recordDriverCommunicationEventV1({')&&!communicationConsumer.includes('@/modules/messaging'),'communication history owner drift')
const inboxFleetConsumer=source('gravity-mvp/src/app/inbox/InboxClient.tsx')
const managerCommunicationRoutePath='gravity-mvp/src/app/api/platform/drivers/[id]/manager-communication/route.ts'
if(fs.existsSync(path.join(root,managerCommunicationRoutePath))){
    const managerCommunicationRoute=source(managerCommunicationRoutePath)
    assertCheck('Inbox uses Platform manager-communication successor',inboxFleetConsumer.includes('/manager-communication`')&&inboxFleetConsumer.includes('recordManagerCommunication(task.driverId, "call")'),'Platform manager-call delivery absent')
    assertCheck('Platform successor invokes manager communication orchestration',managerCommunicationRoute.includes('recordManagerDriverCommunication(id, activity)'),'Platform manager-communication orchestration absent')
}else{
    assertCheck('Inbox uses LogManagerCallCommand.v1',inboxFleetConsumer.includes('LOG_MANAGER_CALL_COMMAND_V1')&&inboxFleetConsumer.includes('logManagerCallV1({'),'Fleet manager-call command absent')
}
assertCheck('Inbox uses versioned public SegmentBadge',inboxFleetConsumer.includes('@/modules/fleet-operations/public/v1/segment-badge'),'public Fleet badge absent')
assertCheck('Inbox has no owner-internal Fleet import',!inboxFleetConsumer.includes('../drivers/'),'owner-internal Fleet import remains')
const leadMessageConsumer=source('gravity-mvp/src/lib/leads/intake.ts')
assertCheck('Avito lead intake uses ReceiveMessageCommand.v1',leadMessageConsumer.includes('RECEIVE_MESSAGE_COMMAND_V1')&&leadMessageConsumer.includes('receiveMessageV1({'),'Messaging receive command absent')
assertCheck('foreign lead Message create removed',!/prisma\.message\.create/.test(leadMessageConsumer),'direct lead Message create remains')
const botSystemMessageConsumer=source('gravity-mvp/src/app/api/webhooks/bot/route.ts')
assertCheck('Bot system notification uses SendMessageCommand.v1',botSystemMessageConsumer.includes('SEND_MESSAGE_COMMAND_V1')&&botSystemMessageConsumer.includes('sendMessageV1({'),'Messaging send command absent')
assertCheck('foreign bot Message create removed',!/prisma\.message\.create/.test(botSystemMessageConsumer),'direct bot Message create remains')
assertCheck('Bot pending-link state uses UpdateConversationCommand.v1',botSystemMessageConsumer.includes('UPDATE_CONVERSATION_COMMAND_V1')&&botSystemMessageConsumer.includes('updateConversationV1({'),'Messaging conversation command absent')
assertCheck('foreign bot Chat update removed',!/prisma\.chat\.update/.test(botSystemMessageConsumer),'direct bot Chat update remains')
const whatsappAttachmentConsumer=source('gravity-mvp/src/lib/whatsapp/WhatsAppService.ts')
assertCheck('WhatsApp media uses AttachMessageMediaCommand.v1',whatsappAttachmentConsumer.includes('ATTACH_MESSAGE_MEDIA_COMMAND_V1')&&whatsappAttachmentConsumer.includes('attachMessageMediaV1({'),'Messaging media command absent')
assertCheck('foreign WhatsApp MessageAttachment create removed',!/prisma\.messageAttachment\.create/.test(whatsappAttachmentConsumer),'direct MessageAttachment create remains')
const maxAttachmentConsumer=source('gravity-mvp/src/app/api/webhooks/max/route.ts')
assertCheck('MAX media uses AttachMessageMediaCommand.v2',maxAttachmentConsumer.includes('ATTACH_MESSAGE_MEDIA_COMMAND_V2')&&maxAttachmentConsumer.includes('attachMessageMediaV2({'),'Messaging media v2 command absent')
assertCheck('MAX deletion uses DeleteMessageMediaCommand.v1',maxAttachmentConsumer.includes('DELETE_MESSAGE_MEDIA_COMMAND_V1')&&maxAttachmentConsumer.includes('deleteMessageMediaV1({'),'Messaging media delete command absent')
assertCheck('foreign MAX MessageAttachment create removed',!/prisma\.messageAttachment\.create/.test(maxAttachmentConsumer),'direct MAX MessageAttachment create remains')
assertCheck('foreign MAX MessageAttachment delete removed',!/prisma\.messageAttachment\.deleteMany/.test(maxAttachmentConsumer),'direct MAX MessageAttachment delete remains')
const fleetClearStatusConsumer=source('gravity-mvp/src/scripts/force-clear-locks.ts')
assertCheck('Fleet maintenance uses ClearFleetCheckStatusCommand.v1',fleetClearStatusConsumer.includes('CLEAR_FLEET_CHECK_STATUS_COMMAND_V1')&&fleetClearStatusConsumer.includes('clearFleetCheckStatusV1({'),'Fleet clear-status command absent')
assertCheck('foreign maintenance Driver update removed',!/prisma\.driver\.updateMany/.test(fleetClearStatusConsumer),'direct Driver update remains')
const aiKnowledgeGovernanceConsumer=source('gravity-mvp/src/app/settings/ai/actions.ts')
const aiKnowledgeGovernanceCommands=[
    ['EDIT_GOVERNANCE_KNOWLEDGE_ITEM_COMMAND_V1','editGovernanceKnowledgeItemV1'],
    ['ARCHIVE_GOVERNANCE_KNOWLEDGE_ITEM_COMMAND_V1','archiveGovernanceKnowledgeItemV1'],
    ['RESTORE_GOVERNANCE_KNOWLEDGE_ITEM_COMMAND_V1','restoreGovernanceKnowledgeItemV1'],
    ['VERIFY_GOVERNANCE_KNOWLEDGE_ITEM_COMMAND_V1','verifyGovernanceKnowledgeItemV1'],
    ['UNVERIFY_GOVERNANCE_KNOWLEDGE_ITEM_COMMAND_V1','unverifyGovernanceKnowledgeItemV1'],
    ['SUPERSEDE_GOVERNANCE_KNOWLEDGE_ITEM_COMMAND_V1','supersedeGovernanceKnowledgeItemV1'],
    ['ARCHIVE_KNOWLEDGE_CONFLICT_MEMBER_COMMAND_V1','archiveKnowledgeConflictMemberV1'],
    ['CLEAR_KNOWLEDGE_CONFLICT_WINNER_COMMAND_V1','clearKnowledgeConflictWinnerV1'],
    ['CLEAR_KNOWLEDGE_CONFLICT_GROUP_COMMAND_V1','clearKnowledgeConflictGroupV1'],
    ['CREATE_MANUAL_GOVERNANCE_KNOWLEDGE_ITEM_COMMAND_V1','createManualGovernanceKnowledgeItemV1'],
    ['MARK_KNOWLEDGE_ITEM_SOURCES_DISABLED_COMMAND_V1','markKnowledgeItemSourcesDisabledV1'],
    ['ARCHIVE_KNOWLEDGE_ITEM_AFTER_SOURCE_DISABLE_COMMAND_V1','archiveKnowledgeItemAfterSourceDisableV1'],
    ['ARCHIVE_KNOWLEDGE_ITEM_FOR_CORE_RESET_COMMAND_V1','archiveKnowledgeItemForCoreResetV1'],
]
assertCheck('Configuration AI governance uses all 13 owner commands',aiKnowledgeGovernanceCommands.every(([contract,runtime])=>aiKnowledgeGovernanceConsumer.includes(contract)&&aiKnowledgeGovernanceConsumer.includes(`${runtime}({`)),'AI Knowledge governance owner command absent')
const aiKnowledgeGovernanceWrites=extractPrismaWrites(aiKnowledgeGovernanceConsumer).filter((write)=>write.model==='aiKnowledgeItem'||write.tables?.includes('AiKnowledgeItem'))
assertCheck('13 foreign AiKnowledgeItem writes removed from Configuration governance caller',aiKnowledgeGovernanceWrites.length===0,JSON.stringify(aiKnowledgeGovernanceWrites))

const callingAiConfigCommands=[
    ['SAVE_AI_AGENT_CONFIG_COMMAND_V1','saveAiAgentConfigV1'],
    ['RECORD_SAVED_AI_CONNECTION_SUCCESS_COMMAND_V1','recordSavedAiConnectionSuccessV1'],
    ['SET_ACTIVE_AI_PROFILE_COMMAND_V1','setActiveAiProfileV1'],
    ['SAVE_EXTRACTION_QUALITY_TIER_COMMAND_V1','saveExtractionQualityTierV1'],
]
assertCheck('Configuration AiAgentConfig uses all four Calling owner commands',callingAiConfigCommands.every(([contract,runtime])=>aiKnowledgeGovernanceConsumer.includes(contract)&&aiKnowledgeGovernanceConsumer.includes(`${runtime}(`)),'Calling AiAgentConfig owner command absent')
const callingAiConfigWrites=extractPrismaWrites(aiKnowledgeGovernanceConsumer).filter((write)=>write.model==='aiAgentConfig'||write.tables?.includes('AiAgentConfig'))
assertCheck('five foreign AiAgentConfig writes removed from Configuration caller',callingAiConfigWrites.length===0,JSON.stringify(callingAiConfigWrites))
assertCheck('legacy credential maps only through one opaque capture',aiKnowledgeGovernanceConsumer.includes("field === 'apiKeyEncrypted'")&&aiKnowledgeGovernanceConsumer.includes("field: 'providerCredential'")&&aiKnowledgeGovernanceConsumer.includes('captureAiAgentProviderCredentialV1(data[field])'),'opaque credential capture absent')
assertCheck('raw owner credential field is rejected by legacy action',aiKnowledgeGovernanceConsumer.includes("field === 'providerCredential'")&&aiKnowledgeGovernanceConsumer.includes("field: '__unsupported_provider_credential__', value: null"),'legacy action accepts providerCredential directly')
assertCheck('AiAgentConfig save result and credential errors are secret-safe',aiKnowledgeGovernanceConsumer.includes("return { id: 'singleton', ...safeResult }")&&!aiKnowledgeGovernanceConsumer.includes("return { id: 'singleton', ...data }")&&aiKnowledgeGovernanceConsumer.includes('ошибка сохранения учётных данных'),'legacy action can return or expose credential data')
const callingAiConfigContract=source('gravity-mvp/src/contracts/calling/v1/ai-agent-config-commands.ts')
assertCheck('Calling AiAgentConfig contract has a closed 23-field union',callingAiConfigContract.includes('AI_AGENT_CONFIG_PATCH_FIELDS_V1')&&(callingAiConfigContract.slice(callingAiConfigContract.indexOf('AI_AGENT_CONFIG_PATCH_FIELDS_V1'),callingAiConfigContract.indexOf('] as const',callingAiConfigContract.indexOf('AI_AGENT_CONFIG_PATCH_FIELDS_V1'))).match(/^  '[^']+',?$/gm)||[]).length===23&&!callingAiConfigContract.includes('apiKeyEncrypted'),'Calling AiAgentConfig contract shape drifted')
const callingAiConfigAdapter=source('gravity-mvp/src/modules/calling/public/v1/legacy-prisma-ai-agent-config-adapter.ts')
const callingAdapterWrites=extractPrismaWrites(callingAiConfigAdapter)
assertCheck('Calling owns five static AiAgentConfig persistence sites',callingAdapterWrites.length===5&&callingAdapterWrites.every((write)=>(write.model==='aiAgentConfig'||write.tables?.includes('AiAgentConfig'))&&(write.kind!=='raw'||write.dynamic===false)),'Calling AiAgentConfig persistence is dynamic or misowned')
assertCheck('Calling credential references are private and one-shot',callingAiConfigAdapter.includes('new WeakMap<OpaqueCredentialRefV1, string>()')&&callingAiConfigAdapter.includes('credentialValues.delete(reference)')&&!/export function (?:reveal|unseal|read).*Credential/i.test(callingAiConfigAdapter),'Calling credential reference lifetime drifted')

const handler = source('gravity-mvp/src/modules/work-management/public/v1/create-task-handler.ts')
assertCheck(
    'owner handler depends on a persistence port',
    handler.includes('CreateTaskPersistencePortV1') && !handler.includes("@/lib/prisma"),
    'handler is coupled to the legacy persistence implementation',
)

const adapter = source('gravity-mvp/src/modules/work-management/public/v1/legacy-prisma-adapter.ts')
assertCheck(
    'legacy Prisma dependency is isolated in owner compatibility adapter',
    adapter.includes("@/lib/prisma") && adapter.includes('prisma.task.create'),
    'owner compatibility adapter does not contain the legacy persistence boundary',
)

const srcRoot = path.join(root, 'gravity-mvp/src')
const internalImportViolations = []
const moduleRules = JSON.parse(source('architecture/evidence/v1/module-rules.json'))
const contextIndex = JSON.parse(source('architecture/contexts/v1/context-index.json'))
const moduleContext = new Map()
for (const entry of contextIndex.contexts) {
    const manifest = JSON.parse(source(entry.path))
    for (const technicalModule of manifest.technical_modules) {
        moduleContext.set(technicalModule, manifest.context.id)
    }
}
const compiledModuleRules = moduleRules.modules.map((rule) => ({ ...rule, regex: new RegExp(rule.match) }))
const slugContext = (slug) => ({
    'platform-shell': 'platform_shell',
    'work-management': 'work_management',
}[slug] ?? slug.replaceAll('-', '_'))

function classifyContext(relative) {
    const moduleMatch = relative.match(/^gravity-mvp\/src\/modules\/([^/]+)\//)
    if (moduleMatch) return slugContext(moduleMatch[1])
    const contractMatch = relative.match(/^gravity-mvp\/src\/contracts\/([^/]+)\//)
    if (contractMatch) return slugContext(contractMatch[1])
    if (relative.startsWith('gravity-mvp/src/infrastructure/')) return 'platform_shell'
    const technicalModule = compiledModuleRules.find((rule) => rule.regex.test(relative))?.id
    return moduleContext.get(technicalModule) ?? null
}

function scanInternalImports(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const candidate = path.join(directory, entry.name)
        if (entry.isDirectory()) scanInternalImports(candidate)
        else if (/\.(?:ts|tsx|js|mjs)$/.test(entry.name)) {
            const body = fs.readFileSync(candidate, 'utf8')
            const relative = path.relative(root, candidate).split(path.sep).join('/')
            const sourceContext = classifyContext(relative)
            const imports = body.matchAll(/from\s+['"]@\/modules\/([^/'"]+)\/internal(?:\/[^'"]*)?['"]/g)
            for (const match of imports) {
                const targetContext = slugContext(match[1])
                if (sourceContext !== targetContext) {
                    internalImportViolations.push(`${relative}:${sourceContext ?? 'unclassified'}>${targetContext}`)
                }
            }
        }
    }
}
scanInternalImports(srcRoot)
assertCheck(
    'cross-context internal module imports are forbidden',
    internalImportViolations.length === 0,
    internalImportViolations.join(', '),
)

const result = {
    status: failures.length === 0 ? 'PASS' : 'FAIL',
    checks,
    failures,
    contract_files: contractFiles.map((file) => path.relative(root, file)).sort(),
    representative_consumers: consumerFiles,
}
process.stdout.write(JSON.stringify(result, null, 2) + '\n')
if (failures.length > 0) process.exit(1)
