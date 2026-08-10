#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

const [triagePath, outputPath, decisionsPath] = process.argv.slice(2)
if (!triagePath || !outputPath || !decisionsPath) throw new Error('usage: materialize-maintenance-capabilities.mjs TRIAGE.json OUTPUT.json DECISIONS.json')
const triage = JSON.parse(await readFile(triagePath, 'utf8'))
const decisions = JSON.parse(await readFile(decisionsPath, 'utf8'))
const decisionsBySignature = new Map()
for (const decision of decisions.decisions ?? []) {
  for (const signature of decision.site_signatures ?? []) {
    if (decisionsBySignature.has(signature)) throw new Error(`duplicate maintenance decision for ${signature}`)
    decisionsBySignature.set(signature, decision)
  }
}
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
  const matchedDecisions = [...new Set(records.map(record => decisionsBySignature.get(record.site_signature)).filter(Boolean))]
  if (matchedDecisions.length > 1) throw new Error(`conflicting maintenance decisions for ${first.file} ${first.method}`)
  const decision = matchedDecisions[0] ?? null
  if (decision && records.some(record => !decision.site_signatures.includes(record.site_signature))) {
    throw new Error(`partial maintenance decision for grouped capability ${first.file} ${first.method}`)
  }
  const effectiveOwner = decision?.functional_owner ?? group.owner
  const effectiveLifecycle = decision?.lifecycle ?? lifecycle(first.file)
  const effectiveTargets = decision?.target?.exact_names ?? group.targets
  const canonical = JSON.stringify({ source: first.file, owner: effectiveOwner, lifecycle: effectiveLifecycle, targets: effectiveTargets, operation: first.method })
  const id = `mmc.v1.${effectiveOwner.toLowerCase()}.${createHash('sha256').update(canonical).digest('hex').slice(0, 16)}`
  const remediated = ['gravity-mvp/scripts/sync-drivers-activity.ts', 'gravity-mvp/scripts/trigger_import.js'].includes(first.file)
  const approved = decision?.status === 'APPROVED'
  return {
    capability_id: id,
    status: approved ? 'APPROVED' : remediated ? 'REMEDIATED_PENDING_AUTHORITATIVE_RESCAN' : 'PENDING_EVIDENCE',
    approved,
    source: { path: first.file, entrypoint: first.file, site_signatures: records.map(record => record.site_signature) },
    lifecycle: effectiveLifecycle,
    lifecycle_evidence_status: decision?.lifecycle_evidence_status ?? 'PENDING_ENTRYPOINT_REACHABILITY_REVIEW',
    lifecycle_evidence: decision?.lifecycle_evidence ?? null,
    functional_owner: effectiveOwner,
    target: { data_owner: decision?.target?.data_owner ?? effectiveOwner, exact_names: effectiveTargets, operations: decision?.target?.operations ?? [first.method] },
    execution: decision?.execution ?? { mechanism: 'DIRECT_DATABASE_CALL_IN_FROZEN_SOURCE', owner_controlled_adapter_required: true },
    invocation: decision?.invocation ?? { production_reachability: first.surface?.production_capability ?? 'UNKNOWN', current_caller: first.source_context ?? null },
    recurring: decision?.recurring ?? false,
    cross_domain: decision?.cross_domain ?? Boolean(first.source_context && !first.owner_contexts.includes(first.source_context)),
    architecture_path: decision?.architecture_path ?? `${first.source_context ?? 'operational caller'} -> ${effectiveOwner} owner-controlled maintenance/migration capability -> exact target operation`,
    retirement_condition: decision?.retirement_condition ?? (effectiveLifecycle === 'ONE_SHOT_PENDING_RETIREMENT' ? 'remove from active executable inventory after evidenced completion' : null),
    enforcement: { match: ['source.path', 'site_signature', 'target.data_owner', 'target.exact_names', 'target.operations'], unrelated_model_write_must_fail: true, unrelated_destructive_operation_must_fail: true },
    baseline: triage.baseline,
  }
}).sort((a, b) => a.capability_id.localeCompare(b.capability_id))
const output = {
  schema: 'yoko.crm.maintenance-migration-capability-registry.v1',
  authority: 'DERIVED_FROM_FROZEN_BASELINE_NOT_AN_APPROVAL',
  baseline: triage.baseline,
  decisions_source: decisionsPath,
  summary: { source_records: sites.length, preliminary_units: capabilities.length, approved: capabilities.filter(row => row.status === 'APPROVED').length, pending_evidence: capabilities.filter(row => row.status === 'PENDING_EVIDENCE').length, remediated_pending_rescan: capabilities.filter(row => row.status === 'REMEDIATED_PENDING_AUTHORITATIVE_RESCAN').length },
  policy: 'No file, directory, script family, owner, or model is broadly approved. Every active capability must match exact source, site, owner, target and operation.',
  capabilities,
}
await writeFile(`${outputPath}.tmp`, `${JSON.stringify(output, null, 2)}\n`)
await rename(`${outputPath}.tmp`, outputPath)
