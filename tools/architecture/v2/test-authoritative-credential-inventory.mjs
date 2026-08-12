#!/usr/bin/env node

import assert from 'node:assert/strict'

import { verifyAuthoritativeCredentialInventory } from './verify-authoritative-credential-inventory.mjs'

const publicRisk = { candidate_classifications: [{ site_signature: 'accepted-public' }] }
const unknown = { records: [{ site_signature: 'accepted-unknown' }] }
const crossDomain = {
  exact_coverage: true,
  summary: { confirmed_unapproved_secret_reads: 0, material_capability_gap_remaining: 0 },
  records: [{ site_signature: 'accepted-foreign' }],
}
const fields = { records: Array.from({ length: 14 }, (_, index) => ({ id: index })) }
const inventory = {
  schema: 'yoko.crm.whole-repository-credential-database-access.v2',
  summary: {
    parse_findings: 0,
    tracked_executable_surfaces: 3,
    credential_database_accesses: 3,
    secret_reads: 1,
    metadata_only_reads: 1,
    ambiguous_credential_accesses: 1,
  },
  accesses: [
    { site_signature: 'accepted-public', public_secret_risk: true, file: 'a.ts', line: 1 },
    { site_signature: 'accepted-unknown', access: 'UNKNOWN', credential_exposure: 'AMBIGUOUS', file: 'b.ts', line: 2 },
    { site_signature: 'accepted-foreign', context_classification: 'FOREIGN_DIRECT_DB_ACCESS', credential_exposure: 'SECRET_READ', file: 'c.ts', line: 3 },
  ],
}

assert.equal(verifyAuthoritativeCredentialInventory(inventory, inventory, publicRisk, unknown, crossDomain, fields).status, 'PASS')
assert.throws(() => verifyAuthoritativeCredentialInventory({
  ...inventory,
  accesses: [...inventory.accesses, { site_signature: 'new-public', public_secret_risk: true }],
}, inventory, publicRisk, unknown, crossDomain, fields), /new possible public credential exposure/)
assert.throws(() => verifyAuthoritativeCredentialInventory({
  ...inventory,
  accesses: [...inventory.accesses, { site_signature: 'new-unknown', access: 'UNKNOWN' }],
}, inventory, publicRisk, unknown, crossDomain, fields), /new credential ambiguity/)
assert.throws(() => verifyAuthoritativeCredentialInventory({
  ...inventory,
  accesses: [...inventory.accesses, {
    site_signature: 'new-foreign', context_classification: 'FOREIGN_DIRECT_DB_ACCESS', credential_exposure: 'SECRET_READ',
  }],
}, inventory, publicRisk, unknown, crossDomain, fields), /new cross-domain secret read/)
assert.throws(() => verifyAuthoritativeCredentialInventory({
  ...inventory,
  summary: { ...inventory.summary, parse_findings: 1 },
}, inventory, publicRisk, unknown, crossDomain, fields), /credential analyzer parse finding/)

assert.throws(() => verifyAuthoritativeCredentialInventory({
  ...inventory,
  summary: { ...inventory.summary, tracked_executable_surfaces: 0, credential_database_accesses: 0 },
}, inventory, publicRisk, unknown, crossDomain, fields), /surface denominator shrank/)

process.stdout.write('authoritative credential inventory gate: PASS (5 negative properties)\n')
