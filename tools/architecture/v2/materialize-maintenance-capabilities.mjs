#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

const [triagePath, outputPath] = process.argv.slice(2)
if (!triagePath || !outputPath) throw new Error('usage: materialize-maintenance-capabilities.mjs TRIAGE.json OUTPUT.json')
const triage = JSON.parse(await readFile(triagePath, 'utf8'))
const sites = triage.records.filter(record => record.final_ownership_classification === 'MAINTENANCE_MIGRATION_CAPABILITY')

function lifecycle(file) {
  const name = path.basename(file).toLowerCase()
  if (/backfill/u.test(name)) return 'BACKFILL'
  if (/(?:migrat|schema|pg_restore|baseline|rollback)/u.test(`${file} ${name}`)) return 'CONTROLLED_MIGRATION'
  if (/(?:cleanup|clean-|wipe|dedup|merge|fix|strip|clamp|purge|repair)/u.test(name)) return 'CLEANUP'
  if (/(?:import|seed|sync)/u.test(name)) return 'IMPORT'
  return 'ONE_SHOT_PENDING_RETIREMENT'
}
function targetNames(record) {
  return [...new Set([record.model, ...(record.candidate_models ?? []), ...(record.tables ?? [])].filter(Boolean))].sort()
}
const groups = new Map()
for (const record of sites) {
  const owner = record.owner_contexts.length === 1 ? record.owner_contexts[0] : record.owner_contexts.length ? 'CROSS_DOMAIN' : 'UNRESOLVED'
  const key = JSON.stringify({ file: record.file, owner, targets: targetNames(record), method: record.method })
  if (!groups.has(key)) groups.set(key, { owner, targets: targetNames(record), records: [] })
  groups.get(key).records.push(record)
}
const capabilities = [...groups.values()].map(group => {
  const records = group.records.sort((a, b) => a.site_signature.localeCompare(b.site_signature))
  const first = records[0]
  const canonical = JSON.stringify({ source: first.file, owner: group.owner, lifecycle: lifecycle(first.file), targets: group.targets, operation: first.method })
  const id = `mmc.v1.${group.owner.toLowerCase()}.${createHash('sha256').update(canonical).digest('hex').slice(0, 16)}`
  const remediated = ['gravity-mvp/scripts/sync-drivers-activity.ts', 'gravity-mvp/scripts/trigger_import.js'].includes(first.file)
  return {
    capability_id: id,
    status: remediated ? 'REMEDIATED_PENDING_AUTHORITATIVE_RESCAN' : 'PENDING_EVIDENCE',
    approved: false,
    source: { path: first.file, entrypoint: first.file, site_signatures: records.map(record => record.site_signature) },
    lifecycle: lifecycle(first.file),
    lifecycle_evidence_status: 'PENDING_ENTRYPOINT_REACHABILITY_REVIEW',
    functional_owner: group.owner,
    target: { data_owner: group.owner, exact_names: group.targets, operations: [first.method] },
    execution: { mechanism: 'DIRECT_DATABASE_CALL_IN_FROZEN_SOURCE', owner_controlled_adapter_required: true },
    invocation: { production_reachability: first.surface?.production_capability ?? 'UNKNOWN', current_caller: first.source_context ?? null },
    recurring: false,
    cross_domain: Boolean(first.source_context && !first.owner_contexts.includes(first.source_context)),
    architecture_path: `${first.source_context ?? 'operational caller'} -> ${group.owner} owner-controlled maintenance/migration capability -> exact target operation`,
    retirement_condition: lifecycle(first.file) === 'ONE_SHOT_PENDING_RETIREMENT' ? 'remove from active executable inventory after evidenced completion' : null,
    enforcement: { match: ['source.path', 'site_signature', 'target.data_owner', 'target.exact_names', 'target.operations'], unrelated_model_write_must_fail: true, unrelated_destructive_operation_must_fail: true },
    baseline: triage.baseline,
  }
}).sort((a, b) => a.capability_id.localeCompare(b.capability_id))
const output = {
  schema: 'yoko.crm.maintenance-migration-capability-registry.v1',
  authority: 'DERIVED_FROM_FROZEN_BASELINE_NOT_AN_APPROVAL',
  baseline: triage.baseline,
  summary: { source_records: sites.length, preliminary_units: capabilities.length, approved: 0, pending_evidence: capabilities.filter(row => row.status === 'PENDING_EVIDENCE').length, remediated_pending_rescan: capabilities.filter(row => row.status === 'REMEDIATED_PENDING_AUTHORITATIVE_RESCAN').length },
  policy: 'No file, directory, script family, owner, or model is broadly approved. Every active capability must match exact source, site, owner, target and operation.',
  capabilities,
}
await writeFile(`${outputPath}.tmp`, `${JSON.stringify(output, null, 2)}\n`)
await rename(`${outputPath}.tmp`, outputPath)
