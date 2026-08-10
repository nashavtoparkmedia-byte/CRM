#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'

const root = process.cwd()
const require = createRequire(import.meta.url)
const ts = require(path.join(root, 'gravity-mvp/node_modules/typescript/lib/typescript.js'))
const actionsPath = path.join(root, 'gravity-mvp/src/app/settings/scenarios/actions.ts')
const clientPath = path.join(
  root,
  'gravity-mvp/src/app/settings/scenarios/[id]/fields/ScenarioFieldsSettingsClient.tsx',
)
const internalPath = path.join(root, 'gravity-mvp/src/lib/tasks/scenario-settings.ts')
const actionsSource = readFileSync(actionsPath, 'utf8')
const clientSource = readFileSync(clientPath, 'utf8')
const internalSource = readFileSync(internalPath, 'utf8')
const actionsOutput = ts.transpileModule(actionsSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText

const checks = []
const check = (name, fn) => { fn(); checks.push(name) }
const checkAsync = async (name, fn) => { await fn(); checks.push(name) }
const plain = (value) => JSON.parse(JSON.stringify(value))

const ids = {
  GET_MERGED_SCENARIO_FIELDS_QUERY_V1: 'work_management.GetMergedScenarioFieldsQuery.v1',
  UPSERT_SCENARIO_FIELD_SETTING_COMMAND_V1: 'work_management.UpsertScenarioFieldSettingCommand.v1',
  RESET_SCENARIO_FIELD_SETTING_COMMAND_V1: 'work_management.ResetScenarioFieldSettingCommand.v1',
}

function loadActions(overrides = {}) {
  const events = []
  const fields = overrides.fields ?? [{ id: 'reason', order: 0, hasOverride: false }]
  const publicApi = {
    async getMergedScenarioFieldsV1(command) {
      events.push(['get', command])
      if (overrides.getError) throw overrides.getError
      return { contract: 'work_management.GetMergedScenarioFieldsResult.v1', fields }
    },
    async upsertScenarioFieldSettingV1(command) {
      events.push(['upsert', command])
      if (overrides.upsertError) throw overrides.upsertError
      return { contract: 'work_management.UpsertScenarioFieldSettingResult.v1', completed: true }
    },
    async resetScenarioFieldSettingV1(command) {
      events.push(['reset', command])
      if (overrides.resetError) throw overrides.resetError
      return { contract: 'work_management.ResetScenarioFieldSettingResult.v1', completed: true }
    },
  }
  const headers = {
    async cookies() {
      events.push(['cookies'])
      return {
        get(name) {
          events.push(['cookie.get', name])
          return overrides.cookieValue === undefined
            ? { value: 'actor-7' }
            : overrides.cookieValue === null ? undefined : { value: overrides.cookieValue }
        },
      }
    },
  }
  const module = { exports: {} }
  vm.runInNewContext(actionsOutput, {
    module,
    exports: module.exports,
    require(specifier) {
      if (specifier === '@/contracts/work-management/v1') return ids
      if (specifier === '@/modules/work-management/public/v1') return publicApi
      if (specifier === 'next/headers') return headers
      if (specifier === '@/lib/tasks/scenario-settings-types') return {}
      throw new Error(`unexpected actions import: ${specifier}`)
    },
  })
  return { actions: module.exports, events, fields }
}

function functionSlice(source, declaration, nextDeclaration) {
  const start = source.indexOf(declaration)
  assert.notEqual(start, -1, `missing ${declaration}`)
  const end = nextDeclaration ? source.indexOf(nextDeclaration, start + declaration.length) : source.length
  assert.notEqual(end, -1, `missing ${nextDeclaration}`)
  return source.slice(start, end)
}

check('Configuration actions import only the exact Work public contracts and facades', () => {
  assert.doesNotMatch(actionsSource, /from\s+['"]@\/lib\/tasks\/scenario-settings['"]/)
  for (const name of Object.keys(ids)) assert.match(actionsSource, new RegExp(`\\b${name}\\b`))
  for (const name of [
    'getMergedScenarioFieldsV1',
    'upsertScenarioFieldSettingV1',
    'resetScenarioFieldSettingV1',
  ]) assert.match(actionsSource, new RegExp(`\\b${name}\\b`))
  assert.match(actionsSource, /from\s+['"]@\/contracts\/work-management\/v1['"]/)
  assert.match(actionsSource, /from\s+['"]@\/modules\/work-management\/public\/v1['"]/)
})

await checkAsync('get action delegates the exact query and returns only fields', async () => {
  const { actions, events, fields } = loadActions()
  const result = await actions.getScenarioFieldsConfig('driver_return')
  assert.deepEqual(plain(result), fields)
  assert.deepEqual(plain(events), [[
    'get', { contract: ids.GET_MERGED_SCENARIO_FIELDS_QUERY_V1, scenarioId: 'driver_return' },
  ]])
})

await checkAsync('update reads cookie actor before sending the exact patch command', async () => {
  const { actions, events } = loadActions()
  const patch = { showInList: false, order: 0 }
  assert.equal(await actions.updateScenarioFieldSetting('driver_return', 'reason', patch), undefined)
  assert.deepEqual(plain(events), [
    ['cookies'],
    ['cookie.get', 'crm_user_id'],
    ['upsert', {
      contract: ids.UPSERT_SCENARIO_FIELD_SETTING_COMMAND_V1,
      scenarioId: 'driver_return', fieldId: 'reason', patch, userId: 'actor-7',
    }],
  ])
})

await checkAsync('missing cookie maps to null without changing actor ordering', async () => {
  const { actions, events } = loadActions({ cookieValue: null })
  await actions.updateScenarioFieldSetting('driver_return', 'reason', {})
  assert.deepEqual(plain(events), [
    ['cookies'],
    ['cookie.get', 'crm_user_id'],
    ['upsert', {
      contract: ids.UPSERT_SCENARIO_FIELD_SETTING_COMMAND_V1,
      scenarioId: 'driver_return', fieldId: 'reason', patch: {}, userId: null,
    }],
  ])
})

await checkAsync('reorder preserves cookie lookup then the exact zero-capable order patch', async () => {
  const { actions, events } = loadActions()
  await actions.reorderScenarioField('driver_return', 'reason', 0)
  assert.deepEqual(plain(events), [
    ['cookies'],
    ['cookie.get', 'crm_user_id'],
    ['upsert', {
      contract: ids.UPSERT_SCENARIO_FIELD_SETTING_COMMAND_V1,
      scenarioId: 'driver_return', fieldId: 'reason', patch: { order: 0 }, userId: 'actor-7',
    }],
  ])
})

await checkAsync('reset delegates directly without adding actor or cookie behavior', async () => {
  const { actions, events } = loadActions()
  assert.equal(await actions.resetScenarioField('driver_return', 'reason'), undefined)
  assert.deepEqual(plain(events), [[
    'reset', {
      contract: ids.RESET_SCENARIO_FIELD_SETTING_COMMAND_V1,
      scenarioId: 'driver_return', fieldId: 'reason',
    },
  ]])
})

await checkAsync('public read write and reset failures remain visible to Configuration', async () => {
  await assert.rejects(loadActions({ getError: new Error('get down') }).actions
    .getScenarioFieldsConfig('driver_return'), /get down/)
  await assert.rejects(loadActions({ upsertError: new Error('write down') }).actions
    .updateScenarioFieldSetting('driver_return', 'reason', {}), /write down/)
  await assert.rejects(loadActions({ resetError: new Error('reset down') }).actions
    .resetScenarioField('driver_return', 'reason'), /reset down/)
})

check('client retains optimistic toggle then refresh sequencing', () => {
  const toggle = functionSlice(clientSource, 'const toggle =', 'const move =')
  assert.ok(toggle.indexOf('setFields(') < toggle.indexOf('startTransition('))
  assert.ok(toggle.indexOf('updateScenarioFieldSetting(') < toggle.indexOf('await refresh()'))
  assert.match(toggle, /\{\s*\[prop\]\s*:\s*value\s*\}/)
})

check('client retains concurrent full reorder and refresh-after-all behavior', () => {
  const move = functionSlice(clientSource, 'const move =', 'return (')
  assert.match(move, /Promise\.all\s*\(\s*reordered\.map/)
  assert.match(move, /reorderScenarioField\s*\(\s*scenarioId\s*,\s*f\.id\s*,\s*i\s*\)/)
  assert.ok(move.indexOf('await Promise.all(') < move.indexOf('await refresh()'))
  assert.match(move, /setFields\s*\(\s*reordered\.map/)
})

check('Work internal batch reader keeps its empty guard one tagged query and map grouping', () => {
  const batch = functionSlice(
    internalSource,
    'export async function getAllScenarioSettingsMap',
    'export function mergeFieldsWithOverrides',
  )
  assert.match(batch, /if\s*\(scenarioIds\.length\s*===\s*0\)\s*return new Map\(\)/)
  assert.equal((batch.match(/prisma\.\$queryRaw/g) ?? []).length, 1)
  assert.match(batch, /WHERE\s+"scenarioId"\s*=\s*ANY\(\$\{scenarioIds\}\)/)
  assert.match(batch, /if\s*\(!map\.has\(row\.scenarioId\)\)\s*map\.set\(row\.scenarioId,\s*\[\]\)/)
  assert.match(batch, /map\.get\(row\.scenarioId\)!\.push\(row\)/)
})

check('Work internal pure merge keeps nullish fallback override flag order default and sorting', () => {
  const merge = functionSlice(internalSource, 'export function mergeFieldsWithOverrides', undefined)
  for (const field of ['showInList', 'showInCard', 'filterable', 'sortable', 'groupable']) {
    assert.match(merge, new RegExp(`ov\\?\\.${field}\\s*\\?\\?\\s*def\\.${field}`))
  }
  assert.match(merge, /order:\s*ov\?\.order\s*\?\?\s*index/)
  assert.match(merge, /hasOverride:\s*!!ov/)
  assert.match(merge, /\.sort\(\(a,\s*b\)\s*=>\s*a\.order\s*-\s*b\.order\)/)
})

process.stdout.write(`${JSON.stringify({ status: 'PASS', passed: checks.length, checks }, null, 2)}\n`)
