#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

import { evaluateFindings, scanArchitecture } from './enforce-architecture.mjs'

const root = process.cwd()
const read = (relative) => readFileSync(path.join(root, relative), 'utf8')
const sha = relative => createHash('sha256').update(readFileSync(path.join(root, relative))).digest('hex')
const paths = {
  contract: 'gravity-mvp/src/contracts/work-management/v1/scenario-field-settings.ts',
  contractIndex: 'gravity-mvp/src/contracts/work-management/v1/index.ts',
  handler: 'gravity-mvp/src/modules/work-management/public/v1/scenario-field-settings-handler.ts',
  adapter: 'gravity-mvp/src/modules/work-management/public/v1/legacy-prisma-scenario-field-settings-adapter.ts',
  publicIndex: 'gravity-mvp/src/modules/work-management/public/v1/index.ts',
  actions: 'gravity-mvp/src/app/settings/scenarios/actions.ts',
  client: 'gravity-mvp/src/app/settings/scenarios/[id]/fields/ScenarioFieldsSettingsClient.tsx',
  internal: 'gravity-mvp/src/lib/tasks/scenario-settings.ts',
}
const source = Object.fromEntries(Object.entries(paths).map(([key, value]) => [key, read(value)]))
const frozenBehaviorSources = Object.entries(
  JSON.parse(read('architecture/isolation/work-management/scenario-field-settings-v1/BEHAVIOR-FREEZE.json'))
    .source_hashes_after ?? {},
).filter(([file]) => !file.startsWith('architecture/contexts/v1/'))
const evidenceRoot = 'architecture/isolation/work-management/scenario-field-settings-v1'
const amendmentPath = `${evidenceRoot}/module-manifest-amendments.json`
const amendment = JSON.parse(read(amendmentPath))
const migration = JSON.parse(read(`${evidenceRoot}/migration-manifest.json`))
const verification = JSON.parse(read(`${evidenceRoot}/verification.json`))
const behavior = JSON.parse(read(`${evidenceRoot}/BEHAVIOR-FREEZE.json`))
const policy = JSON.parse(read('architecture/enforcement/v1/policy.json'))
const registry = JSON.parse(read('architecture/enforcement/v1/exceptions.json'))
const currentArchitectureScan = await scanArchitecture(root)
const currentEnforcement = evaluateFindings(
  currentArchitectureScan.findings,
  registry,
  currentArchitectureScan.policy,
)
const configurationManifest = JSON.parse(read('architecture/contexts/v1/manifests/configuration.json'))
const workManifest = JSON.parse(read('architecture/contexts/v1/manifests/work_management.json'))
const contextIndex = JSON.parse(read('architecture/contexts/v1/context-index.json'))
const checks = []
const failures = []
const check = (name, predicate, detail) => {
  if (predicate) checks.push(name)
  else failures.push({ check: name, detail })
}

function filesUnder(directory) {
  const results = []
  for (const entry of readdirSync(directory)) {
    const absolute = path.join(directory, entry)
    if (statSync(absolute).isDirectory()) results.push(...filesUnder(absolute))
    else if (/\.tsx?$/.test(entry)) results.push(absolute)
  }
  return results
}

const allApplicationSources = filesUnder(path.join(root, 'gravity-mvp/src'))
const writeOwners = { insert: [], delete: [] }
for (const absolute of allApplicationSources) {
  const body = readFileSync(absolute, 'utf8')
  const relative = path.relative(root, absolute)
  if (/INSERT\s+INTO\s+scenario_field_settings/i.test(body)) writeOwners.insert.push(relative)
  if (/DELETE\s+FROM\s+scenario_field_settings/i.test(body)) writeOwners.delete.push(relative)
}

check(
  'contract identities are exact',
  source.contract.includes("GET_MERGED_SCENARIO_FIELDS_QUERY_V1 = 'work_management.GetMergedScenarioFieldsQuery.v1'")
    && source.contract.includes("GET_MERGED_SCENARIO_FIELDS_RESULT_V1 = 'work_management.GetMergedScenarioFieldsResult.v1'")
    && source.contract.includes("UPSERT_SCENARIO_FIELD_SETTING_COMMAND_V1 = 'work_management.UpsertScenarioFieldSettingCommand.v1'")
    && source.contract.includes("RESET_SCENARIO_FIELD_SETTING_COMMAND_V1 = 'work_management.ResetScenarioFieldSettingCommand.v1'"),
  'one or more public identities drifted',
)

