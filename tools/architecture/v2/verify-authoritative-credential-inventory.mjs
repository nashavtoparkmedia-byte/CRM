#!/usr/bin/env node

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export function verifyAuthoritativeCredentialInventory(
  inventory,
  acceptedInventory,
  acceptedPublicRisk,
  acceptedUnknown,
  acceptedCrossDomain,
  sensitiveFields,
) {
  assert.equal(inventory.schema, 'yoko.crm.whole-repository-credential-database-access.v2')
  assert.equal(inventory.summary?.parse_findings, 0, 'credential analyzer parse finding')
  assert.equal(sensitiveFields.records?.length, 14, 'sensitive-field registry drift')
  assert(
    inventory.summary?.tracked_executable_surfaces >= acceptedInventory.summary?.tracked_executable_surfaces,
    'credential inventory surface denominator shrank without a reviewed checkpoint update',
  )
  assert(
    inventory.summary?.credential_database_accesses >= acceptedInventory.summary?.credential_database_accesses,
    'credential database-access denominator shrank without a reviewed checkpoint update',
  )

  const acceptedAccesses = acceptedInventory.accesses ?? []
  const publicRiskSignatures = new Set([
    ...(acceptedPublicRisk.candidate_classifications ?? []).map((record) => record.site_signature),
    ...acceptedAccesses.filter((record) => record.public_secret_risk).map((record) => record.site_signature),
  ])
  const unknownSignatures = new Set([
    ...(acceptedUnknown.records ?? []).map((record) => record.site_signature),
    ...acceptedAccesses.filter((record) => (
      record.access === 'UNKNOWN' || record.credential_exposure === 'AMBIGUOUS'
    )).map((record) => record.site_signature),
  ])
  const crossDomainSignatures = new Set([
    ...(acceptedCrossDomain.records ?? []).map((record) => record.site_signature),
    ...acceptedAccesses.filter((record) => (
      record.context_classification === 'FOREIGN_DIRECT_DB_ACCESS'
      && record.credential_exposure === 'SECRET_READ'
    )).map((record) => record.site_signature),
  ])
  assert.equal(acceptedCrossDomain.exact_coverage, true, 'accepted cross-domain review is incomplete')
  assert.equal(acceptedCrossDomain.summary?.confirmed_unapproved_secret_reads, 0)
  assert.equal(acceptedCrossDomain.summary?.material_capability_gap_remaining, 0)

  const accesses = inventory.accesses ?? []
  const newPublicRisk = accesses.filter((entry) => (
    entry.public_secret_risk && !publicRiskSignatures.has(entry.site_signature)
  ))
  const newUnknown = accesses.filter((entry) => (
    (entry.access === 'UNKNOWN' || entry.credential_exposure === 'AMBIGUOUS')
    && !unknownSignatures.has(entry.site_signature)
  ))
  const newForeignSecretRead = accesses.filter((entry) => (
    entry.context_classification === 'FOREIGN_DIRECT_DB_ACCESS'
    && entry.credential_exposure === 'SECRET_READ'
    && !crossDomainSignatures.has(entry.site_signature)
  ))

  const projection = (entry) => ({
    file: entry.file,
    line: entry.line,
    entity: entry.entity,
    site_signature: entry.site_signature,
  })
  assert.deepEqual(newPublicRisk.map(projection), [], 'new possible public credential exposure requires review')
  assert.deepEqual(newUnknown.map(projection), [], 'new credential ambiguity requires review')
  assert.deepEqual(newForeignSecretRead.map(projection), [], 'new cross-domain secret read requires an owner capability')

  return {
    status: 'PASS',
    credential_database_accesses: inventory.summary.credential_database_accesses,
    secret_reads: inventory.summary.secret_reads,
    metadata_only_reads: inventory.summary.metadata_only_reads,
    raw_ambiguous_accesses: inventory.summary.ambiguous_credential_accesses,
    new_ambiguous: 0,
    new_public_risk: 0,
    new_cross_domain_secret_reads: 0,
    material_unresolved: 0,
  }
}

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
  assert(process.argv[2], 'usage: verify-authoritative-credential-inventory.mjs <fresh-inventory.json>')
  const readJson = (relative) => readFile(path.join(root, relative), 'utf8').then(JSON.parse)
  const [inventory, acceptedInventory, publicRisk, unknown, crossDomain, sensitiveFields] = await Promise.all([
    readFile(path.resolve(process.argv[2]), 'utf8').then(JSON.parse),
    readJson('architecture/recovery/whole-project-dod/v2/CREDENTIAL_DATABASE_ACCESS_ARCHITECTURE_CHECKPOINT_20260811.json'),
    readJson('architecture/recovery/whole-project-dod/v2/PUBLIC_SECRET_RISK_CLOSURE_20260811.json'),
    readJson('architecture/recovery/whole-project-dod/v2/credential-unknown-access-resolution.json'),
    readJson('architecture/recovery/whole-project-dod/v2/CROSS_DOMAIN_CREDENTIAL_REVIEW_20260811.json'),
    readJson('architecture/recovery/whole-project-dod/v2/CREDENTIAL_SENSITIVE_FIELD_REGISTRY.json'),
  ])
  process.stdout.write(`${JSON.stringify(verifyAuthoritativeCredentialInventory(
    inventory,
    acceptedInventory,
    publicRisk,
    unknown,
    crossDomain,
    sensitiveFields,
  ), null, 2)}\n`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`)
    process.exitCode = 1
  })
}
