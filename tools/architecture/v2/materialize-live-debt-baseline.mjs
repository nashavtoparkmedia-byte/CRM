#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const relative = {
  detector: 'architecture/recovery/whole-project-dod/v2/LIVE_ARCHITECTURE_DEBT_RECOMPUTE_20260811.json',
  registry: 'architecture/enforcement/v1/exceptions.json',
  output: 'architecture/recovery/whole-project-dod/v2/LIVE_ARCHITECTURE_DEBT_BASELINE_20260811.json',
}

const bytes = async (file) => readFile(path.join(root, file))
const json = async (file) => JSON.parse(await bytes(file))
const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const detectorBytes = await bytes(relative.detector)
const registryBytes = await bytes(relative.registry)
const detector = JSON.parse(detectorBytes)
const registry = JSON.parse(registryBytes)

const ruleCategory = (rule) => ({
  internal_module_import: 'INTERNAL_MODULE_IMPORT',
  non_public_cross_context_import: 'NON_PUBLIC_CROSS_CONTEXT_IMPORT',
  undeclared_dependency: 'UNDECLARED_DEPENDENCY',
  direct_provider_transport_access: 'PROVIDER_TRANSPORT_ACCESS',
  credential_access: 'CREDENTIAL_ACCESS',
  direct_foreign_prisma_write: 'FOREIGN_WRITE',
  contract_violation: 'CONTRACT_VIOLATION',
  manifest_violation: 'MANIFEST_VIOLATION',
}[rule] ?? 'OTHER_ARCHITECTURE_RULE')

const semanticPurpose = (record) => {
  const value = `${record.subject ?? ''} ${record.file ?? ''}`.toLowerCase()
  if (record.rule === 'direct_provider_transport_access') return 'TECHNICAL_INFRA'
  if (value.includes('/contracts/') || value.includes('contract:')) return 'COMMAND_OR_QUERY_CONTRACT'
  if (value.includes('/components/') || value.endsWith('.tsx')) return 'UI_SURFACE'
  if (value.includes('adapter') || value.includes('repository')) return 'APPLICATION_SERVICE'
  if (value.includes('event') || value.includes('stream')) return 'DOMAIN_EVENT'
  if (value.includes('query') || value.includes('read-model')) return 'QUERY_OR_READ_MODEL'
  return 'UNCLASSIFIED_SEMANTIC_INTENT'
}

const importedCapability = (record) => {
  if (Array.isArray(record.migration_references) && record.migration_references.length > 0) {
    return [...record.migration_references].sort().join(' | ')
  }
  const subject = record.subject ?? ''
  const separator = subject.indexOf(':')
  return separator === -1 ? subject : subject.slice(separator + 1)
}

const broadOrInvalid = (record) =>
  !/^arch_[a-f0-9]{24}$/.test(record.fingerprint ?? '') ||
  typeof record.file !== 'string' || record.file.length === 0 || /[*?]/.test(record.file) ||
  typeof record.subject !== 'string' || record.subject.length === 0 ||
  typeof record.owner_context !== 'string' || record.owner_context.length === 0

const staleFingerprints = new Set(detector.errors
  .filter((entry) => entry.type === 'STALE_EXCEPTION')
  .map((entry) => entry.fingerprint))

const classifyException = (record) => {
  if (staleFingerprints.has(record.fingerprint)) return 'STALE'
  if (broadOrInvalid(record)) return 'INVALID_BROAD'
  if (/permanent|intentional/u.test(`${record.rationale} ${record.retirement}`.toLowerCase()) && !record.expires_on) {
    return 'PERMANENT_INTENTIONAL_CANDIDATE'
  }
  return 'TEMPORARY_LEGACY'
}

const exceptionRecords = registry.exceptions.map((entry) => ({
  fingerprint: entry.fingerprint,
  rule: entry.rule,
  rule_category: ruleCategory(entry.rule),
  file: entry.file,
  line: entry.line_at_baseline,
  source_context: entry.owner_context,
  target_context: entry.target_context ?? null,
  subject: entry.subject,
  imported_capability: importedCapability(entry),
  semantic_purpose: semanticPurpose(entry),
  coverage: 'EXCEPTION_COVERED_LIVE_DEBT',
  exception_classification: classifyException(entry),
  expires_on: entry.expires_on ?? null,
  rationale: entry.rationale,
  retirement: entry.retirement,
}))

const uncoveredRecords = detector.errors
  .filter((entry) => entry.type === 'UNCOVERED_VIOLATION')
  .map(({ finding }) => ({
    fingerprint: finding.fingerprint,
    rule: finding.rule,
    rule_category: ruleCategory(finding.rule),
    file: finding.file,
    line: finding.line,
    source_context: finding.source_context,
    target_context: finding.target_context ?? null,
    subject: finding.subject,
    imported_capability: importedCapability(finding),
    semantic_purpose: semanticPurpose(finding),
    coverage: 'UNCOVERED_VIOLATION',
    exception_classification: null,
  }))

