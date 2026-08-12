#!/usr/bin/env node
import { readFile } from 'node:fs/promises'

const path = process.argv[2] ?? 'architecture/recovery/whole-project-dod/v2/AMBIGUOUS_WRITE_TRIAGE_RECONCILED_20260811.json'
const document = JSON.parse(await readFile(path, 'utf8'))
const records = document.records ?? []
const ids = records.map(record => record.record_id)
if (records.length !== new Set(ids).size) throw new Error('triage reconciliation has duplicate record IDs')
if (document.summary.RAW_BASELINE_AMBIGUOUS !== records.length) throw new Error('raw ambiguous count drift')
const states = new Set(['RESOLVED_NON_WRITE', 'OWNER_VALID_WRITE', 'CONTROLLED_MIGRATION_WRITE', 'MATERIAL_UNRESOLVED_WRITE_RISK'])
if (records.some(record => !states.has(record.semantic_state))) throw new Error('record missing semantic state')
const counts = Object.fromEntries([...states].map(state => [state, records.filter(record => record.semantic_state === state).length]))
if (Object.values(counts).reduce((sum, count) => sum + count, 0) !== records.length) throw new Error('semantic state total drift')
if (document.summary.RECONCILIATION_TOTAL !== records.length || document.summary.RECONCILIATION_EXACT !== true) throw new Error('reconciliation summary mismatch')
if (document.summary.RESOLVED_NON_WRITE !== counts.RESOLVED_NON_WRITE) throw new Error('resolved non-write count drift')
if (document.summary.MATERIAL_UNRESOLVED_WRITE_RISK !== counts.MATERIAL_UNRESOLVED_WRITE_RISK) throw new Error('material ambiguity count drift')
if (counts.RESOLVED_NON_WRITE < 27) throw new Error('static SELECT reclassification regression')
for (const id of [
  '36c9b52b2b9c7b0d7ec8bec4120e6772b5421558fb0f591ed1ef2f9306aadce7',
  'e1c81095a11532a1ba56e2629b9316a15d42ad5062aa52dfa190283adb26f5e1',
  'd0c82d56b1ebc1290af28a4c3add0047a2da0f9ab7cf0643ae9ac5ccd3920fc9',
]) {
  if (records.find(record => record.record_id === id)?.semantic_state !== 'RESOLVED_NON_WRITE') throw new Error(`read-only SQL regression for ${id}`)
}
console.log(`triage reconciliation: PASS (${records.length} records; ${counts.RESOLVED_NON_WRITE} non-writes resolved; ${counts.OWNER_VALID_WRITE} owner-valid; ${counts.MATERIAL_UNRESOLVED_WRITE_RISK} material unresolved)`)
