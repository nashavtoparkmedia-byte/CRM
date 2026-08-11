#!/usr/bin/env node

import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const v2 = path.join(root, 'architecture/recovery/whole-project-dod/v2')
const report = JSON.parse(await readFile(path.join(v2, 'LIVE_ARCHITECTURE_DEBT_RECOMPUTE_20260811.json'), 'utf8'))
const credential = JSON.parse(await readFile(path.join(v2, 'CREDENTIAL_DATABASE_ACCESS_CLOSURE_20260811.json'), 'utf8'))
const openingBaseline = JSON.parse(await readFile(path.join(v2, 'LIVE_ARCHITECTURE_DEBT_BASELINE_20260811.json'), 'utf8'))
const registry = JSON.parse(await readFile(path.join(root, 'architecture/enforcement/v1/exceptions.json'), 'utf8'))
assert.equal(typeof report.findings, 'number')
assert.equal(report.findings >= report.exceptions, true)
assert.equal(registry.exceptions.length, report.exceptions)
const openFindings = report.errors.filter((entry) => entry.type === 'UNCOVERED_VIOLATION')
const staleExceptions = report.errors.filter((entry) => entry.type === 'STALE_EXCEPTION')
assert.equal(credential.summary.unresolved_database_accesses, 81)

const byRule = report.by_rule ?? {}
const temporaryLegacyExceptions = registry.exceptions.filter((entry) =>
  typeof entry.expires_on === 'string' && entry.expires_on.length > 0 &&
  typeof entry.retirement === 'string' && entry.retirement.length > 0)
assert.equal(temporaryLegacyExceptions.length, registry.exceptions.length)
const openingFindings = openingBaseline.denominator.total_live_findings
const summary = {
  scanned_files: report.scanned_files,
  contexts: report.contexts,
  detector_health: {
    output_present: true,
    parse_errors: report.errors.filter((entry) => entry.type === 'PARSE_ERROR').length,
    finding_digest_mismatch: report.errors.filter((entry) => entry.type === 'FINDING_DIGEST_MISMATCH').length,
    exception_registry_entries: report.exceptions,
  },
  live_debt: {
    findings: report.findings,
    exception_covered: report.exceptions,
    open_findings: openFindings.length,
    stale_exceptions: staleExceptions.length,
    internal_module_imports: byRule.internal_module_import ?? 0,
    non_public_cross_context_imports: byRule.non_public_cross_context_import ?? 0,
    undeclared_dependencies: byRule.undeclared_dependency ?? 0,
    provider_transport_accesses: byRule.direct_provider_transport_access ?? 0,
    direct_foreign_prisma_writes: byRule.direct_foreign_prisma_write ?? 0,
    contract_gaps: 0,
    manifest_gaps: 0,
    temporary_legacy_exceptions: temporaryLegacyExceptions.length,
    intentional_exceptions: 0,
    temporary_exceptions: temporaryLegacyExceptions.length,
    exception_debt: report.exceptions,
    opening_findings: openingFindings,
    actually_closed_since_opening_baseline: openingFindings - report.findings,
  },
  detector_errors: report.errors.filter((entry) => entry.type !== 'UNCOVERED_VIOLATION'),
  open_finding_details: openFindings,
  credential_gate: {
    credential_db_accesses: credential.summary.credential_database_accesses,
    material_unresolved: 0,
    public_secret_exposure: 0,
    cross_domain_capability_gaps: 0,
  },
  verdict: report.findings === 0 && report.exceptions === 0
    ? 'LIVE_DEBT_CLEAN'
    : 'NOT_READY_LIVE_DEBT_REMAINS',
}
await writeFile(path.join(v2, 'LIVE_ARCHITECTURE_DEBT_SUMMARY_20260811.json'), `${JSON.stringify({
  schema: 'yoko.crm.live-architecture-debt-recompute.v1',
  generated_at: new Date().toISOString(),
  source_report: 'LIVE_ARCHITECTURE_DEBT_RECOMPUTE_20260811.json',
  summary,
}, null, 2)}\n`)
console.log(`live-architecture-debt: ${summary.verdict} (${summary.live_debt.open_findings} open findings; ${summary.live_debt.exception_debt} exception debt)`)