check(
  'contract patch remains exact nullable and finite',
  ['showInList', 'showInCard', 'filterable', 'sortable', 'groupable']
    .every(field => source.contract.includes(`${field}?: boolean | null`))
    && source.contract.includes('order?: number | null')
    && source.contract.includes('Number.isFinite(value.order)')
    && source.contract.includes('patch has unsupported field(s)')
    && source.contract.includes('export const MAX_LIST_PREVIEW_FIELDS = 8 as const'),
  'patch or preview policy widened',
)

check(
  'contract exposes no persistence mechanism',
  !/(prisma|next\/|@\/lib|@\/app|scenario_field_settings|\bSQL\b|tableName|rawSql|whereClause|orderBy|transaction)/i
    .test(source.contract),
  'contract leaks infrastructure or a generic capability',
)

check(
  'handler validates before each exact port operation',
  source.handler.indexOf('parseGetMergedScenarioFieldsQueryV1(query)')
      < source.handler.indexOf('port.getMerged(parsed.scenarioId)')
    && source.handler.indexOf('parseUpsertScenarioFieldSettingCommandV1(command)')
      < source.handler.indexOf('port.upsert({')
    && source.handler.indexOf('parseResetScenarioFieldSettingCommandV1(command)')
      < source.handler.indexOf('port.reset(parsed.scenarioId, parsed.fieldId)')
    && source.handler.includes('completed: true'),
  'handler validation/mapping drifted',
)

check(
  'handler remains persistence-neutral',
  !/(prisma|next\/|@\/lib|@\/app|scenario_field_settings|\$executeRaw|\$queryRaw)/i.test(source.handler),
  'handler owns infrastructure',
)

check(
  'adapter delegates merged reads to the unchanged Work internal reader',
  source.adapter.includes("import { getMergedFieldsForScenario } from '@/lib/tasks/scenario-settings'")
    && source.adapter.includes('return getMergedFieldsForScenario(scenarioId)')
    && !source.adapter.includes('$queryRaw'),
  'merged query was reimplemented or bypassed',
)

check(
  'adapter SQL is fixed private and fully positional',
  source.adapter.includes('const UPSERT_SCENARIO_FIELD_SETTING_SQL = `')
    && source.adapter.includes('const RESET_SCENARIO_FIELD_SETTING_SQL = `')
    && !source.adapter.includes('export const UPSERT_SCENARIO_FIELD_SETTING_SQL')
    && !source.adapter.includes('export const RESET_SCENARIO_FIELD_SETTING_SQL')
    && source.adapter.includes('$10::timestamp, $11')
    && source.adapter.includes('WHERE "scenarioId" = $1 AND "fieldId" = $2')
    && (source.adapter.match(/prisma\.\$executeRawUnsafe/g) ?? []).length === 2,
  'fixed private SQL surface drifted',
)

check(
  'adapter preserves deterministic id timestamp and nullish binds',
  source.adapter.includes('const id = `${input.scenarioId}_${input.fieldId}`')
    && source.adapter.includes('const nowIso = new Date().toISOString()')
    && ['showInList', 'showInCard', 'filterable', 'sortable', 'groupable', 'order']
      .every(field => source.adapter.includes(`input.patch.${field} ?? null`))
    && source.adapter.includes('input.userId ?? null'),
  'write mapping drifted',
)

check(
  'adapter exposes no generic transaction logging or retry lane',
  !/(\$transaction|\bcatch\b|\bretry\b|console\.|tableName|rawSql|whereClause|orderBy|transactionHandle)/i
    .test(source.adapter),
  'generic or policy-changing adapter capability found',
)

check(
  'scenario field setting writes have one Work-owned source',
  JSON.stringify(writeOwners.insert) === JSON.stringify([paths.adapter])
    && JSON.stringify(writeOwners.delete) === JSON.stringify([paths.adapter]),
  `insert=${JSON.stringify(writeOwners.insert)} delete=${JSON.stringify(writeOwners.delete)}`,
)

check(
  'legacy Work internal module retains reads and pure merge but no writes',
  (source.internal.match(/prisma\.\$queryRaw/g) ?? []).length === 2
    && source.internal.includes('export async function getAllScenarioSettingsMap')
    && source.internal.includes('export function mergeFieldsWithOverrides')
    && !source.internal.includes('upsertScenarioFieldSetting')
    && !source.internal.includes('resetScenarioFieldSetting')
    && !source.internal.includes('$executeRaw'),
  'Work internal reader/merge or write retirement drifted',
)

