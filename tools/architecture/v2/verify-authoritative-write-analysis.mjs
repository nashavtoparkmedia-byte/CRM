#!/usr/bin/env node

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export function verifyAuthoritativeWriteAnalysis(analysis, triage, acceptedAnalysis) {
  assert.equal(analysis.schema, 'yoko.crm.whole-repository-write-analysis.v2')
  assert.equal(analysis.execution?.complete, true, 'write analysis is incomplete')
  assert.equal(analysis.execution?.worker_failures, 0, 'write analyzer worker failure')
  assert.equal(analysis.execution?.worker_timeouts, 0, 'write analyzer worker timeout')
  assert.equal(analysis.summary?.parse_findings, 0, 'write analyzer parse finding')
  assert.equal(analysis.summary?.unreviewed_operational_surfaces, 0, 'operational surface bypass')
  assert.equal(analysis.summary?.foreign_writes, 0, 'confirmed foreign write')
  assert(
    analysis.summary?.tracked_executable_surfaces >= acceptedAnalysis.summary?.tracked_executable_surfaces,
    'tracked write-analysis surface denominator shrank without a reviewed baseline update',
  )
  assert(
    analysis.summary?.discovered_write_sites >= acceptedAnalysis.summary?.discovered_write_sites,
    'confirmed write-site denominator shrank without a reviewed baseline update',
  )
  assert.equal(triage.summary?.RECONCILIATION_EXACT, true, 'accepted ambiguity reconciliation is not exact')
  assert.equal(triage.summary?.MATERIAL_UNRESOLVED_WRITE_RISK, 0, 'accepted material ambiguity remains')

  const acceptedAmbiguous = new Set((triage.records ?? []).map((record) => record.site_signature))
  const currentAmbiguous = (analysis.write_sites ?? []).filter((site) => site.classification === 'AMBIGUOUS')
  const newAmbiguous = currentAmbiguous.filter((site) => !acceptedAmbiguous.has(site.site_signature))
  assert.deepEqual(newAmbiguous.map((site) => ({
    file: site.file,
    line: site.line,
    method: site.method,
    site_signature: site.site_signature,
  })), [], 'new write ambiguity must be triaged; it cannot pass as accepted')

  return {
    status: 'PASS',
    tracked_executable_surfaces: analysis.summary.tracked_executable_surfaces,
    discovered_write_sites: analysis.summary.discovered_write_sites,
    confirmed_foreign: 0,
    raw_ambiguous: currentAmbiguous.length,
    new_ambiguous: 0,
    material_unresolved: 0,
    active_operational_surfaces_unclassified: 0,
    worker_failures: 0,
    worker_timeouts: 0,
  }
}

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
  const analysisPath = path.resolve(process.argv[2] ?? '')
  assert(process.argv[2], 'usage: verify-authoritative-write-analysis.mjs <fresh-analysis.json> [triage.json]')
  const triagePath = path.resolve(process.argv[3] ?? path.join(
    root,
    'architecture/recovery/whole-project-dod/v2/AMBIGUOUS_WRITE_TRIAGE_FINAL_CLOSURE.json',
  ))
  const acceptedPath = path.resolve(process.argv[4] ?? path.join(
    root,
    'architecture/recovery/whole-project-dod/v2/CURRENT_WHOLE_REPOSITORY_WRITE_BASELINE.json',
  ))
  const [analysis, triage, acceptedAnalysis] = await Promise.all([
    readFile(analysisPath, 'utf8').then(JSON.parse),
    readFile(triagePath, 'utf8').then(JSON.parse),
    readFile(acceptedPath, 'utf8').then(JSON.parse),
  ])
  process.stdout.write(`${JSON.stringify(verifyAuthoritativeWriteAnalysis(analysis, triage, acceptedAnalysis), null, 2)}\n`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`)
    process.exitCode = 1
  })
}
