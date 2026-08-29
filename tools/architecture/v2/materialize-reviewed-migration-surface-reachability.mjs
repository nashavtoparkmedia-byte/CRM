#!/usr/bin/env node

import assert from 'node:assert/strict'
import { readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { APPROVED_PRODUCTION_REACHABILITY } from './maintenance-capability-policy.mjs'

const MATERIALIZE_ACK = '--materialize-reviewed-migration-reachability'
const AUTHORITY_ARTIFACT = 'architecture/migrations/v1/production-migration-authority.json'
const DECISION_ARTIFACT = 'architecture/recovery/whole-project-dod/v2/NONCANONICAL_MIGRATION_CAPABILITY_DECISIONS_20260813.json'

function parseArgs(args) {
  const options = {}
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === MATERIALIZE_ACK) options.acknowledged = true
    else if (argument === '--registry') options.registry = path.resolve(args[++index] ?? '')
    else if (argument === '--authority') options.authority = path.resolve(args[++index] ?? '')
    else if (argument === '--decisions') options.decisions = path.resolve(args[++index] ?? '')
    else if (argument === '--output') options.output = path.resolve(args[++index] ?? '')
    else throw new Error(`unknown argument: ${argument}`)
  }
  assert(options.acknowledged, `refusing to write without ${MATERIALIZE_ACK}`)
  for (const key of ['registry', 'authority', 'decisions', 'output']) assert(options[key], `missing required --${key}`)
  return options
}

function reviewedCanonicalSurface(migration) {
  assert.equal(typeof migration.provenance?.repository_capture, 'string', `canonical migration ${migration.name} lacks a repository capture`)
  assert(/^[a-f0-9]{64}$/u.test(migration.sha256 ?? ''), `canonical migration ${migration.name} lacks an exact artifact hash`)
  return {
    path: migration.provenance.repository_capture,
    lifecycle: 'MIGRATION',
    disposition: 'MIGRATION_ONLY',
    production_capability: 'CONTROLLED_MIGRATION',
    rationale: `Canonical production migration ${migration.name} is byte-bound in the independently verified production migration authority; this classification grants only controlled migration reachability.`,
    classification_artifact: AUTHORITY_ARTIFACT,
    functional_owner: 'production_migration_authority',
    source_sha256: migration.sha256,
  }
}

function reviewedNoncanonicalSurface(decision, siteDecisions, siteOwnerOverrides) {
  assert.equal(typeof decision.path, 'string', 'noncanonical migration decision lacks an exact path')
  assert(APPROVED_PRODUCTION_REACHABILITY.has(decision.production_reachability), `noncanonical migration decision lacks exact approved reachability: ${decision.path}`)
  assert.equal(typeof decision.functional_owner, 'string', `noncanonical migration decision lacks a functional owner: ${decision.path}`)
  assert.equal(typeof decision.rationale, 'string', `noncanonical migration decision lacks a rationale: ${decision.path}`)
  const expectedSignatures = [...new Set(decision.expected_site_signatures ?? [])].sort()
  const reviewedSites = siteDecisions.filter((site) => site.path === decision.path)
  assert(expectedSignatures.length > 0, `noncanonical migration decision lacks exact site signatures: ${decision.path}`)
  assert.deepEqual(reviewedSites.map((site) => site.site_signature).sort(), expectedSignatures, `noncanonical path/site denominator drift: ${decision.path}`)
  assert(reviewedSites.every((site) => site.production_reachability === decision.production_reachability), `noncanonical site reachability contradicts path decision: ${decision.path}`)
  assert(reviewedSites.every((site) => (
    site.functional_owner === (siteOwnerOverrides[site.site_signature] ?? decision.functional_owner)
  )), `noncanonical site owner contradicts path decision/override: ${decision.path}`)
  const sourceHashes = [...new Set(reviewedSites.map((site) => site.source_sha256))]
  assert.equal(sourceHashes.length, 1, `noncanonical migration decision lacks one exact source hash: ${decision.path}`)
  assert(/^[a-f0-9]{64}$/u.test(sourceHashes[0] ?? ''), `noncanonical migration decision has an invalid source hash: ${decision.path}`)
  return {
    path: decision.path,
    lifecycle: 'MIGRATION',
    disposition: 'MIGRATION_ONLY',
    production_capability: decision.production_reachability,
    rationale: decision.rationale,
    classification_artifact: DECISION_ARTIFACT,
    functional_owner: decision.functional_owner,
    source_sha256: sourceHashes[0],
  }
}

function summaryFor(surfaces, existingSummary) {
  return {
    ...existingSummary,
    total_entries: surfaces.length,
    test: surfaces.filter((surface) => surface.lifecycle === 'TEST').length,
    dead_historical: surfaces.filter((surface) => surface.lifecycle === 'DEAD_HISTORICAL').length,
    migration_only: surfaces.filter((surface) => surface.disposition === 'MIGRATION_ONLY').length,
    active_operational: surfaces.filter((surface) => surface.lifecycle === 'OPERATIONAL_SCRIPT' && surface.disposition === 'ACTIVE').length,
  }
}

export async function materializeReviewedMigrationSurfaceReachability(options) {
  const [registry, authority, decisions] = await Promise.all([
    readFile(options.registry, 'utf8').then(JSON.parse),
    readFile(options.authority, 'utf8').then(JSON.parse),
    readFile(options.decisions, 'utf8').then(JSON.parse),
  ])
  assert.equal(decisions.schema, 'yoko.crm.reviewed-noncanonical-migration-capability-decisions.v1', 'noncanonical migration decision schema drift')
  assert.equal(decisions.review?.status, 'COMPLETED_SOURCE_SPECIFIC_REVIEW', 'noncanonical migration decisions lack completed source review')
  const canonical = (authority.migrations ?? []).map(reviewedCanonicalSurface)
  const noncanonical = (decisions.path_decisions ?? []).map((decision) => reviewedNoncanonicalSurface(
    decision,
    decisions.site_decisions ?? [],
    decisions.site_owner_overrides ?? {},
  ))
  const reviewed = [...canonical, ...noncanonical]
  assert.equal(new Set(reviewed.map((surface) => surface.path)).size, reviewed.length, 'canonical/noncanonical migration authority paths overlap or duplicate')
  const existing = registry.surfaces ?? []
  assert.equal(new Set(existing.map((surface) => surface.path)).size, existing.length, 'lifecycle registry contains duplicate exact paths')
  const reviewedByPath = new Map(reviewed.map((surface) => [surface.path, surface]))
  const surfaces = existing
    .filter((surface) => !reviewedByPath.has(surface.path))
    .concat(reviewed)
    .sort((left, right) => left.path.localeCompare(right.path))
  const output = { ...registry, summary: summaryFor(surfaces, registry.summary), surfaces }
  const temporary = `${options.output}.tmp`
  await writeFile(temporary, `${JSON.stringify(output, null, 2)}\n`)
  await rename(temporary, options.output)
  return {
    canonical_reviewed_paths: canonical.length,
    noncanonical_reviewed_paths: noncanonical.length,
    exact_migration_only_paths: reviewed.length,
    registry_entries: surfaces.length,
  }
}

async function main() {
  const result = await materializeReviewedMigrationSurfaceReachability(parseArgs(process.argv.slice(2)))
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`)
    process.exitCode = 1
  })
}
