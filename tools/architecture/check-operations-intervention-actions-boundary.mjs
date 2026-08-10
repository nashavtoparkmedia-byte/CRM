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
const template = (source, name) => {
    const match = new RegExp('const ' + name + ' = `([\\s\\S]*?)`').exec(source)
    return match?.[1] ?? null
}

const contract = read('gravity-mvp/src/contracts/operations-observability/v1/intervention-actions-repository.ts')
const handler = read('gravity-mvp/src/modules/operations-observability/public/v1/intervention-actions-repository-handler.ts')
const adapter = read('gravity-mvp/src/modules/operations-observability/public/v1/legacy-prisma-intervention-actions-repository.ts')
const publicIndex = read('gravity-mvp/src/modules/operations-observability/public/v1/index.ts')
const consumer = read('gravity-mvp/src/app/team-overview/actions.ts')
const callerActionConfig = read('gravity-mvp/src/lib/tasks/intervention-action-config.ts')
const amendmentPath = 'architecture/isolation/operations-observability/intervention-actions-v1/module-manifest-amendments.json'
const amendment = JSON.parse(read(amendmentPath))
const migration = JSON.parse(read('architecture/isolation/operations-observability/intervention-actions-v1/migration-manifest.json'))
const policy = JSON.parse(read('architecture/enforcement/v1/policy.json'))
const registry = JSON.parse(read('architecture/enforcement/v1/exceptions.json'))
const timing = sliceBetween(consumer, 'async function getOutcomeTimingStats', '// ─── Intervention Actions')
const logAction = sliceBetween(consumer, 'export async function logInterventionAction', '/**\n * Get the last intervention action')
const latest = sliceBetween(consumer, 'async function getLastInterventionActions', '/**\n * Evaluate and persist outcomes')
const evaluate = sliceBetween(consumer, 'async function evaluateInterventionOutcomes', '/**\n * Aggregate intervention effectiveness')
const effectiveness = sliceBetween(consumer, 'async function getInterventionEffectiveness', null)
const ensureFunction = sliceBetween(adapter, 'async function ensureInterventionTable', 'export const legacyPrismaInterventionActionsRepositoryPortV1')

const expectedDdl = {
    ENSURE_INTERVENTION_TABLE_SQL: `
CREATE TABLE IF NOT EXISTS intervention_actions (
  id TEXT PRIMARY KEY,
  manager_id TEXT NOT NULL,
  action TEXT NOT NULL,
  comment TEXT,
  score_at_action INTEGER,
  outcome TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`,
    ENSURE_INTERVENTION_COLUMNS_SQL: `
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'intervention_actions' AND column_name = 'score_at_action') THEN
    ALTER TABLE intervention_actions ADD COLUMN score_at_action INTEGER;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'intervention_actions' AND column_name = 'outcome') THEN
    ALTER TABLE intervention_actions ADD COLUMN outcome TEXT;
  END IF;
END $$`,
    ENSURE_INTERVENTION_INDEX_SQL: `
CREATE INDEX IF NOT EXISTS idx_intervention_actions_manager
ON intervention_actions (manager_id, created_at DESC)`,
}

const actionLiterals = source => {
    const match = /(?:INTERVENTION_ACTIONS_V1|INTERVENTION_ACTIONS)\s*=\s*\[([\s\S]*?)\]\s*as const/.exec(source)
    return [...(match?.[1] ?? '').matchAll(/'([^']+)'/g)].map(value => value[1])
}