check(
  'Configuration actions consume only Work public scenario settings',
  source.actions.includes("from '@/contracts/work-management/v1'")
    && source.actions.includes("from '@/modules/work-management/public/v1'")
    && !source.actions.includes("from '@/lib/tasks/scenario-settings'")
    && source.actions.includes('getMergedScenarioFieldsV1({')
    && source.actions.includes('upsertScenarioFieldSettingV1({')
    && source.actions.includes('resetScenarioFieldSettingV1({'),
  'Configuration still reaches Work internals',
)

check(
  'Configuration preserves actor acquisition before both writes',
  (source.actions.match(/const \{ cookies \} = await import\('next\/headers'\)/g) ?? []).length === 2
    && (source.actions.match(/store\.get\('crm_user_id'\)\?\.value \|\| null/g) ?? []).length === 2
    && source.actions.indexOf("store.get('crm_user_id')") < source.actions.indexOf('upsertScenarioFieldSettingV1({'),
  'cookie/actor ordering drifted',
)

check(
  'client consumes the Work DTO and preserves concurrent reorder',
  source.client.includes("from '@/contracts/work-management/v1'")
    && source.client.includes('type MergedScenarioFieldV1')
    && source.client.includes('await Promise.all(reordered.map')
    && source.client.indexOf('await Promise.all(reordered.map') < source.client.indexOf('await refresh()', source.client.indexOf('const move =')),
  'client type ownership or concurrency drifted',
)

check(
  'public indexes expose only the typed Work surface and bound facades',
  source.contractIndex.includes("export * from './scenario-field-settings'")
    && source.publicIndex.includes("from './scenario-field-settings-handler'")
    && source.publicIndex.includes("from './legacy-prisma-scenario-field-settings-adapter'")
    && source.publicIndex.includes('getMergedScenarioFieldsV1 = createGetMergedScenarioFieldsHandlerV1(')
    && source.publicIndex.includes('upsertScenarioFieldSettingV1 = createUpsertScenarioFieldSettingHandlerV1(')
    && source.publicIndex.includes('resetScenarioFieldSettingV1 = createResetScenarioFieldSettingHandlerV1('),
  'public binding absent or widened',
)

const workSources = [
  ...filesUnder(path.join(root, 'gravity-mvp/src/contracts/work-management')),
  ...filesUnder(path.join(root, 'gravity-mvp/src/modules/work-management')),
  path.join(root, paths.internal),
]
check(
  'Work does not acquire a reverse Configuration dependency',
  workSources.every(absolute => !/@\/(?:contracts|modules)\/configuration|@\/app\/settings\/scenarios/.test(
    readFileSync(absolute, 'utf8'),
  )),
  'Work imports Configuration',
)

const scenarioOwnerEntries = [configurationManifest, workManifest]
  .flatMap(manifest => (manifest.owned_data ?? []).map(entry => ({ context: manifest.context.id, entry })))
  .filter(({ entry }) => entry.model === 'scenario_field_settings')
const configurationIndex = contextIndex.contexts.find(entry => entry.context === 'configuration')
const workIndex = contextIndex.contexts.find(entry => entry.context === 'work_management')
check(
  'D2 owner reassignment is unique exact and index-bound',
  scenarioOwnerEntries.length === 1 &&
    scenarioOwnerEntries[0].context === 'work_management' &&
    JSON.stringify(scenarioOwnerEntries[0].entry.current_writer_modules) === JSON.stringify(['tasks']) &&
    scenarioOwnerEntries[0].entry.id === 'gravity-mvp/prisma/schema.prisma:scenario_field_settings' &&
    scenarioOwnerEntries[0].entry.mapped_table === null &&
    scenarioOwnerEntries[0].entry.schema === 'gravity-mvp/prisma/schema.prisma' &&
    configurationIndex?.sha256 === sha('architecture/contexts/v1/manifests/configuration.json') &&
    workIndex?.sha256 === sha('architecture/contexts/v1/manifests/work_management.json'),
  'owner uniqueness, entry identity or context-index hash drifted',
)
check(
  'manifest amendment exposes only the exact Work surface and Configuration edge',
  amendment.amendments?.length === 2 &&
    amendment.amendments[0].context === 'work_management' &&
    JSON.stringify(amendment.amendments[0].add_commands) === JSON.stringify([
      'UpsertScenarioFieldSettingCommand.v1',
      'ResetScenarioFieldSettingCommand.v1',
    ]) &&
    JSON.stringify(amendment.amendments[0].add_public_surface) === JSON.stringify([
      'GetMergedScenarioFieldsQuery.v1',
    ]) &&
    amendment.amendments[0].add_allowed_dependencies === undefined &&
    amendment.amendments[1].context === 'configuration' &&
    JSON.stringify(amendment.amendments[1].add_allowed_dependencies) === JSON.stringify([
      { context: 'work_management', surface: 'work_management.public' },
    ]) &&
    amendment.amendments[1].add_commands === undefined &&
    amendment.amendments[1].add_public_surface === undefined,
  'module surface or dependency amendment widened',
)
check(
  'strict policy and migration bind D2 to the conversation-link parent',
  policy.manifest_amendments.includes(amendmentPath) &&
    migration.base_commit === '297bc2700eec77e2a06fbdfee4b57867650ba719' &&
    migration.source_commit === 'b1f911b7b17273363df764d6e312a40c9f0fa8fc',
  'policy or evidence lineage drifted',
)

