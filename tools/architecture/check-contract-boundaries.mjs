#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'

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

const reassignmentConsumer = source('gravity-mvp/src/app/team-overview/actions.ts')
assertCheck(
    'representative Analytics consumer uses AssignTaskCommand.v1',
    reassignmentConsumer.includes('ASSIGN_TASK_COMMAND_V1')
        && reassignmentConsumer.includes('assignTaskV1({'),
    'versioned assignment command invocation is absent',
)
assertCheck(
    'foreign Task update removed from Analytics consumer',
    !/prisma\.task\.update\s*\(/.test(reassignmentConsumer),
    'direct foreign Prisma Task update remains',
)
assertCheck(
    'Analytics consumer no longer imports owner-internal task event service',
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
const communicationConsumer=source('gravity-mvp/src/lib/communications.ts')
assertCheck('Messaging communication consumer uses RecordDriverDailyActivityCommand.v1',communicationConsumer.includes('RECORD_DRIVER_DAILY_ACTIVITY_COMMAND_V1')&&communicationConsumer.includes('recordDriverDailyActivityV1({'),'Fleet daily-activity command absent')
assertCheck('foreign DriverDaySummary upsert removed',!/prisma\.driverDaySummary\.upsert/.test(communicationConsumer),'direct DriverDaySummary upsert remains')
const inboxFleetConsumer=source('gravity-mvp/src/app/inbox/InboxClient.tsx')
assertCheck('Inbox uses LogManagerCallCommand.v1',inboxFleetConsumer.includes('LOG_MANAGER_CALL_COMMAND_V1')&&inboxFleetConsumer.includes('logManagerCallV1({'),'Fleet manager-call command absent')
assertCheck('Inbox uses versioned public SegmentBadge',inboxFleetConsumer.includes('@/modules/fleet-operations/public/v1/segment-badge'),'public Fleet badge absent')
assertCheck('Inbox has no owner-internal Fleet import',!inboxFleetConsumer.includes('../drivers/'),'owner-internal Fleet import remains')

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
function scanInternalImports(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const candidate = path.join(directory, entry.name)
        if (entry.isDirectory()) scanInternalImports(candidate)
        else if (/\.(?:ts|tsx|js|mjs)$/.test(entry.name)) {
            const body = fs.readFileSync(candidate, 'utf8')
            if (/from\s+['"]@\/modules\/[^'"]+\/internal(?:\/|['"])/.test(body)) {
                internalImportViolations.push(path.relative(root, candidate))
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