check(
    'contract and handler are infrastructure neutral',
    !/(prisma|next\/|@\/lib|@\/app)/i.test(contract + handler),
    'public surface leaks infrastructure',
)
check(
    'seven request envelopes and results are versioned',
    (contract.match(/operations_observability\.[A-Za-z]+(?:Command|Query)\.v1/g) || []).length === 7 &&
        (contract.match(/operations_observability\.[A-Za-z]+Result\.v1/g) || []).length === 7,
    'contract identity count drift',
)
check(
    'public surface exposes no generic repository capability',
    !/(tableName|sql|filterBy|sortBy|page|transaction|predicate|whereClause)/i.test(contract + handler) &&
        contract.includes('eligibleAtOrBefore: Date') &&
        contract.includes("export type InterventionOutcomeV1 = 'improved' | 'unchanged' | 'worsened'") &&
        contract.includes("export type InterventionActionV1 = typeof INTERVENTION_ACTIONS_V1[number]") &&
        contract.includes("'coaching',\n    'reassigned_tasks',\n    'workload_adjusted',\n    'escalation_reviewed',\n    'no_action_needed'") &&
        contract.includes('export interface LatestInterventionActionV1') &&
        sliceBetween(contract, 'export interface LatestInterventionActionV1', 'export interface ListLatestInterventionActionsResultV1').includes('action: string'),
    'generic query/write capability leaked',
)
check(
    'create vocabulary exactly mirrors the caller action vocabulary',
    JSON.stringify(actionLiterals(contract)) === JSON.stringify(actionLiterals(callerActionConfig)) &&
        actionLiterals(contract).length === 5,
    'versioned create vocabulary diverged from the closed caller vocabulary',
)
check(
    'strict parsers cover all seven requests',
        (contract.match(/export function parse[A-Za-z]+(?:Command|Query)V1/g) || []).length === 7 &&
        contract.includes("value.eligibleAtOrBefore instanceof Date") &&
        contract.includes("!ACTIONS.has(value.action as InterventionActionV1)") &&
        contract.includes("!OUTCOMES.has(value.outcome as InterventionOutcomeV1)"),
    'strict parser coverage drift',
)
check(
    'one named repository port owns three writes and four reads',
    handler.includes('export interface InterventionActionsRepositoryPortV1') &&
        ['ensure()', 'create(input:', 'listPending(', 'setOutcome(', 'listLatest()', 'listOutcomeCounts()', 'listCompletedTimes()']
            .every(value => handler.includes(value)),
    'repository port shape drift',
)
check(
    'handlers parse before ports and never catch failures',
    (handler.match(/parse[A-Za-z]+(?:Command|Query)V1/g) || []).length === 14 &&
        (handler.match(/await port\./g) || []).length === 7 &&
        !/\b(?:try|catch)\b/.test(handler),
    'handler validation, port mapping, or failure visibility drift',
)
check(
    'all public facades bind the same owner repository',
    (publicIndex.match(/legacyPrismaInterventionActionsRepositoryPortV1\)/g) || []).length === 7,
    'public repository binding drift',
)
check(
    'compatibility DDL bytes are exact',
    Object.entries(expectedDdl).every(([name, sql]) => template(adapter, name) === sql),
    'compatibility DDL byte drift',
)
check(
    'DDL remains three separate autocommit awaits in exact order',
    (ensureFunction.match(/await prisma\.\$executeRawUnsafe/g) || []).length === 3 &&
        ensureFunction.indexOf('ENSURE_INTERVENTION_TABLE_SQL') < ensureFunction.indexOf('ENSURE_INTERVENTION_COLUMNS_SQL') &&
        ensureFunction.indexOf('ENSURE_INTERVENTION_COLUMNS_SQL') < ensureFunction.indexOf('ENSURE_INTERVENTION_INDEX_SQL') &&
        ensureFunction.indexOf('ENSURE_INTERVENTION_INDEX_SQL') < ensureFunction.indexOf('interventionTableEnsured = true') &&
        !/Promise\.all|\$transaction/.test(ensureFunction),
    'DDL state-machine order or autocommit behavior drift',
)
check(
    'ensure flag preserves retry and first-call race semantics',
    ensureFunction.indexOf('if (interventionTableEnsured) return') < ensureFunction.indexOf('await prisma.$executeRawUnsafe') &&
        !/(ensurePromise|inFlight|pendingEnsure)/.test(adapter),
    'ensure state acquired a lock or changed retry behavior',
)
check(
    'every owner method defensively ensures',
    (adapter.match(/await ensureInterventionTable\(\)/g) || []).length === 7,
    'owner defensive ensure coverage drift',
)
check(
    'writes use typed create and updateMany exact mappings',
    adapter.includes('await prisma.intervention_actions.create({') &&
        adapter.includes('manager_id: input.managerId') &&
        adapter.includes('score_at_action: input.scoreAtAction') &&
        adapter.includes('await prisma.intervention_actions.updateMany({') &&
        adapter.includes('where: { id: input.id }') &&
        adapter.includes('data: { outcome: input.outcome }') &&
        !/intervention_actions\.(?:create|updateMany)[\s\S]{0,300}(?:created_at|count)/.test(adapter),
    'typed write mapping or zero-row behavior drift',
)
check(
    'owner retains exactly four fixed raw reads',
    (adapter.match(/prisma\.\$queryRawUnsafe</g) || []).length === 4 &&
        adapter.includes('WHERE outcome IS NULL AND score_at_action IS NOT NULL AND created_at <= $1') &&
        adapter.includes('SELECT DISTINCT ON (manager_id)') &&
        adapter.includes('GROUP BY action, outcome') &&
        adapter.includes('SELECT created_at') &&
        !/(queryText|tableName|filter|sort|page|transaction)/i.test(adapter),
    'fixed read set drift or generic input appeared',
)
check(
    'Analytics imports Operations only after inherited imports',
    consumer.indexOf("from '@/lib/tasks/volatility-config'") <
        consumer.indexOf("from '@/contracts/operations-observability/v1'") &&
        consumer.indexOf("from '@/contracts/operations-observability/v1'") <
        consumer.indexOf("from '@/modules/operations-observability/public/v1'"),
    'inherited import line identities shifted',
)
check(
    'explicit ensure remains before every clock random and cutoff',
    timing.indexOf('await ensureInterventionActionsRepositoryV1') < timing.indexOf('Date.now()') &&
        logAction.indexOf('await ensureInterventionActionsRepositoryV1') < logAction.indexOf('Date.now()') &&
        logAction.indexOf('await ensureInterventionActionsRepositoryV1') < logAction.indexOf('Math.random()') &&
        evaluate.indexOf('await ensureInterventionActionsRepositoryV1') < evaluate.indexOf('const cutoff') &&
        latest.indexOf('await ensureInterventionActionsRepositoryV1') < latest.indexOf('await listLatestInterventionActionsV1') &&
        effectiveness.indexOf('await ensureInterventionActionsRepositoryV1') < effectiveness.indexOf('await listInterventionOutcomeCountsV1'),
    'explicit ensure ordering drift',
)
check(
    'Analytics retains ID comment and score projections',
    logAction.includes('const id = `ia_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`') &&
        logAction.includes('const comment = params.comment?.trim() || null') &&
        logAction.includes('const score = params.scoreAtAction ?? null') &&
        logAction.includes('scoreAtAction: score'),
    'caller-owned create projection drift',
)
check(
    'latest-action mapping remains caller-owned',
    latest.includes('map.set(r.managerId, {') &&
        latest.includes('timestamp: r.createdAt.toISOString()') &&
        latest.includes('scoreAtAction: r.scoreAtAction') &&
        latest.includes('outcome: (r.outcome as InterventionOutcome) ?? null'),
    'latest action mapping drift',
)
check(
    'outcome cutoff score map evaluation and sequential writes remain caller-owned',
    evaluate.includes('const windowMs = INTERVENTION_OUTCOME_CONFIG.outcomeWindowHours * 60 * 60 * 1000') &&
        evaluate.includes('const cutoff = new Date(Date.now() - windowMs)') &&
        evaluate.includes('const scoreMap = new Map(managers.map(m => [m.managerId, m.healthScore]))') &&
        evaluate.includes('if (currentScore === undefined) continue') &&
        evaluate.includes('const outcome = evaluateOutcome(row.scoreAtAction, currentScore)') &&
        (evaluate.match(/await setInterventionOutcomeV1/g) || []).length === 1 &&
        !/Promise\.all/.test(evaluate),
    'outcome orchestration drift',
)
check(
    'effectiveness parsing labels rates and sort remain caller-owned',
    effectiveness.includes('const count = parseInt(r.total, 10) || 0') &&
        effectiveness.includes('INTERVENTION_ACTION_LABELS[action as InterventionAction] ?? action') &&
        effectiveness.includes('Math.round((counts.improved / total) * 100)') &&
        effectiveness.includes('b.improvementRate - a.improvementRate || b.total - a.total'),
    'effectiveness mapping drift',
)
check(
    'timing math and fallback remain unchanged',
    timing.includes('if (rows.length < cfg.minCompletedForStats) return insufficient') &&
        timing.includes('const recentCutoff = now - cfg.recentPeriodDays * 24 * 60 * 60 * 1000') &&
        timing.includes('newestDaysAgo: Math.max(0, newestDaysAgo)') &&
        timing.includes("console.error('[outcome-timing] Failed to query, returning insufficient:', e)") &&
        timing.includes('return insufficient'),
    'outcome timing or fallback drift',
)
check(
    'team projection still evaluates before loading latest actions',
    consumer.indexOf('await evaluateInterventionOutcomes(') < consumer.indexOf('const lastActions = await getLastInterventionActions()'),
    'team projection ordering drift',
)
check(
    'Analytics contains no intervention repository SQL or direct persistence',
    !/FROM intervention_actions|INSERT INTO intervention_actions|UPDATE intervention_actions|CREATE TABLE IF NOT EXISTS intervention_actions/.test(consumer) &&
        !/prisma\.intervention_actions\./.test(consumer),
    'intervention repository persistence remains in Analytics',
)
check(
    'manifest amendment exposes only the exact repository surface and Analytics edge',
    amendment.amendments?.length === 2 &&
        amendment.amendments[0].context === 'operations_observability' &&
        JSON.stringify(amendment.amendments[0].add_commands) === JSON.stringify([
            'EnsureInterventionActionsRepositoryCommand.v1',
            'CreateInterventionActionCommand.v1',
            'SetInterventionOutcomeCommand.v1',
        ]) &&
        JSON.stringify(amendment.amendments[0].add_public_surface) === JSON.stringify([
            'ListPendingInterventionActionsQuery.v1',
            'ListLatestInterventionActionsQuery.v1',
            'ListInterventionOutcomeCountsQuery.v1',
            'ListCompletedInterventionTimesQuery.v1',
        ]) &&
        amendment.amendments[1].context === 'analytics_reporting' &&
        JSON.stringify(amendment.amendments[1].add_allowed_dependencies) === JSON.stringify([
            { context: 'operations_observability', surface: 'operations_observability.public' },
        ]),
    'manifest amendment widened or drifted',
)
check(
    'strict policy and migration bind the slice to the archived-contact parent',
    policy.manifest_amendments.includes(amendmentPath) &&
        policy.registry_milestone === 'CRM-ARCH-007R-INTERVENTION-ACTIONS' &&
        policy.registry_base_commit === 'e8811394458d2ee7e731aa51f5ff00c65d958901' &&
        migration.base_commit === 'e8811394458d2ee7e731aa51f5ff00c65d958901' &&
        migration.source_commit === 'fb53587e5377c272fefa58c58d521c8524a8e511',
    'policy or evidence identity drift',
)
check(
    'exact five write findings retire with no replacement capacity',
    registry.milestone === 'CRM-ARCH-007R-INTERVENTION-ACTIONS' &&
        registry.base_commit === 'e8811394458d2ee7e731aa51f5ff00c65d958901' &&
        registry.exceptions.length === 1414 &&
        registry.summary?.direct_foreign_prisma_write === 91 &&
        registry.summary?.undeclared_dependency === 370 &&
        [
            'arch_88826812df7607334fe418c0',
            'arch_797839b976905d3a7fc723b8',
            'arch_b6c2382b10f9b0d97aab482a',
            'arch_be72e901fee4b2693481ee1d',
            'arch_e6b0081069429a87f802c5e8',
        ].every(fingerprint => !registry.exceptions.some(entry => entry.fingerprint === fingerprint)) &&
        !registry.exceptions.some(entry => entry.file.includes('modules/operations-observability/')),
    'strict registry delta or owner-local classification drift',
)
check(
    'verified registry identity and zero-change set comparison are exact',
    registry.finding_digest === '2d262852d9b5e78314a109ea830bc1afbd34b69811fed95fc09f7caf0f0e9f43' &&
        migration.enforcement?.actual_findings === 1414 &&
        migration.enforcement?.actual_direct_foreign_prisma_write === 91 &&
        migration.enforcement?.actual_added === 0 &&
        migration.enforcement?.actual_changed_shared_entries === 0 &&
        migration.enforcement?.finding_digest === registry.finding_digest &&
        migration.enforcement?.registry_sha256 === 'ec5829f8140b841448e26e9bd4d8d055cc41ea7ddeb8db2728668ee8797843a9',
    'verified registry evidence drift',
)

process.stdout.write(`${JSON.stringify({
    status: failures.length > 0 ? 'FAIL' : 'PASS',
    checks,
    failures,
}, null, 2)}\n`)
if (failures.length > 0) process.exitCode = 1