const directSliceRetirements = [
  'arch_7a237a87ee8e273e95604997',
  'arch_12898585c8b3ccee8d3ea85a',
  'arch_d3a1aee5a5e33bdb5a5d6cce',
  'arch_b2695dfa3531c0d237e7fce3',
  'arch_4b2e1e3af0bdf531180daa15',
  'arch_5058caaa02cc2b4b461f5f6a',
  'arch_225fae9337a3c287581451da',
  'arch_a7e099839eaf42e321bcb61f',
  'arch_1a5dd98552731f69df510d4f',
  'arch_6f528eedb0009b2e5fda34d9',
  'arch_e9eae0979b7c84dba46941bb',
  'arch_dcd2086fa84a6f10de82654b',
  'arch_8b3e425d7529f4425243bd47',
  'arch_66a14ce1b5d8219d467235f1',
]
const structuralEdgeRetirements = [
  'arch_dffadff52c7f131dec9fb5df',
  'arch_6e7cdb68eb4f435d44dd2071',
  'arch_769499f033ab35fa6c893698',
  'arch_4f9652672c7bd39182b46e35',
  'arch_89026328f5535b239dafcfcc',
  'arch_898401b584810ba53832d60b',
  'arch_8d26dad454c1d5baba4ed885',
  'arch_d5f00eddbc56bb1d6520a79a',
  'arch_95fe787bec52d896b8755882',
  'arch_9741e0bb3407601906823452',
  'arch_41465e0831ba0392d03c0425',
  'arch_76820e608c8736956049675d',
]
const exactRetirements = [...directSliceRetirements, ...structuralEdgeRetirements]
const registryRules = [
  'direct_foreign_prisma_write',
  'direct_provider_transport_access',
  'internal_module_import',
  'non_public_cross_context_import',
  'undeclared_dependency',
]
const registryFingerprints = registry.exceptions.map(entry => entry.fingerprint)
const registrySummaryCount = rule => registry.summary?.[rule] ?? 0
const registrySummaryIsExact =
  registry.schema === 'yoko.crm.architecture-exception-registry.v1' &&
  registry.version === 1 &&
  registry.milestone === policy.registry_milestone &&
  registry.base_commit === policy.registry_base_commit &&
  registry.policy?.exact_fingerprint_only === true &&
  registry.policy?.stale_exceptions_fail === true &&
  registry.policy?.expired_exceptions_fail === true &&
  registry.policy?.uncovered_violations_fail === true &&
  registry.policy?.deadline === policy.exception_review_deadline &&
  Object.keys(registry.summary ?? {}).every(rule => registryRules.includes(rule)) &&
  registryRules.every(rule =>
    Number.isInteger(registrySummaryCount(rule)) &&
    registrySummaryCount(rule) >= 0 &&
    registrySummaryCount(rule) === registry.exceptions.filter(entry => entry.rule === rule).length
  ) &&
  registryRules.reduce((total, rule) => total + registrySummaryCount(rule), 0) === registry.exceptions.length &&
  registryFingerprints.every(fingerprint => typeof fingerprint === 'string' && /^arch_[a-f0-9]{24}$/.test(fingerprint)) &&
  new Set(registryFingerprints).size === registryFingerprints.length
