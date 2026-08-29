#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  ambiguityReviewKey,
  credentialReviewScope,
  isGovernedImmutableCredentialEvidence,
  riskReviewKey,
  verifyCredentialInventorySourceIntegrity,
} from './verify-authoritative-credential-inventory.mjs'

const MATERIALIZE_ACK = '--materialize-existing-exact-reviews'

function sha256Lines(values) {
  return createHash('sha256').update(`${[...values].sort().join('\n')}\n`).digest('hex')
}

function parseArgs(args) {
  const options = {}
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === MATERIALIZE_ACK) options.acknowledged = true
    else if (argument === '--inventory') options.inventory = path.resolve(args[++index] ?? '')
    else if (argument === '--public-review') options.publicReview = path.resolve(args[++index] ?? '')
    else if (argument === '--ambiguity-review') options.ambiguityReview = path.resolve(args[++index] ?? '')
    else if (argument === '--lifecycle-registry') options.lifecycleRegistry = path.resolve(args[++index] ?? '')
    else if (argument === '--public-output') options.publicOutput = path.resolve(args[++index] ?? '')
    else if (argument === '--ambiguity-output') options.ambiguityOutput = path.resolve(args[++index] ?? '')
    else throw new Error(`unknown argument: ${argument}`)
  }
  assert(options.acknowledged, `refusing to write without ${MATERIALIZE_ACK}`)
  for (const key of ['inventory', 'publicReview', 'ambiguityReview', 'lifecycleRegistry', 'publicOutput', 'ambiguityOutput']) {
    assert(options[key], `missing required --${key.replace(/[A-Z]/gu, value => `-${value.toLowerCase()}`)}`)
  }
  assert.notEqual(options.publicOutput, options.ambiguityOutput, 'public and ambiguity outputs must be distinct')
  return options
}

function exactReviewedProjection(currentRows, reviewedRows, keyFor, label) {
  const currentKeys = currentRows.map(keyFor)
  const reviewedKeys = reviewedRows.map(keyFor)
  assert.equal(new Set(currentKeys).size, currentKeys.length, `${label} current denominator contains duplicate exact keys`)
  assert.equal(new Set(reviewedKeys).size, reviewedKeys.length, `${label} review contains duplicate exact keys`)
  assert.deepEqual([...reviewedKeys].sort(), [...currentKeys].sort(), `${label} review is stale; materialization cannot create or retarget decisions`)
  const currentByKey = new Map(currentRows.map((entry) => [keyFor(entry), entry]))
  return reviewedRows.map((record) => {
    const key = keyFor(record)
    const current = currentByKey.get(key)
    assert(current, `${label} review has no exact current analyzer row: ${key}`)
    assert(/^[a-f0-9]{64}$/u.test(record.source_sha256 ?? ''), `${label} review lacks exact source hash: ${key}`)
    assert.equal(record.source_sha256, current.source_sha256, `${label} source-byte binding drift: ${key}`)
    assert.equal(typeof record.classification, 'string', `${label} review lacks a classification: ${key}`)
    assert.equal(typeof record.resolved_semantics, 'string', `${label} review lacks resolved semantics: ${key}`)
    const currentScope = credentialReviewScope(current)
    if (record.review_scope !== undefined && record.review_scope !== null) {
      assert.deepEqual(record.review_scope, currentScope, `${label} semantic scope drift requires independent re-review: ${key}`)
    }
    if (Array.isArray(record.inventory_ambiguity_reasons)) {
      assert.deepEqual(
        [...new Set(record.inventory_ambiguity_reasons.map(String))].sort(),
        currentScope.ambiguity_reasons,
        `${label} recorded ambiguity reasons drift: ${key}`,
      )
    }
    return { ...record, review_scope: currentScope }
  })
}

async function atomicWrite(output, value) {
  const temporary = `${output}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`)
  await rename(temporary, output)
}

