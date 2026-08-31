#!/usr/bin/env node

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  authorizeMigrationOnlySite,
  validateCapabilityRegistry,
  validateMigrationWriteAuthorizationRegistry,
} from './maintenance-capability-policy.mjs'
import { materializeReviewedMigrationSurfaceReachability } from './materialize-reviewed-migration-surface-reachability.mjs'

const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const sha256Lines = values => digest(`${[...values].sort().join('\n')}\n`)

async function main() {
  assert(process.argv[2], 'usage: test-migration-write-site-authorizations.mjs <fresh-analysis.json>')
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
  const paths = {
    analysis: path.resolve(process.argv[2]),
    registry: path.join(root, 'architecture/recovery/whole-project-dod/v2/MIGRATION_WRITE_SITE_AUTHORIZATION_REVIEW_20260813.json'),
    authority: path.join(root, 'architecture/migrations/v1/production-migration-authority.json'),
    pending: path.join(root, 'architecture/recovery/whole-project-dod/v2/MAINTENANCE_MIGRATION_CAPABILITY_REGISTRY.json'),
    reviewed: path.join(root, 'architecture/recovery/whole-project-dod/v2/ACTIVE_MAINTENANCE_CAPABILITY_REVIEW_20260813.json'),
    decisions: path.join(root, 'architecture/recovery/whole-project-dod/v2/NONCANONICAL_MIGRATION_CAPABILITY_DECISIONS_20260813.json'),
    lifecycle: path.join(root, 'architecture/recovery/whole-project-dod/v2/LIFECYCLE_SURFACE_CLASSIFICATION_REGISTRY.json'),
  }
  const [analysis, registry, authorityBytes, pending, reviewed, noncanonicalDecisionBytes] = await Promise.all([
    readFile(paths.analysis, 'utf8').then(JSON.parse),
    readFile(paths.registry, 'utf8').then(JSON.parse),
    readFile(paths.authority),
    readFile(paths.pending, 'utf8').then(JSON.parse),
    readFile(paths.reviewed, 'utf8').then(JSON.parse),
    readFile(paths.decisions),
  ])
  const productionMigrationAuthority = JSON.parse(authorityBytes.toString('utf8'))
  const noncanonicalMigrationDecisions = JSON.parse(noncanonicalDecisionBytes.toString('utf8'))
  const maintenanceCapabilityRegistry = { capabilities: [...(pending.capabilities ?? []), ...(reviewed.capabilities ?? [])] }
  assert.deepEqual(validateCapabilityRegistry(maintenanceCapabilityRegistry), [])
  assert.deepEqual(validateMigrationWriteAuthorizationRegistry(registry, {
    productionMigrationAuthority,
    productionMigrationAuthoritySha256: digest(authorityBytes),
    maintenanceCapabilityRegistry,
    noncanonicalMigrationDecisions,
    noncanonicalMigrationDecisionsSha256: digest(noncanonicalDecisionBytes),
  }), [])

  const sites = (analysis.write_sites ?? []).filter(site => site.classification === 'MIGRATION_ONLY')
  const signatures = sites.map(site => site.site_signature).sort()
  assert.equal(new Set(signatures).size, signatures.length, 'current MIGRATION_ONLY denominator contains duplicate signatures')
  assert.equal(registry.denominator.non_test_migration_only_sites, sites.length, 'migration authorization denominator is stale')
  assert.equal(registry.denominator.sorted_site_signatures_sha256, sha256Lines(signatures), 'migration authorization signature digest is stale')
  assert.deepEqual((registry.authorizations ?? []).map(row => row.site_signature).sort(), signatures, 'migration authorization review is not one-to-one')
  const sourcePaths = [...new Set(sites.map(site => site.file))]
  const sourceHashes = new Map(await Promise.all(sourcePaths.map(async relative => [relative, digest(await readFile(path.join(root, relative)))])))
  for (const site of sites) {
    assert.equal(authorizeMigrationOnlySite(registry, site, sourceHashes.get(site.file)), true, `exact migration authorization failed: ${site.file}:${site.line}`)
  }

  const plainSql = sites.find(site => site.method === 'sql-script' && site.file === 'gravity-mvp/add_partial_index.sql')
    ?? sites.find(site => site.method === 'sql-script')
  assert(plainSql, 'fresh analysis lacks a plain SQL migration fixture')
  const row = registry.authorizations.find(candidate => candidate.site_signature === plainSql.site_signature)
  assert(row, 'plain SQL migration lacks an exact capability')
  const sourceHash = sourceHashes.get(plainSql.file)
  assert.equal(authorizeMigrationOnlySite({ ...registry, authorizations: registry.authorizations.filter(candidate => candidate !== row) }, plainSql, sourceHash), false, 'plain SQL migration without capability must fail')
  assert.equal(authorizeMigrationOnlySite(registry, { ...plainSql, site_signature: `${plainSql.site_signature}-new` }, sourceHash), false, 'new site must fail')
  assert.equal(authorizeMigrationOnlySite(registry, { ...plainSql, file: `${plainSql.file}.moved` }, sourceHash), false, 'wrong source must fail')
  assert.equal(authorizeMigrationOnlySite(registry, plainSql, '0'.repeat(64)), false, 'wrong source hash must fail')
  assert.equal(authorizeMigrationOnlySite(registry, { ...plainSql, operations: plainSql.operations.map(operation => ({ ...operation, table: 'WrongModel' })) }, sourceHash), false, 'wrong model must fail')
  assert.equal(authorizeMigrationOnlySite(registry, { ...plainSql, operations: plainSql.operations.map(operation => ({ ...operation, operation: 'DROP_TABLE' })) }, sourceHash), false, 'wrong operation must fail')
  assert.ok(validateMigrationWriteAuthorizationRegistry({ ...registry, authorizations: [...registry.authorizations, row] }, {
    productionMigrationAuthority,
    productionMigrationAuthoritySha256: digest(authorityBytes),
    maintenanceCapabilityRegistry,
    noncanonicalMigrationDecisions,
    noncanonicalMigrationDecisionsSha256: digest(noncanonicalDecisionBytes),
  }).length, 'duplicate site must fail')
  assert.ok(validateMigrationWriteAuthorizationRegistry({ ...registry, authorizations: registry.authorizations.map(candidate => candidate === row
    ? { ...candidate, status: 'PENDING_EVIDENCE', approved: false }
    : candidate) }, {
    productionMigrationAuthority,
    productionMigrationAuthoritySha256: digest(authorityBytes),
    maintenanceCapabilityRegistry,
    noncanonicalMigrationDecisions,
    noncanonicalMigrationDecisionsSha256: digest(noncanonicalDecisionBytes),
  }).length, 'pending site must fail')
  assert.ok(validateMigrationWriteAuthorizationRegistry({ ...registry, authorizations: registry.authorizations.map(candidate => candidate === row
    ? { ...candidate, invocation: { production_reachability: 'UNKNOWN' } }
    : candidate) }, {
    productionMigrationAuthority,
    productionMigrationAuthoritySha256: digest(authorityBytes),
    maintenanceCapabilityRegistry,
    noncanonicalMigrationDecisions,
    noncanonicalMigrationDecisionsSha256: digest(noncanonicalDecisionBytes),
  }).length, 'unknown reachability must fail')

  const reachabilityTemporary = await mkdtemp(path.join(os.tmpdir(), 'yoko-reviewed-migration-reachability-'))
  try {
    const outputPath = path.join(reachabilityTemporary, 'lifecycle.json')
    const result = await materializeReviewedMigrationSurfaceReachability({
      registry: paths.lifecycle,
      authority: paths.authority,
      decisions: paths.decisions,
      output: outputPath,
    })
    assert.equal(result.canonical_reviewed_paths, 62)
    assert.equal(result.noncanonical_reviewed_paths, 18)
    const materializedLifecycle = JSON.parse(await readFile(outputPath, 'utf8'))
    const lifecycleByPath = new Map(materializedLifecycle.surfaces.map((surface) => [surface.path, surface]))
    for (const migration of productionMigrationAuthority.migrations) {
      const surface = lifecycleByPath.get(migration.provenance.repository_capture)
      assert.equal(surface.production_capability, 'CONTROLLED_MIGRATION')
      assert.equal(surface.source_sha256, migration.sha256)
    }
    for (const decision of noncanonicalMigrationDecisions.path_decisions) {
      assert.equal(lifecycleByPath.get(decision.path).production_capability, decision.production_reachability)
    }
    const invalidDecisionsPath = path.join(reachabilityTemporary, 'invalid-decisions.json')
    await writeFile(invalidDecisionsPath, JSON.stringify({
      ...noncanonicalMigrationDecisions,
      path_decisions: noncanonicalMigrationDecisions.path_decisions.map((decision, index) => index === 0
        ? { ...decision, production_reachability: 'UNKNOWN' }
        : decision),
    }))
    await assert.rejects(materializeReviewedMigrationSurfaceReachability({
      registry: paths.lifecycle,
      authority: paths.authority,
      decisions: invalidDecisionsPath,
      output: outputPath,
    }), /lacks exact approved reachability/)
  } finally {
    await rm(reachabilityTemporary, { recursive: true, force: true })
  }

  const temporary = await mkdtemp(path.join(os.tmpdir(), 'yoko-new-noncanonical-site-'))
  try {
    const changedAnalysisPath = path.join(temporary, 'analysis.json')
    const outputPath = path.join(temporary, 'review.json')
    const changedAnalysis = {
      ...analysis,
      write_sites: [...analysis.write_sites, { ...plainSql, site_signature: 'f'.repeat(64), line: plainSql.line + 1 }],
    }
    await writeFile(changedAnalysisPath, `${JSON.stringify(changedAnalysis)}\n`)
    const materialize = spawnSync(process.execPath, [
      'tools/architecture/v2/materialize-migration-write-site-authorizations.mjs',
      '--analysis', changedAnalysisPath,
      '--output', outputPath,
      '--materialize-reviewed-current-denominator',
    ], { cwd: root, encoding: 'utf8' })
    assert.notEqual(materialize.status, 0, 'new noncanonical site must not be auto-approved')
    assert.match(`${materialize.stdout}\n${materialize.stderr}`, /noncanonical review site denominator drift|exact site decision denominator drift/u)
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }

  process.stdout.write(`migration write-site exact authorization: PASS (${sites.length}/${sites.length}; 11 negative properties; 80 exact reviewed reachability paths)\n`)
}

main().catch(error => {
  process.stderr.write(`${error.stack ?? error.message}\n`)
  process.exitCode = 1
})
