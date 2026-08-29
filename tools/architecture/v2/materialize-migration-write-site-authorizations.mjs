#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  analyzedMigrationWrites,
  APPROVED_PRODUCTION_REACHABILITY,
  validateCapabilityRegistry,
  validateMigrationWriteAuthorizationRegistry,
} from './maintenance-capability-policy.mjs'

const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const sha256Lines = values => digest(`${[...values].sort().join('\n')}\n`)

function option(name) {
  const index = process.argv.indexOf(name)
  return index < 0 ? null : process.argv[index + 1]
}

function exactExistingCapability(registry, site) {
  const matches = (registry.capabilities ?? []).filter(row => row.approved === true
    && row.status === 'APPROVED'
    && row.source?.path === site.file
    && row.source?.site_signatures?.includes(site.site_signature))
  assert(matches.length <= 1, `migration site is covered by duplicate existing capabilities: ${site.file}:${site.line}`)
  return matches[0] ?? null
}

function canonicalWrites(site) {
  const analyzed = analyzedMigrationWrites(site)
  assert(analyzed.length > 0, `migration site has no exact operation: ${site.file}:${site.line}`)
  assert(analyzed.every(write => write.kind && write.exact_name && write.operation), `canonical migration site lacks an exact authority write tuple: ${site.file}:${site.line}`)
  return analyzed
}