export async function materializeCredentialReviewScopes(options) {
  const [inventory, publicReview, ambiguityReview, lifecycleRegistry] = await Promise.all([
    readFile(options.inventory, 'utf8').then(JSON.parse),
    readFile(options.publicReview, 'utf8').then(JSON.parse),
    readFile(options.ambiguityReview, 'utf8').then(JSON.parse),
    readFile(options.lifecycleRegistry, 'utf8').then(JSON.parse),
  ])
  assert.equal(inventory.schema, 'yoko.crm.whole-repository-credential-database-access.v2', 'credential inventory schema drift')
  if (options.sourceIntegrityContext) verifyCredentialInventorySourceIntegrity(inventory, options.sourceIntegrityContext)
  const accesses = inventory.accesses ?? []
  const lifecycleByPath = new Map((lifecycleRegistry.surfaces ?? []).map((surface) => [surface.path, surface]))
  const governedHistoricalEvidence = accesses.filter((entry) => isGovernedImmutableCredentialEvidence(entry, lifecycleByPath))
  const governedPublic = governedHistoricalEvidence.filter((entry) => entry.public_secret_risk === true)
  const governedAmbiguous = governedHistoricalEvidence.filter((entry) => entry.access === 'UNKNOWN' || entry.credential_exposure === 'AMBIGUOUS')
  const currentPublic = accesses.filter((entry) => entry.public_secret_risk === true && !isGovernedImmutableCredentialEvidence(entry, lifecycleByPath))
  const currentAmbiguous = accesses.filter((entry) => (
    (entry.access === 'UNKNOWN' || entry.credential_exposure === 'AMBIGUOUS')
    && !isGovernedImmutableCredentialEvidence(entry, lifecycleByPath)
  ))
  const publicRecords = exactReviewedProjection(
    currentPublic,
    publicReview.current_candidate_classifications ?? [],
    riskReviewKey,
    'public credential-risk',
  )
  const ambiguityRecords = exactReviewedProjection(
    currentAmbiguous,
    ambiguityReview.records ?? [],
    ambiguityReviewKey,
    'credential ambiguity',
  )

  const publicKeys = currentPublic.map(riskReviewKey)
  const ambiguityKeys = currentAmbiguous.map(ambiguityReviewKey)
  const publicOutput = {
    ...publicReview,
    current_exact_review: {
      ...publicReview.current_exact_review,
      risk_denominator: currentPublic.length,
      raw_risk_denominator: currentPublic.length + governedPublic.length,
      governed_immutable_historical_evidence_count: governedPublic.length,
      review_key: 'file|line|column|method|access|entity|site_signature|source_sha256 plus exact semantic review_scope',
      sorted_review_keys_sha256: sha256Lines(publicKeys),
      disposition_policy: 'Every exact current risk key and semantic scope must map to an explicit independently reviewed classification; raw inventory rows confer no acceptance.',
    },
    source_byte_binding: 'Each current decision is bound to exact source bytes and the full analyzer semantic projection in review_scope; any drift requires independent re-review.',
    governed_immutable_historical_evidence: {
      count: governedPublic.length,
      identities: governedPublic.map((entry) => ({
        review_key: riskReviewKey(entry),
        site_signature: entry.site_signature,
        source_sha256: entry.source_sha256,
      })),
    },
    current_candidate_classifications: publicRecords,
  }
  const ambiguityOutput = {
    ...ambiguityReview,
    current_exact_review: {
      ...ambiguityReview.current_exact_review,
      ambiguous_denominator: currentAmbiguous.length,
      raw_ambiguous_denominator: currentAmbiguous.length + governedAmbiguous.length,
      governed_immutable_historical_evidence_count: governedAmbiguous.length,
      sorted_review_keys_sha256: sha256Lines(ambiguityKeys),
    },
    source_byte_binding: 'Each disposition is bound to exact source bytes and the full analyzer semantic projection in review_scope; any drift requires independent re-review.',
    scope_note: 'Exact reviewed semantics are not transferable between candidate entities, access intent, sensitive-field exposure, owner/context, lifecycle, or production reachability.',
    governed_immutable_historical_evidence: {
      count: governedAmbiguous.length,
      identities: governedAmbiguous.map((entry) => ({
        review_key: ambiguityReviewKey(entry),
        site_signature: entry.site_signature,
        source_sha256: entry.source_sha256,
      })),
    },
    records: ambiguityRecords,
  }
  await Promise.all([
    atomicWrite(options.publicOutput, publicOutput),
    atomicWrite(options.ambiguityOutput, ambiguityOutput),
  ])
  return {
    public_risk_scopes: publicRecords.length,
    ambiguity_scopes: ambiguityRecords.length,
    governed_historical_public_risks: governedPublic.length,
    governed_historical_ambiguities: governedAmbiguous.length,
    public_review_sha256: sha256Lines(publicKeys),
    ambiguity_review_sha256: sha256Lines(ambiguityKeys),
  }
}

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
  const result = await materializeCredentialReviewScopes({
    ...parseArgs(process.argv.slice(2)),
    sourceIntegrityContext: {
      readSource: (relative) => readFileSync(path.join(root, relative)),
    },
  })
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`)
    process.exitCode = 1
  })
}
