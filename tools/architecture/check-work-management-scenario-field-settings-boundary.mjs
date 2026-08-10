#!/usr/bin/env node

import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const read = (relative) => readFileSync(path.join(root, relative), 'utf8')
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

process.stdout.write(`${JSON.stringify({
  status: failures.length > 0 ? 'FAIL' : 'PASS',
  sourceOnly: true,
  checks,
  failures,
}, null, 2)}\n`)
if (failures.length > 0) process.exitCode = 1