const normalizedSuccessorRegistry =
  registrySummaryIsExact &&
  currentEnforcement.ok &&
  currentEnforcement.findings === 0 &&
  registry.exceptions.length === 0 &&
  Object.keys(registry.summary ?? {}).length === 0
check(
  'accepted D2 retirements remain closed in later strict registries',
  registrySummaryIsExact &&
    currentEnforcement.ok &&
    currentEnforcement.findings === registry.exceptions.length &&
    registry.exceptions.length <= 1381 &&
    registrySummaryCount('direct_foreign_prisma_write') <= 82 &&
    registrySummaryCount('direct_provider_transport_access') <= 38 &&
    registrySummaryCount('internal_module_import') <= 375 &&
    registrySummaryCount('non_public_cross_context_import') <= 532 &&
    registrySummaryCount('undeclared_dependency') <= 354 &&
    exactRetirements.every(fingerprint => !registry.exceptions.some(entry => entry.fingerprint === fingerprint)) &&
    !registry.exceptions.some(entry => entry.file.includes('legacy-prisma-scenario-field-settings-adapter.ts')),
  'registry monotonicity, retirements or owner-local classification drifted',
)
check(
  'non-public protections survive the context-edge undeclared retirement',
  normalizedSuccessorRegistry || (
    registry.exceptions.filter(entry =>
      entry.file === 'gravity-mvp/src/lib/config-validator.ts' &&
      entry.target_context === 'work_management' &&
      ['internal_module_import', 'non_public_cross_context_import'].includes(entry.rule)
    ).length === 22 &&
      registry.exceptions.filter(entry =>
        entry.file === 'gravity-mvp/src/app/settings/scenarios/[id]/fields/page.tsx' &&
        entry.target_context === 'work_management' &&
        ['internal_module_import', 'non_public_cross_context_import'].includes(entry.rule)
      ).length === 2
  ),
  'accepted edge erased a retained internal or non-public protection',
)
check(
  'verified comparison records fourteen direct and twelve structural retirements exactly',
  JSON.stringify(migration.enforcement?.direct_slice_retirements) === JSON.stringify(directSliceRetirements) &&
    JSON.stringify(migration.enforcement?.structural_edge_retirements) === JSON.stringify(structuralEdgeRetirements) &&
    migration.enforcement?.baseline_findings === 1407 &&
    migration.enforcement?.actual_findings === 1381 &&
    migration.enforcement?.actual_removed === 26 &&
    migration.enforcement?.actual_added === 0 &&
    migration.enforcement?.actual_changed_shared_entries === 0 &&
    migration.enforcement?.finding_digest === '679a367687a98ca41a9ca2a2bfff3b5af0a16e0cfe67dc663b01a13719875743' &&
    migration.enforcement?.registry_sha256 === 'c4b786276dd7e896f3cbc321b2eaa4e33a71296347c1cde3cdb68885b40727f0' &&
    migration.enforcement?.registry_deterministic === true,
  'registry comparison evidence drifted',
)
check(
  'historical Configuration-owner plan is preserved and explicitly superseded by D2',
  migration.historical_plan?.id === 'migration_cf5479ae3da99ee5' &&
    migration.historical_plan?.disposition === 'SUPERSEDED_BY_ARCHITECTURE_LEAD_D2' &&
    migration.historical_plan?.source_artifact_mutated === false,
  'historical plan disposition is absent or rewritten',
)
check(
  'behavior hashes and verification retain the source-only non-execution boundary',
  behavior.source_commit === 'b1f911b7b17273363df764d6e312a40c9f0fa8fc' &&
    JSON.stringify(frozenBehaviorSources.map(([file]) => file).sort()) ===
      JSON.stringify(Object.values(paths).sort()) &&
    frozenBehaviorSources.every(([file, expected]) => sha(file) === expected) &&
    verification.database_accessed === false &&
    verification.scenario_field_settings_executed_against_database === false &&
    verification.runtime_or_provider_invoked === false &&
    verification.production_mutated === false &&
    verification.secret_values_read_or_emitted === false,
  'source hash or non-execution evidence drifted',
)

process.stdout.write(`${JSON.stringify({
  status: failures.length > 0 ? 'FAIL' : 'PASS',
  sourceOnly: true,
  checks,
  failures,
}, null, 2)}\n`)
if (failures.length > 0) process.exitCode = 1
