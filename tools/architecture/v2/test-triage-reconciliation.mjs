#!/usr/bin/env node
import { readFile } from 'node:fs/promises'

const path = process.argv[2] ?? 'architecture/recovery/whole-project-dod/v2/AMBIGUOUS_WRITE_TRIAGE_RECONCILED_20260811.json'
const document = JSON.parse(await readFile(path, 'utf8'))
const records = document.records ?? []
const ids = records.map(record => record.record_id)
if (records.length !== new Set(ids).size) throw new Error('triage reconciliation has duplicate record IDs')
if (records.length !== 55) throw new Error('fresh source-freeze ambiguity denominator drift')
if (document.summary.RAW_BASELINE_AMBIGUOUS !== records.length) throw new Error('raw ambiguous count drift')
const states = new Set(['RESOLVED_NON_WRITE', 'OWNER_VALID_WRITE', 'CONTROLLED_MIGRATION_WRITE', 'MATERIAL_UNRESOLVED_WRITE_RISK'])
if (records.some(record => !states.has(record.semantic_state))) throw new Error('record missing semantic state')
const counts = Object.fromEntries([...states].map(state => [state, records.filter(record => record.semantic_state === state).length]))
if (Object.values(counts).reduce((sum, count) => sum + count, 0) !== records.length) throw new Error('semantic state total drift')
if (document.summary.RECONCILIATION_TOTAL !== records.length || document.summary.RECONCILIATION_EXACT !== true) throw new Error('reconciliation summary mismatch')
if (document.summary.RESOLVED_NON_WRITE !== counts.RESOLVED_NON_WRITE) throw new Error('resolved non-write count drift')
if (document.summary.MATERIAL_UNRESOLVED_WRITE_RISK !== counts.MATERIAL_UNRESOLVED_WRITE_RISK) throw new Error('material ambiguity count drift')
if (counts.RESOLVED_NON_WRITE < 27) throw new Error('static SELECT reclassification regression')
if (counts.RESOLVED_NON_WRITE !== 34 || counts.OWNER_VALID_WRITE !== 17 || counts.CONTROLLED_MIGRATION_WRITE !== 4 || counts.MATERIAL_UNRESOLVED_WRITE_RISK !== 0) {
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
for (const id of [
  'c07dfc3bed1350a52ef31d97f73d18c09f81f104519a4c4268849ec1800eae21',
  'a41cc5d01ac2e6699c6b86dcd306a933a2f5b0cb954d2bcf8668fe3dc81afcb5',
  'e902f9c46033a4363ccbe77b17ec468df4052eff323e009d8934906763c7ff7a',
  'cf582460b117a919402f002cc2e6d46c86c2705456e676e4bb8eb416712dcdd4',
  'e54be07b8050d4ff83e4f53490c748987cfc4b96708d9a237291e20a5cbdb240',
  '1155e3e8871948983914b57936052d47582d93288599be197d0e087b543f9fe1',
  '6e7331a679f00f5453dcda4a4b0b66f9a0fbe81b250152f4b9cc138eb1c6e567',
  '4725bd8e337bd59adcedfd797a456722a31f900ddabc83ebeb64a6d990850978',
  '4290848e7cb22a18b0ea2ae7e44a4e922a951d64d94e613357a08e51e3f77993',
  '8094e623e03dce25fee65e3d52acb95d4829fce9229d77976ac54b6f31fa19a7',
  '14602442299bcce66d1f52e21acc108ae4718e87affc4e4bbd69823cc68011ce',
  '368bd8ff0ab5fddba71b1faced7c709383a4f40c610f7a248fa47c720e0ea874',
  '2d9fe65392a642c52a7f3fc0ee35856583113275a12526a71afc486579742fe4',
  '269fe8d0c425f83ce1d07f1c25c6da409d023629a7f328ecaf387b99865e0485',
]) {
  if (records.find(record => record.record_id === id)?.semantic_state !== 'OWNER_VALID_WRITE') throw new Error(`PR #81 owner-valid synchronization write regression for ${id}`)
}
for (const id of [
  '533bbfc7fcb9eefd891434ec44f0bea3b96e58247c11e3633616c7911584d6c5',
  '4866ecccc1c91eac5a9ae495bb91005ba88c8549537913e1a3953e3b355e3659',
]) {
  if (records.find(record => record.record_id === id)?.semantic_state !== 'RESOLVED_NON_WRITE') throw new Error(`PR #81 read-only invariant projection regression for ${id}`)
}
for (const retiredSignature of [
  '711663b47640204499f4f8dbdcdcc2356846fe132df01598f4300e04f042ebd8',
  'cdfc8a0d9138116700c4cff4485bb0da57fb0a9138859e77c766277e0ae5d4fe',
  'b00356e49038391b1ecb1efbefd7c929b2e1e15f2cc6580a32df27a68f04c982',
  'd0c82d56b1ebc1290af28a4c3add0047a2da0f9ab7cf0643ae9ac5ccd3920fc9',
  'c3b1d82673f656bcf2590f40a70eb462c4ebc1a89a7a78f8bb8cf53565c124f1',
]) {
  if (records.some(record => record.record_id === retiredSignature)) throw new Error(`retired ambiguity signature leaked into current review: ${retiredSignature}`)
}
const retiredRollbackPath = 'gravity-mvp/scripts/rollback_knowledge_core.js'
if (records.some(record => record.file === retiredRollbackPath)) throw new Error('permanently disabled historical rollback leaked into live ambiguity denominator')
console.log(`triage reconciliation: PASS (${records.length} records; ${counts.RESOLVED_NON_WRITE} non-writes resolved; ${counts.OWNER_VALID_WRITE} owner-valid; ${counts.MATERIAL_UNRESOLVED_WRITE_RISK} material unresolved)`)
