#!/usr/bin/env node
import fs from 'node:fs'

const read = (file) => fs.readFileSync(file, 'utf8')
const checks = []
const failures = []
const check = (name, passed, detail) => passed ? checks.push(name) : failures.push({ check: name, detail })
const section = (source, startName, endName) => source.slice(
    source.indexOf(`export async function ${startName}`),
    source.indexOf(`export async function ${endName}`),
)

const contract = read('gravity-mvp/src/contracts/ai-knowledge/v1/legacy-knowledge-entry-commands.ts')
const contractIndex = read('gravity-mvp/src/contracts/ai-knowledge/v1/index.ts')
const handler = read('gravity-mvp/src/modules/ai-knowledge/public/v1/legacy-knowledge-entry-handler.ts')
const adapter = read('gravity-mvp/src/modules/ai-knowledge/public/v1/legacy-prisma-legacy-knowledge-entry-adapter.ts')
const publicIndex = read('gravity-mvp/src/modules/ai-knowledge/public/v1/index.ts')
const consumer = read('gravity-mvp/src/app/settings/ai/actions.ts')
const amendmentPath = 'architecture/isolation/ai-knowledge/legacy-knowledge-entry-v1/module-manifest-amendments.json'
const amendment = JSON.parse(read(amendmentPath))
const policy = JSON.parse(read('architecture/enforcement/v1/policy.json'))
const registry = JSON.parse(read('architecture/enforcement/v1/exceptions.json'))
const create = section(consumer, 'createKnowledgeEntry', 'updateKnowledgeEntry')
const update = section(consumer, 'updateKnowledgeEntry', 'deleteKnowledgeEntry')
const del = section(consumer, 'deleteKnowledgeEntry', 'getDecisionLogs')
const forbiddenPublicSurface = /(KnowledgeBaseEntry|prisma|next\/|@\/lib|@\/app|apiKey|credential|provider|\bSQL\b|tableName)/i

