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

const contract = read('gravity-mvp/src/contracts/operations-observability/v1/manager-health-repository.ts')
const handler = read('gravity-mvp/src/modules/operations-observability/public/v1/manager-health-repository-handler.ts')
const adapter = read('gravity-mvp/src/modules/operations-observability/public/v1/legacy-prisma-manager-health-repository.ts')
const publicIndex = read('gravity-mvp/src/modules/operations-observability/public/v1/index.ts')
const consumer = read('gravity-mvp/src/app/team-overview/actions.ts')
const config = read('gravity-mvp/src/lib/tasks/manager-health-config.ts')
const amendmentPath = 'architecture/isolation/operations-observability/manager-health-v1/module-manifest-amendments.json'
const amendment = JSON.parse(read(amendmentPath))
const migration = JSON.parse(read('architecture/isolation/operations-observability/manager-health-v1/migration-manifest.json'))
const verification = JSON.parse(read('architecture/isolation/operations-observability/manager-health-v1/verification.json'))
const behavior = JSON.parse(read('architecture/isolation/operations-observability/manager-health-v1/BEHAVIOR-FREEZE.json'))
const policy = JSON.parse(read('architecture/enforcement/v1/policy.json'))
const registry = JSON.parse(read('architecture/enforcement/v1/exceptions.json'))
const ensureFunction = sliceBetween(adapter, 'async function ensureTable', 'export const legacyPrismaManagerHealthRepositoryPortV1')
const previousWrapper = sliceBetween(consumer, 'async function getPreviousHealthScores', 'async function saveHealthScores')
const saveWrapper = sliceBetween(consumer, 'async function saveHealthScores', 'async function getHealthHistory')
const historyWrapper = sliceBetween(consumer, 'async function getHealthHistory', 'export async function getTeamOverview')

const expectedDdl = {
    ENSURE_TABLE_SQL: `
CREATE TABLE IF NOT EXISTS health_snapshots (
  manager_id TEXT PRIMARY KEY,
  score INTEGER NOT NULL,
  decline_streak INTEGER NOT NULL DEFAULT 0,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`,
    ENSURE_COLUMN_SQL: `
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'health_snapshots' AND column_name = 'decline_streak'
  ) THEN
    ALTER TABLE health_snapshots ADD COLUMN decline_streak INTEGER NOT NULL DEFAULT 0;
  END IF;
END $$`,
    ENSURE_HISTORY_TABLE_SQL: `
CREATE TABLE IF NOT EXISTS health_score_history (
  id SERIAL PRIMARY KEY,
  manager_id TEXT NOT NULL,
  score INTEGER NOT NULL,
  health_level TEXT NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`,
    ENSURE_HISTORY_INDEX_SQL: `
CREATE INDEX IF NOT EXISTS idx_hsh_manager_date
  ON health_score_history (manager_id, recorded_at DESC)`,
}

