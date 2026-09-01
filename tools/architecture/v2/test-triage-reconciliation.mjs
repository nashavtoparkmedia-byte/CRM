#!/usr/bin/env node
import { readFile } from 'node:fs/promises'

const path = process.argv[2] ?? 'architecture/recovery/whole-project-dod/v2/AMBIGUOUS_WRITE_TRIAGE_RECONCILED_20260811.json'
const document = JSON.parse(await readFile(path, 'utf8'))
const records = document.records ?? []
const ids = records.map(record => record.record_id)
if (records.length !== new Set(ids).size) throw new Error('triage reconciliation has duplicate record IDs')
if (records.length !== 41) throw new Error('fresh source-freeze ambiguity denominator drift')
if (document.summary.RAW_BASELINE_AMBIGUOUS !== records.length) throw new Error('raw ambiguous count drift')
const states = new Set(['RESOLVED_NON_WRITE', 'OWNER_VALID_WRITE', 'CONTROLLED_MIGRATION_WRITE', 'MATERIAL_UNRESOLVED_WRITE_RISK'])
if (records.some(record => !states.has(record.semantic_state))) throw new Error('record missing semantic state')
const counts = Object.fromEntries([...states].map(state => [state, records.filter(record => record.semantic_state === state).length]))
if (Object.values(counts).reduce((sum, count) => sum + count, 0) !== records.length) throw new Error('semantic state total drift')
if (document.summary.RECONCILIATION_TOTAL !== records.length || document.summary.RECONCILIATION_EXACT !== true) throw new Error('reconciliation summary mismatch')
if (document.summary.RESOLVED_NON_WRITE !== counts.RESOLVED_NON_WRITE) throw new Error('resolved non-write count drift')
if (document.summary.MATERIAL_UNRESOLVED_WRITE_RISK !== counts.MATERIAL_UNRESOLVED_WRITE_RISK) throw new Error('material ambiguity count drift')
if (counts.RESOLVED_NON_WRITE < 27) throw new Error('static SELECT reclassification regression')
if (counts.RESOLVED_NON_WRITE !== 34 || counts.OWNER_VALID_WRITE !== 3 || counts.CONTROLLED_MIGRATION_WRITE !== 4 || counts.MATERIAL_UNRESOLVED_WRITE_RISK !== 0) {
  throw new Error('fresh source-freeze ambiguity disposition count drift')
}
for (const id of [
  '42c9a964786f29fa8e6708acab43325249eba279ca89559fe07c03e7809bc9af',
  '2bd8011eca9a0188606fa41066e222d13e39e9fbdd930e6d6320422bb6842415',
]) {
  if (records.find(record => record.record_id === id)?.semantic_state !== 'RESOLVED_NON_WRITE') throw new Error(`read-only SQL regression for ${id}`)
}
for (const id of [
  'db58ec08efaa08ff46d65c6514af2e4e7f3ea91fc829291f3555696d5ab6ffe1',
  'ed73ec50cf0da00bc470d3f5bfd82747620760e0c4f6bfa706b42dff421ce67a',
  '3a19a0dbda9182e8fb61901a6f9645d519e97bfafed996916694e437e387d307',
  'e1bb0d06f7069896ad0113852070e1047b5b3226ad79cfe239943b95585c1827',
  '493cd2bbc915132b5b76f372dc8538929757c7ea4379ac3cfff69584e5a07c62',
  'daebc11dfee4c485a983a0160cab94ee9065ee492a46dcb13d73e5d7094b465a',
  'd9186fc05728ff6f00cac9f9eb60aee5df74438494c9a4b377c617d4e0bf07a3',
]) {
  if (records.find(record => record.record_id === id)?.semantic_state !== 'RESOLVED_NON_WRITE') throw new Error(`runtime v10 read-only SQL regression for ${id}`)
}
if (records.find(record => record.record_id === 'f7691415bdb4eb6bcb72502c8df0febd83b69ce0e9280e91988852663bc4a313')?.semantic_state !== 'OWNER_VALID_WRITE') {
  throw new Error('telegram owner-valid nested write regression')
}
for (const retiredSignature of [
  '711663b47640204499f4f8dbdcdcc2356846fe132df01598f4300e04f042ebd8',
  'cdfc8a0d9138116700c4cff4485bb0da57fb0a9138859e77c766277e0ae5d4fe',
]) {
  if (records.some(record => record.record_id === retiredSignature)) throw new Error(`retired ambiguity signature leaked into current review: ${retiredSignature}`)
}
const retiredRollbackPath = 'gravity-mvp/scripts/rollback_knowledge_core.js'
if (records.some(record => record.file === retiredRollbackPath)) throw new Error('permanently disabled historical rollback leaked into live ambiguity denominator')
console.log(`triage reconciliation: PASS (${records.length} records; ${counts.RESOLVED_NON_WRITE} non-writes resolved; ${counts.OWNER_VALID_WRITE} owner-valid; ${counts.MATERIAL_UNRESOLVED_WRITE_RISK} material unresolved)`)
