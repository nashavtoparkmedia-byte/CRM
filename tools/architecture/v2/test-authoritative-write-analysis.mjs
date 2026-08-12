#!/usr/bin/env node

import assert from 'node:assert/strict'

import { verifyAuthoritativeWriteAnalysis } from './verify-authoritative-write-analysis.mjs'

const triage = {
  summary: { RECONCILIATION_EXACT: true, MATERIAL_UNRESOLVED_WRITE_RISK: 0 },
  records: [{ site_signature: 'accepted-ambiguous' }],
}
const analysis = {
  schema: 'yoko.crm.whole-repository-write-analysis.v2',
  execution: { complete: true, worker_failures: 0, worker_timeouts: 0 },
  summary: {
    tracked_executable_surfaces: 10,
    discovered_write_sites: 3,
    foreign_writes: 0,
    parse_findings: 0,
    unreviewed_operational_surfaces: 0,
  },
  write_sites: [
    { classification: 'OWNER', site_signature: 'owner' },
    { classification: 'MIGRATION_ONLY', site_signature: 'migration' },
    { classification: 'AMBIGUOUS', site_signature: 'accepted-ambiguous', file: 'script.js', line: 1, method: '$queryRaw' },
  ],
}

assert.equal(verifyAuthoritativeWriteAnalysis(analysis, triage, analysis).status, 'PASS')
assert.throws(() => verifyAuthoritativeWriteAnalysis({
  ...analysis,
  summary: { ...analysis.summary, foreign_writes: 1 },
}, triage, analysis), /confirmed foreign write/)
assert.throws(() => verifyAuthoritativeWriteAnalysis({
  ...analysis,
  write_sites: [...analysis.write_sites, {
    classification: 'AMBIGUOUS', site_signature: 'new-ambiguous', file: 'new.js', line: 2, method: 'dynamic',
  }],
}, triage, analysis), /new write ambiguity/)
assert.throws(() => verifyAuthoritativeWriteAnalysis({
  ...analysis,
  execution: { ...analysis.execution, worker_timeouts: 1 },
}, triage, analysis), /worker timeout/)
assert.throws(() => verifyAuthoritativeWriteAnalysis({
  ...analysis,
  summary: { ...analysis.summary, unreviewed_operational_surfaces: 1 },
}, triage, analysis), /operational surface bypass/)

assert.throws(() => verifyAuthoritativeWriteAnalysis({
  ...analysis,
  summary: { ...analysis.summary, tracked_executable_surfaces: 0, discovered_write_sites: 0 },
}, triage, analysis), /surface denominator shrank/)

process.stdout.write('authoritative write analysis gate: PASS (6 negative properties)\n')