check(
    'contract and handler are infrastructure neutral',
    !/(prisma|next\/|@\/lib|@\/app)/i.test(contract + handler),
    'public surface leaks infrastructure',
)
check(
    'four exact request envelopes and results are versioned',
    (contract.match(/operations_observability\.[A-Za-z]+(?:Command|Query)\.v1/g) || []).length === 4 &&
        (contract.match(/operations_observability\.[A-Za-z]+Result\.v1/g) || []).length === 4,
    'contract identity count drift',
)
check(
    'public capability is closed and repository specific',
    !/(tableName|sql|filterBy|sortBy|page|transaction|predicate|whereClause)/i.test(contract + handler) &&
        contract.includes("['healthy', 'warning', 'critical'] as const") &&
        contract.includes('managerIds: string[]') &&
        contract.includes('periodDays: number') &&
        contract.includes('MANAGER_HEALTH_MAX_HISTORY_PERIOD_DAYS_V1 = 30 as const'),
    'generic or open-ended repository capability leaked',
)
check(
    'strict parsers reject extra fields and unsupported versions',
    (contract.match(/export function parse[A-Za-z]+(?:Command|Query)V1/g) || []).length === 4 &&
        contract.includes("extra.sort().join(', ')") &&
        contract.includes("'UNSUPPORTED_CONTRACT_VERSION'") &&
        contract.includes('Number.isFinite(value)') &&
        contract.includes("value.trim() !== ''") &&
        contract.includes('value.periodDays > MANAGER_HEALTH_MAX_HISTORY_PERIOD_DAYS_V1'),
    'parser coverage or validation policy drift',
)
check(
    'arrays preserve order and duplicates without deduplication',
    contract.includes('value.items.forEach((item, index)') &&
        contract.includes('value.managerIds.forEach((managerId, index)') &&
        !/(new Set\(value\.(?:items|managerIds)|value\.(?:items|managerIds)\.(?:filter|sort)\()/.test(contract),
    'contract reorders or deduplicates caller input',
)
check(
    'one named repository port owns one compatibility ensure two reads and one composite write',
    handler.includes('export interface ManagerHealthRepositoryPortV1') &&
        ['ensure():', 'listSnapshots():', 'saveScores(items:', 'listHistory(managerIds:'].every(value => handler.includes(value)),
    'repository port shape drift',
)
check(
    'handlers parse before ports and never catch failures',
    (handler.match(/parse[A-Za-z]+(?:Command|Query)V1/g) || []).length === 8 &&
        (handler.match(/await port\./g) || []).length === 4 &&
        !/\b(?:try|catch)\b/.test(handler),
    'handler validation or failure visibility drift',
)
check(
    'all public facades bind the same owner repository',
    (publicIndex.match(/legacyPrismaManagerHealthRepositoryPortV1\)/g) || []).length === 4,
    'public repository binding drift',
)
check(
    'compatibility DDL bytes are exact',
    Object.entries(expectedDdl).every(([name, sql]) => template(adapter, name) === sql),
    'compatibility DDL byte drift',
)
check(
    'DDL remains four separate sequential autocommit awaits',
    (ensureFunction.match(/await prisma\.\$executeRawUnsafe/g) || []).length === 4 &&
        ensureFunction.indexOf('ENSURE_TABLE_SQL') < ensureFunction.indexOf('ENSURE_COLUMN_SQL') &&
        ensureFunction.indexOf('ENSURE_COLUMN_SQL') < ensureFunction.indexOf('ENSURE_HISTORY_TABLE_SQL') &&
        ensureFunction.indexOf('ENSURE_HISTORY_TABLE_SQL') < ensureFunction.indexOf('ENSURE_HISTORY_INDEX_SQL') &&
        ensureFunction.indexOf('ENSURE_HISTORY_INDEX_SQL') < ensureFunction.indexOf('tableEnsured = true') &&
        !/Promise\.all|\$transaction/.test(ensureFunction),
    'DDL state-machine order or autocommit behavior drift',
)
check(
    'ensure flag preserves retry and uncoalesced first-call race',
    ensureFunction.indexOf('if (tableEnsured) return') < ensureFunction.indexOf('await prisma.$executeRawUnsafe') &&
        !/(ensurePromise|inFlight|pendingEnsure|mutex|lock)/i.test(adapter),
    'ensure state acquired a lock or changed retry behavior',
)
check(
    'empty writes and history reads return before ensure',
    adapter.indexOf('if (items.length === 0) return') < adapter.indexOf('await ensureTable()', adapter.indexOf('async saveScores')) &&
        adapter.indexOf('if (managerIds.length === 0) return []') < adapter.indexOf('await ensureTable()', adapter.indexOf('async listHistory')),
    'empty-input compatibility guard moved',
)
check(
    'primary batch write is one fixed bound statement retaining order and duplicates',
    adapter.includes('FROM UNNEST($1::text[], $2::integer[], $3::integer[])') &&
        adapter.includes('WITH ORDINALITY AS v(manager_id, score, decline_streak, ordinal)') &&
        adapter.includes('ORDER BY v.ordinal\nON CONFLICT (manager_id)') &&
        adapter.includes('await prisma.$executeRawUnsafe(SAVE_SNAPSHOTS_SQL, managerIds, scores, declineStreaks)') &&
        !/(new Set|\$transaction|Promise\.all)/.test(adapter),
    'primary batch mapping or same-statement duplicate behavior drift',
)
check(
    'history append remains a second best-effort fixed bound statement',
    adapter.includes('FROM UNNEST($1::text[], $2::integer[], $3::text[])') &&
        adapter.includes("h.recorded_at > NOW() - INTERVAL '1 hour'") &&
        adapter.includes("console.error('[health-history] Failed to write history, continuing:', error)") &&
        adapter.indexOf('await prisma.$executeRawUnsafe(SAVE_SNAPSHOTS_SQL') < adapter.indexOf('try {') &&
        adapter.indexOf('try {') < adapter.indexOf('await prisma.$executeRawUnsafe(APPEND_HISTORY_SQL'),
    'history statement ordering, predicate, or error policy drift',
)
check(
    'history query is fixed bound ordered and retains permissive period values',
    adapter.includes('manager_id = ANY($1::text[])') &&
        adapter.includes("$2::double precision * INTERVAL '1 day'") &&
        adapter.includes('ORDER BY manager_id, recorded_at ASC') &&
        adapter.includes('LIST_HISTORY_SQL, managerIds, periodDays'),
    'history query acquired interpolation or policy drift',
)
check(
    'adapter contains no dynamic SQL fragments clocks or transactions',
    !/\$\{/.test(adapter) &&
        !/new Date|Date\.now|\$transaction/.test(adapter) &&
        (adapter.match(/prisma\.\$executeRawUnsafe\(/g) || []).length === 6 &&
        (adapter.match(/prisma\.\$queryRawUnsafe</g) || []).length === 2,
    'adapter expanded SQL authority or moved clock ownership',
)
check(
    'pure manager health module is persistence free',
    !/(prisma|operations-observability|\$executeRaw|\$queryRaw|CREATE TABLE|INSERT INTO|SELECT manager_id)/i.test(config) &&
        config.includes('export interface HealthSnapshot') &&
        config.includes('export interface PreviousHealthData') &&
        config.includes('export function updateDeclineStreak') &&
        config.includes('export function isSustainedDecline'),
    'persistence remains in the Work-owned pure module',
)
check(
    'Analytics imports Operations only after inherited pure imports',
    consumer.indexOf("from '@/lib/tasks/volatility-config'") <
        consumer.indexOf("from '@/contracts/operations-observability/v1'") &&
        consumer.indexOf("from '@/contracts/operations-observability/v1'") <
        consumer.indexOf("from '@/modules/operations-observability/public/v1'"),
    'inherited import placement shifted',
)
check(
    'previous snapshot wrapper preserves ensure read and map order',
    previousWrapper.indexOf('await ensureManagerHealthRepositoryV1') < previousWrapper.indexOf('await listManagerHealthSnapshotsV1') &&
        previousWrapper.includes('result.set(item.managerId, { score: item.score, declineStreak: item.declineStreak })') &&
        !/try|catch/.test(previousWrapper),
    'previous snapshot failure or mapping semantics drift',
)
check(
    'save wrapper preserves empty guard ensure and visible primary failures',
    saveWrapper.indexOf('if (snapshots.length === 0) return') < saveWrapper.indexOf('await ensureManagerHealthRepositoryV1') &&
        saveWrapper.indexOf('await ensureManagerHealthRepositoryV1') < saveWrapper.indexOf('await saveManagerHealthScoresV1') &&
        !/try|catch/.test(saveWrapper),
    'save orchestration or failure policy drift',
)
check(
    'history wrapper preserves cap mapping and exact read fallback',
    historyWrapper.indexOf('if (managerIds.length === 0) return result') < historyWrapper.indexOf('try {') &&
        historyWrapper.indexOf('await ensureManagerHealthRepositoryV1') < historyWrapper.indexOf('const days = Math.min(') &&
        historyWrapper.includes('periodDays ?? HEALTH_HISTORY_CONFIG.defaultPeriodDays') &&
        historyWrapper.includes('HEALTH_HISTORY_CONFIG.maxPeriodDays') &&
        historyWrapper.includes('periodDays: days') &&
        historyWrapper.includes('healthLevel: item.healthLevel as HealthLevel') &&
        historyWrapper.includes("console.error('[health-history] Failed to read history, returning empty:', e)") &&
        historyWrapper.trimEnd().endsWith('return result\n}'),
    'history cap, mapping, or failure-tolerant policy drift',
)
check(
    'consumer contains no manager-health repository SQL or direct persistence',
    !/CREATE TABLE IF NOT EXISTS health_|INSERT INTO health_|FROM health_|prisma\.health/i.test(consumer),
    'manager-health persistence remains in Analytics',
)
check(
    'manifest amendment exposes only the exact owner repository surface',
    amendment.amendments?.length === 1 &&
        amendment.amendments[0].context === 'operations_observability' &&
        JSON.stringify(amendment.amendments[0].add_commands) === JSON.stringify([
            'EnsureManagerHealthRepositoryCommand.v1',
            'SaveManagerHealthScoresCommand.v1',
        ]) &&
        JSON.stringify(amendment.amendments[0].add_public_surface) === JSON.stringify([
            'ListManagerHealthSnapshotsQuery.v1',
            'ListManagerHealthHistoryQuery.v1',
        ]) &&
        amendment.amendments[0].add_allowed_dependencies === undefined,
    'manifest amendment widened or added a dependency',
)
check(
    'strict policy retains the amendment and migration binds the slice to the intervention parent',
    policy.manifest_amendments.includes(amendmentPath) &&
        migration.base_commit === '61f0afc9c22590d3344dfbcea6c5f4a580459a7d' &&
        migration.source_commit === '8aeccb755b3fad942a69a23799f76f7a480f4d4f',
    'policy or evidence identity drift',
)
check(
    'six accepted manager-health write retirements remain closed in later strict registries',
    registry.exceptions.length <= 1408 &&
        (registry.summary?.direct_foreign_prisma_write ?? 0) <= 85 &&
        registry.summary?.direct_provider_transport_access <= 38 &&
        registry.summary?.internal_module_import <= 379 &&
        registry.summary?.non_public_cross_context_import <= 536 &&
        registry.summary?.undeclared_dependency <= 370 &&
        [
            'arch_880b7dfae43971c822502b90',
            'arch_3251166f174bce021d52ecef',
            'arch_10ee9720cfdccbead6e5ce70',
            'arch_c03fd6c4c21c0595bbc73678',
            'arch_4115f2efad420d474a99e256',
            'arch_9379c33dd717fc04b6f50ea3',
        ].every(fingerprint => !registry.exceptions.some(entry => entry.fingerprint === fingerprint)) &&
        !registry.exceptions.some(entry =>
            entry.file.includes('legacy-prisma-manager-health-repository.ts')
        ),
    'strict registry delta or owner-local classification drift',
)
check(
    'archived accepted registry identity and zero-change set comparison remain exact',
    migration.enforcement?.actual_findings === 1408 &&
        migration.enforcement?.actual_direct_foreign_prisma_write === 85 &&
        migration.enforcement?.actual_undeclared_dependency === 370 &&
        migration.enforcement?.actual_removed === 6 &&
        migration.enforcement?.actual_added === 0 &&
        migration.enforcement?.actual_changed_shared_entries === 0 &&
        migration.enforcement?.finding_digest === 'f1508b169b806c8a8b2b6cdf2ff5feb0b3235296d9fb24fa93e3c955242f10e8' &&
        migration.enforcement?.registry_sha256 === 'fc04f70cb1a6898275a6ad70668f67245d994802a4e55f10e996b47b49881f1d',
    'verified registry evidence drift',
)
check(
    'behavior and verification evidence bind the frozen source and non-execution boundary',
    behavior.source_commit === '8aeccb755b3fad942a69a23799f76f7a480f4d4f' &&
        behavior.consumer_before_sha256 === 'f9529a3d36604c938035c2ed4b4064c15ff3c5e17634668b88e512190c2cf2db' &&
        behavior.consumer_after_sha256 === '2fea6763e1eba0247589c4b0f9ea0a88e4571f67ffe102c57660d34140cc21bc' &&
        behavior.pure_module_before_sha256 === 'b911692a7f5e735af482c0a202e5c86b5900ed7d89fbd16fcd1339c9ffef7b47' &&
        behavior.pure_module_after_sha256 === '58931ef529031ca72e104b315cf8a296547a9196963f5f05490f77b72771ef5f' &&
        verification.database_accessed === false &&
        verification.manager_health_repository_executed_against_database === false &&
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