const findings = [...exceptionRecords, ...uncoveredRecords]
  .sort((a, b) => a.fingerprint.localeCompare(b.fingerprint))
assert.equal(findings.length, detector.findings)
assert.equal(exceptionRecords.length, detector.exceptions)
assert.equal(new Set(findings.map((entry) => entry.fingerprint)).size, findings.length)

const countBy = (records, key) => Object.fromEntries([...records.reduce((map, entry) => {
  const value = entry[key]
  map.set(value, (map.get(value) ?? 0) + 1)
  return map
}, new Map())].sort(([a], [b]) => String(a).localeCompare(String(b))))

const categoryCounts = countBy(findings, 'rule_category')
for (const category of [
  'INTERNAL_MODULE_IMPORT', 'NON_PUBLIC_CROSS_CONTEXT_IMPORT', 'UNDECLARED_DEPENDENCY',
  'PROVIDER_TRANSPORT_ACCESS', 'CREDENTIAL_ACCESS', 'FOREIGN_WRITE', 'CONTRACT_VIOLATION',
  'MANIFEST_VIOLATION', 'OTHER_ARCHITECTURE_RULE',
]) categoryCounts[category] ??= 0

const clusterMap = new Map()
for (const finding of findings) {
  const key = [finding.source_context, finding.target_context ?? '<none>', finding.rule_category,
    finding.semantic_purpose, finding.imported_capability].join(' | ')
  const cluster = clusterMap.get(key) ?? {
    key,
    source_context: finding.source_context,
    target_context: finding.target_context,
    rule_category: finding.rule_category,
    semantic_purpose: finding.semantic_purpose,
    imported_capability: finding.imported_capability,
    findings: 0,
    exception_covered: 0,
    uncovered: 0,
    files: new Set(),
    fingerprints: [],
  }
  cluster.findings += 1
  cluster[finding.coverage === 'UNCOVERED_VIOLATION' ? 'uncovered' : 'exception_covered'] += 1
  cluster.files.add(finding.file)
  cluster.fingerprints.push(finding.fingerprint)
  clusterMap.set(key, cluster)
}
const clusters = [...clusterMap.values()].map((entry) => ({
  ...entry,
  files: [...entry.files].sort(),
  fingerprints: entry.fingerprints.sort(),
})).sort((a, b) => b.findings - a.findings || a.key.localeCompare(b.key))

const exceptionClassification = countBy(exceptionRecords, 'exception_classification')
for (const category of ['TEMPORARY_LEGACY', 'PERMANENT_INTENTIONAL_CANDIDATE', 'STALE', 'INVALID_BROAD',
  'ALREADY_REMEDIATED_PENDING_REGISTRY_REMOVAL']) exceptionClassification[category] ??= 0

const output = {
  schema: 'yoko.crm.live-architecture-debt-baseline.v1',
  baseline_role: 'OPENING_DENOMINATOR_BEFORE_LIVE_DEBT_BURN_DOWN',
  source_identity: {
    checkpoint_head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    checkpoint_tree: execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: root, encoding: 'utf8' }).trim(),
    detector: { path: relative.detector, sha256: sha256(detectorBytes) },
    exception_registry: { path: relative.registry, sha256: sha256(registryBytes) },
  },
  denominator: {
    total_live_findings: findings.length,
    exception_covered_live_debt: exceptionRecords.length,
    uncovered: uncoveredRecords.length,
    actually_closed_in_this_baseline: 0,
    categories: categoryCounts,
  },
  exception_disposition: exceptionClassification,
  invariants: {
    every_finding_mapped_once: true,
    every_exception_mapped_once: true,
    duplicate_fingerprints: 0,
    detector_parse_errors: detector.errors.filter((entry) => entry.type === 'PARSE_ERROR').length,
    detector_digest_mismatches: detector.errors.filter((entry) => entry.type === 'FINDING_DIGEST_MISMATCH').length,
  },
  top_clusters: clusters.slice(0, 100),
  clusters,
  findings,
}

await writeFile(path.join(root, relative.output), `${JSON.stringify(output, null, 2)}\n`)
process.stdout.write(`${JSON.stringify({
  output: relative.output,
  findings: findings.length,
  exceptions: exceptionRecords.length,
  uncovered: uncoveredRecords.length,
  categories: categoryCounts,
  exception_disposition: exceptionClassification,
  clusters: clusters.length,
})}\n`)