check('contract is storage and credential neutral', !forbiddenPublicSurface.test(contract), 'public contract leaks implementation or credential vocabulary')
check('handler is storage and credential neutral', !forbiddenPublicSurface.test(handler), 'public handler leaks implementation or credential vocabulary')
check('contract barrel exports commands', contractIndex.includes("export * from './legacy-knowledge-entry-commands'"), 'contract export absent')
check(
    'public barrel wires all three handlers',
    publicIndex.includes('createLegacyKnowledgeEntryV1=createCreateLegacyKnowledgeEntryHandlerV1')
        && publicIndex.includes('updateLegacyKnowledgeEntryV1=createUpdateLegacyKnowledgeEntryHandlerV1')
        && publicIndex.includes('deleteLegacyKnowledgeEntryV1=createDeleteLegacyKnowledgeEntryHandlerV1'),
    'public wiring absent',
)
check(
    'three writes are isolated in owner adapter',
    adapter.includes('prisma.knowledgeBaseEntry.create({')
        && adapter.includes('prisma.knowledgeBaseEntry.updateMany({')
        && adapter.includes('prisma.knowledgeBaseEntry.deleteMany({')
        && !adapter.includes('$executeRaw')
        && !adapter.includes('Prisma.raw')
        && !adapter.includes('Prisma.sql')
        && !create.includes('INSERT INTO "KnowledgeBaseEntry"')
        && !update.includes('UPDATE "KnowledgeBaseEntry"')
        && !del.includes('DELETE FROM "KnowledgeBaseEntry"'),
    'foreign write remains or owner write absent',
)
check(
    'legacy read remains caller-owned and unchanged',
    consumer.includes('SELECT * FROM "KnowledgeBaseEntry" ORDER BY "priority" DESC, "createdAt" ASC'),
    'read drift',
)
check(
    'create authorization and caller id precede command',
    create.indexOf('await assertCanEditAi()') >= 0
        && create.indexOf('await assertCanEditAi()') < create.indexOf('const id = `kb_${Date.now()}`')
        && create.indexOf('const id = `kb_${Date.now()}`') < create.indexOf('await createLegacyKnowledgeEntryV1'),
    'create ordering drift',
)
check(
    'create command mapping is exact',
    create.includes('{ contract: CREATE_LEGACY_KNOWLEDGE_ENTRY_COMMAND_V1, entryId: id, data }'),
    'create mapping drift',
)
check(
    'create caller response construction is retained',
    create.includes('return { id, ...data, active: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }'),
    'create response drift',
)
check(
    'create field identity, active flag and single timestamp are retained',
    adapter.includes('sampleQuestions: data.sampleQuestions')
        && adapter.includes('tags: data.tags')
        && adapter.includes('channels: data.channels')
        && adapter.includes('active: true')
        && adapter.includes('priority: data.priority')
        && adapter.includes('createdAt: now')
        && adapter.includes('updatedAt: now'),
    'create persistence drift',
)
check(
    'update authorization and empty-patch no-op precede command',
    update.indexOf('await assertCanEditAi()') >= 0
        && update.indexOf('await assertCanEditAi()') < update.indexOf('const fields = Object.keys(data)')
        && update.indexOf('if (fields.length === 0) return') < update.indexOf('await updateLegacyKnowledgeEntryV1'),
    'update guard/no-op drift',
)
check(
    'update strict patch mapping and idempotent row targeting are retained',
    update.includes('{ contract: UPDATE_LEGACY_KNOWLEDGE_ENTRY_COMMAND_V1, entryId: id, patch: data }')
        && adapter.includes('if (Object.keys(patch).length === 0) return')
        && adapter.includes('where: { id: entryId }')
        && adapter.includes('data: { ...patch, lastReviewedAt: now, updatedAt: now }'),
    'update mapping/target drift',
)
check(
    'update review and modification timestamps are retained',
    adapter.includes('const now = new Date()')
        && adapter.includes('lastReviewedAt: now')
        && adapter.includes('updatedAt: now'),
    'update timestamp drift',
)
check(
    'delete authorization and exact mapping are retained',
    del.indexOf('await assertCanEditAi()') >= 0
        && del.indexOf('await assertCanEditAi()') < del.indexOf('await deleteLegacyKnowledgeEntryV1')
        && del.includes('{ contract: DELETE_LEGACY_KNOWLEDGE_ENTRY_COMMAND_V1, entryId: id }'),
    'delete drift',
)
check(
    'all revalidation remains success-only',
    [create, update, del].every((body) => {
        const commandAt = body.search(/await (create|update|delete)LegacyKnowledgeEntryV1/)
        const revalidateAt = body.indexOf("revalidatePath('/settings/ai')")
        return commandAt >= 0 && revalidateAt > commandAt && !body.includes('catch')
    }),
    'failure visibility or revalidation drift',
)
check(
    'AI Knowledge manifest declares exactly the three owner commands',
    amendment.amendments?.length === 1
        && amendment.amendments[0].context === 'ai_knowledge'
        && JSON.stringify(amendment.amendments[0].add_commands) === JSON.stringify([
            'CreateLegacyKnowledgeEntryCommand.v1',
            'UpdateLegacyKnowledgeEntryCommand.v1',
            'DeleteLegacyKnowledgeEntryCommand.v1',
        ]),
    'manifest command amendment drift',
)
check(
    'strict policy binds this milestone to the accepted parser parent',
    policy.manifest_amendments.includes(amendmentPath)
        && policy.registry_milestone === 'CRM-ARCH-007R-AI-KNOWLEDGE-LEGACY-ENTRY'
        && policy.registry_base_commit === '4e77d30934665d69fb69f5156b235175dec3b67f',
    'policy identity drift',
)
check(
    'exact three findings retire with no replacement capacity',
    registry.summary?.direct_foreign_prisma_write === 100
        && registry.exceptions.length === 1430
        && [
            'arch_64afa85c372c669fd21c130a',
            'arch_62f433aa20b6558ea65ba817',
            'arch_cc4a675bb943a6e30726aa0d',
        ].every((fingerprint) => !registry.exceptions.some((entry) => entry.fingerprint === fingerprint)),
    'strict exception retirement drift',
)

process.stdout.write(`${JSON.stringify({ status: failures.length ? 'FAIL' : 'PASS', checks, failures }, null, 2)}\n`)
if (failures.length) process.exitCode = 1