function assertWriteProjection(site, writes, label) {
  const analyzed = analyzedMigrationWrites(site)
  assert.equal(writes.length, analyzed.length, `${label} write cardinality drift: ${site.file}:${site.line}`)
  const available = [...writes]
  for (const write of analyzed) {
    const index = available.findIndex(candidate => candidate.operation === write.operation
      && (write.kind === null || candidate.kind === write.kind)
      && (write.exact_name === null || candidate.exact_name === write.exact_name))
    assert(index >= 0, `${label} write tuple drift: ${site.file}:${site.line}`)
    available.splice(index, 1)
  }
}

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
  const analysisPath = path.resolve(option('--analysis') ?? '')
  const outputPath = path.resolve(option('--output') ?? '')
  assert(process.argv.includes('--materialize-reviewed-current-denominator'), 'explicit --materialize-reviewed-current-denominator acknowledgement is required')
  assert(option('--analysis') && option('--output'), 'usage: materialize-migration-write-site-authorizations.mjs --analysis <fresh-analysis.json> --output <review.json> --materialize-reviewed-current-denominator')
  const authorityPath = path.join(root, 'architecture/migrations/v1/production-migration-authority.json')
  const pendingCapabilityPath = path.join(root, 'architecture/recovery/whole-project-dod/v2/MAINTENANCE_MIGRATION_CAPABILITY_REGISTRY.json')
  const reviewedCapabilityPath = path.join(root, 'architecture/recovery/whole-project-dod/v2/ACTIVE_MAINTENANCE_CAPABILITY_REVIEW_20260813.json')
  const decisionPath = path.join(root, 'architecture/recovery/whole-project-dod/v2/NONCANONICAL_MIGRATION_CAPABILITY_DECISIONS_20260813.json')
  const [analysis, authorityBytes, pendingCapabilities, reviewedCapabilities, noncanonicalDecisionBytes] = await Promise.all([
    readFile(analysisPath, 'utf8').then(JSON.parse),
    readFile(authorityPath),
    readFile(pendingCapabilityPath, 'utf8').then(JSON.parse),
    readFile(reviewedCapabilityPath, 'utf8').then(JSON.parse),
    readFile(decisionPath),
  ])
  assert.equal(analysis.schema, 'yoko.crm.whole-repository-write-analysis.v2')
  assert.equal(analysis.execution?.complete, true, 'only a complete fresh analysis may be materialized')
  const productionMigrationAuthority = JSON.parse(authorityBytes.toString('utf8'))
  const noncanonicalDecisions = JSON.parse(noncanonicalDecisionBytes.toString('utf8'))
  const maintenanceCapabilityRegistry = {
    capabilities: [...(pendingCapabilities.capabilities ?? []), ...(reviewedCapabilities.capabilities ?? [])],
  }
  assert.deepEqual(validateCapabilityRegistry(maintenanceCapabilityRegistry), [])
  const canonicalByPath = new Map(productionMigrationAuthority.migrations.map(row => [row.provenance.repository_capture, row]))
  assert.equal(noncanonicalDecisions.schema, 'yoko.crm.reviewed-noncanonical-migration-capability-decisions.v1')
  assert.equal(noncanonicalDecisions.version, 1)
  assert.equal(noncanonicalDecisions.review?.status, 'COMPLETED_SOURCE_SPECIFIC_REVIEW')
  const decisionsByPath = new Map()
  for (const decision of noncanonicalDecisions.path_decisions ?? []) {
    assert(!decisionsByPath.has(decision.path), `duplicate noncanonical path decision: ${decision.path}`)
    assert(typeof decision.functional_owner === 'string' && decision.functional_owner.length > 0, `noncanonical path decision lacks owner: ${decision.path}`)
    assert(APPROVED_PRODUCTION_REACHABILITY.has(decision.production_reachability), `noncanonical path decision lacks exact reachability: ${decision.path}`)
    assert(typeof decision.lifecycle_evidence_status === 'string' && decision.lifecycle_evidence_status.startsWith('REVIEWED_'), `noncanonical path decision lacks reviewed lifecycle evidence: ${decision.path}`)
    assert(typeof decision.rationale === 'string' && decision.rationale.length >= 48, `noncanonical path decision lacks justification: ${decision.path}`)
    assert(Array.isArray(decision.expected_site_signatures) && decision.expected_site_signatures.length > 0, `noncanonical path decision lacks exact sites: ${decision.path}`)
    assert.equal(new Set(decision.expected_site_signatures).size, decision.expected_site_signatures.length, `noncanonical path decision repeats a site: ${decision.path}`)
    decisionsByPath.set(decision.path, decision)
  }
  const siteDecisionsBySignature = new Map()
  for (const decision of noncanonicalDecisions.site_decisions ?? []) {
    assert(!siteDecisionsBySignature.has(decision.site_signature), `duplicate noncanonical site decision: ${decision.site_signature}`)
    assert(typeof decision.path === 'string' && decision.path.length > 0, `noncanonical site decision lacks source path: ${decision.site_signature}`)
    assert(/^[0-9a-f]{64}$/u.test(decision.source_sha256 ?? ''), `noncanonical site decision lacks source hash: ${decision.site_signature}`)
    assert(Number.isInteger(decision.line) && Number.isInteger(decision.column) && typeof decision.method === 'string', `noncanonical site decision lacks exact coordinate/method: ${decision.site_signature}`)
    assert(typeof decision.functional_owner === 'string' && decision.functional_owner.length > 0, `noncanonical site decision lacks owner: ${decision.site_signature}`)
    assert(APPROVED_PRODUCTION_REACHABILITY.has(decision.production_reachability), `noncanonical site decision lacks reachability: ${decision.site_signature}`)
    assert(Array.isArray(decision.writes) && decision.writes.length > 0, `noncanonical site decision lacks exact writes: ${decision.site_signature}`)
    assert(typeof decision.review_rationale === 'string' && decision.review_rationale.length >= 48, `noncanonical site decision lacks review rationale: ${decision.site_signature}`)
    siteDecisionsBySignature.set(decision.site_signature, decision)
  }
  const sites = (analysis.write_sites ?? [])
    .filter(site => site.classification === 'MIGRATION_ONLY')
    .sort((left, right) => left.site_signature.localeCompare(right.site_signature))
  assert.equal(new Set(sites.map(site => site.site_signature)).size, sites.length, 'fresh MIGRATION_ONLY denominator contains duplicate signatures')
  const sourcePaths = [...new Set(sites.map(site => site.file))]
  const sourceHashes = new Map(await Promise.all(sourcePaths.map(async relative => [relative, digest(await readFile(path.join(root, relative)))])))
  const noncanonicalSitesByPath = new Map()
  for (const site of sites.filter(site => !canonicalByPath.has(site.file))) {
    if (!noncanonicalSitesByPath.has(site.file)) noncanonicalSitesByPath.set(site.file, [])
    noncanonicalSitesByPath.get(site.file).push(site.site_signature)
  }
  assert.deepEqual([...decisionsByPath.keys()].sort(), [...noncanonicalSitesByPath.keys()].sort(), 'noncanonical review path denominator drift')
  assert.deepEqual([...siteDecisionsBySignature.keys()].sort(), [...noncanonicalSitesByPath.values()].flat().sort(), 'noncanonical exact site decision denominator drift')
  for (const [relative, signatures] of noncanonicalSitesByPath) {
    assert.deepEqual([...decisionsByPath.get(relative).expected_site_signatures].sort(), signatures.sort(), `noncanonical review site denominator drift: ${relative}`)
  }

  const authorizations = sites.map(site => {
    assert.equal(site.surface?.lifecycle, 'MIGRATION', `MIGRATION_ONLY site lifecycle drift: ${site.file}:${site.line}`)
    assert.equal(site.surface?.disposition, 'MIGRATION_ONLY', `MIGRATION_ONLY site disposition drift: ${site.file}:${site.line}`)
    assert(APPROVED_PRODUCTION_REACHABILITY.has(site.surface?.production_capability), `MIGRATION_ONLY site lacks exact reviewed production reachability: ${site.file}:${site.line}`)
    assert.equal(site.source_sha256, sourceHashes.get(site.file), `MIGRATION_ONLY analysis is stale for current source bytes: ${site.file}:${site.line}`)
    const canonicalMigration = canonicalByPath.get(site.file) ?? null
    const existingCapability = exactExistingCapability(maintenanceCapabilityRegistry, site)
    const explicitDecision = canonicalMigration ? null : decisionsByPath.get(site.file)
    const explicitSiteDecision = canonicalMigration ? null : siteDecisionsBySignature.get(site.site_signature)
    assert(canonicalMigration || explicitDecision, `new noncanonical migration site requires an explicit reviewed decision: ${site.file}:${site.line}`)
    assert(canonicalMigration || explicitSiteDecision, `new noncanonical migration site requires an explicit exact site decision: ${site.file}:${site.line}`)
    const writes = canonicalMigration ? canonicalWrites(site) : explicitSiteDecision.writes
    assertWriteProjection(site, writes, canonicalMigration ? 'canonical authority' : 'noncanonical reviewed decision')
    const dataOwner = canonicalMigration ? 'production_migration_authority' : explicitSiteDecision.functional_owner
    const productionReachability = site.surface.production_capability
    if (canonicalMigration) assert.equal(productionReachability, 'CONTROLLED_MIGRATION', `canonical migration reachability drift: ${site.file}:${site.line}`)
    if (explicitSiteDecision) {
      assert.equal(explicitSiteDecision.path, site.file, `noncanonical site decision source drift: ${site.file}:${site.line}`)
      assert.equal(explicitSiteDecision.line, site.line, `noncanonical site decision line drift: ${site.file}:${site.line}`)
      assert.equal(explicitSiteDecision.column, site.column, `noncanonical site decision column drift: ${site.file}:${site.line}`)
      assert.equal(explicitSiteDecision.method, site.method, `noncanonical site decision method drift: ${site.file}:${site.line}`)
      assert.equal(explicitSiteDecision.production_reachability, productionReachability, `analyzed/noncanonical site reachability contradiction: ${site.file}:${site.line}`)
      assert.equal(explicitDecision.production_reachability, productionReachability, `noncanonical path/site reachability contradiction: ${site.file}:${site.line}`)
      assert.equal(noncanonicalDecisions.site_owner_overrides?.[site.site_signature] ?? explicitDecision.functional_owner, dataOwner, `noncanonical path/site owner contradiction: ${site.file}:${site.line}`)
      assert.equal(explicitSiteDecision.existing_capability_id ?? null, existingCapability?.capability_id ?? null, `noncanonical existing capability decision drift: ${site.file}:${site.line}`)
    }
    if (existingCapability) {
      assert.equal(existingCapability.source.source_sha256, sourceHashes.get(site.file), `existing capability source-byte binding contradicts current source: ${site.file}:${site.line}`)
      assert.equal(existingCapability.target.data_owner, dataOwner, `existing capability owner contradicts explicit decision: ${site.file}:${site.line}`)
      assert.equal(existingCapability.invocation.production_reachability, productionReachability, `existing capability reachability contradicts explicit decision: ${site.file}:${site.line}`)
    }
    const sourceSha256 = sourceHashes.get(site.file)
    if (canonicalMigration) assert.equal(sourceSha256, canonicalMigration.sha256, `canonical migration source checksum drift: ${site.file}`)
    else assert.equal(sourceSha256, explicitSiteDecision.source_sha256, `noncanonical reviewed source checksum drift: ${site.file}`)
    const capabilityId = `mmc.migration-site.v1.${dataOwner}.${site.site_signature.slice(0, 16)}`
    const binding = canonicalMigration
      ? {
          kind: 'CANONICAL_PRODUCTION_MIGRATION',
          name: canonicalMigration.name,
          canonical_ordinal: canonicalMigration.canonical_ordinal,
          artifact_sha256: canonicalMigration.sha256,
          repository_capture: canonicalMigration.provenance.repository_capture,
        }
      : {
          kind: 'INDEPENDENT_EXACT_CAPABILITY',
          rationale: existingCapability
            ? 'The committed reviewed maintenance capability and exact source bytes jointly authorize only this site tuple.'
            : explicitSiteDecision.review_rationale,
          evidence: [
            `source_sha256:${sourceSha256}`,
            `site_signature:${site.site_signature}`,
            `source_coordinate:${site.file}:${site.line}:${site.column}`,
            `review_decision:${path.relative(root, decisionPath)}`,
            `lifecycle_evidence_status:${explicitDecision.lifecycle_evidence_status}`,
          ],
          ...(existingCapability ? { existing_capability_id: existingCapability.capability_id } : {}),
        }
    return {
      capability_id: capabilityId,
      site_signature: site.site_signature,
      status: 'APPROVED',
      approved: true,
      source: {
        path: site.file,
        source_sha256: sourceSha256,
        line: site.line,
        column: site.column,
        method: site.method,
      },
      lifecycle: 'MIGRATION',
      invocation: { production_reachability: productionReachability },
      functional_owner: dataOwner,
      target: { data_owner: dataOwner, writes },
      binding,
    }
  })
  const registry = {
    schema: 'yoko.crm.reviewed-migration-write-site-authorizations.v1',
    version: 1,
    review: {
      status: 'COMPLETED_EXACT_SITE_REVIEW',
      reviewed_by: 'YOKO_CRM_ARCHITECTURE_REMEDIATION',
      decision: 'Each current non-test MIGRATION_ONLY site is reviewed one-to-one; analysis output alone grants no capability.',
    },
    noncanonical_review: {
      path: path.relative(root, decisionPath),
      source_sha256: digest(noncanonicalDecisionBytes),
      reviewed_path_count: decisionsByPath.size,
      policy: 'Noncanonical sites are materialized only from exact committed source-specific decisions; absent sites fail materialization.',
    },
    authority: {
      path: 'architecture/migrations/v1/production-migration-authority.json',
      source_sha256: digest(authorityBytes),
      inventory_digest: productionMigrationAuthority.inventory_digest,
      migration_count: productionMigrationAuthority.migrations.length,
    },
    denominator: {
      non_test_migration_only_sites: sites.length,
      sorted_site_signatures_sha256: sha256Lines(sites.map(site => site.site_signature)),
    },
    authorizations,
  }
  assert.deepEqual(validateMigrationWriteAuthorizationRegistry(registry, {
    productionMigrationAuthority,
    productionMigrationAuthoritySha256: digest(authorityBytes),
    maintenanceCapabilityRegistry,
    noncanonicalMigrationDecisions: noncanonicalDecisions,
    noncanonicalMigrationDecisionsSha256: digest(noncanonicalDecisionBytes),
  }), [])
  await writeFile(outputPath, `${JSON.stringify(registry, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify({ status: 'PASS', output: outputPath, migration_only_sites: sites.length }, null, 2)}\n`)
}

main().catch(error => {
  process.stderr.write(`${error.stack ?? error.message}\n`)
  process.exitCode = 1
})
