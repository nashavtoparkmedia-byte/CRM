#!/usr/bin/env node

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { analyzeCredentialAccess } from './credential-analyzer.mjs'

const forbiddenApiKey = analyzeCredentialAccess(
  "'use server'; export async function read() { return prisma.aiAgentConfig.findUnique({ where: { id } }).apiKeyEncrypted }",
  { fileName: 'gravity-mvp/src/app/contacts/actions.ts' },
)
assert.equal(forbiddenApiKey.accesses.length, 1)
assert.equal(forbiddenApiKey.accesses[0].credential_exposure, 'SECRET_READ')
assert.equal(forbiddenApiKey.accesses[0].public_secret_risk, true)

const forbiddenSession = analyzeCredentialAccess(
  "export async function route() { return prisma.whatsAppConnection.findMany() }",
  { fileName: 'gravity-mvp/src/app/api/public/route.ts' },
)
assert.equal(forbiddenSession.accesses[0].exposed_sensitive_field_names.includes('sessionData'), true)
assert.equal(forbiddenSession.accesses[0].public_secret_risk, true)

const safeMetadata = analyzeCredentialAccess(
  "export async function route() { return prisma.whatsAppConnection.findMany({ select: { id: true, name: true, status: true } }) }",
  { fileName: 'gravity-mvp/src/app/api/public/route.ts' },
)
assert.equal(safeMetadata.accesses[0].credential_exposure, 'METADATA_ONLY')
assert.equal(safeMetadata.accesses[0].public_secret_risk, false)

for (const [fileName, entity] of [
  ['gravity-mvp/src/app/api/debug-db/tg-import/route.ts', 'TelegramConnection'],
  ['gravity-mvp/src/app/api/debug-db/wa-diag/route.ts', 'WhatsAppConnection'],
]) {
  const routeAnalysis = analyzeCredentialAccess(readFileSync(fileName, 'utf8'), { fileName })
  const connectionReads = routeAnalysis.accesses.filter((entry) => entry.entity === entity)
  assert.equal(connectionReads.length, 1, `${fileName} must retain one exact connection metadata read`)
  assert.equal(connectionReads[0].credential_exposure, 'METADATA_ONLY')
  assert.deepEqual(connectionReads[0].exposed_sensitive_field_names, [])
  assert.equal(connectionReads[0].public_secret_risk, false)
}

const providerUse = analyzeCredentialAccess(
  'export async function send() { const row = await prisma.whatsAppConnection.findUnique({ where: { id } }); return provider.send(row.sessionData) }',
  { fileName: 'gravity-mvp/src/modules/whatsapp_channel/provider-adapter.ts' },
)
assert.equal(providerUse.accesses[0].credential_exposure, 'SECRET_READ')
assert.equal(providerUse.accesses[0].public_secret_risk, false)

// A newly introduced sensitive-looking field must not become invisible merely
// because it is read from an otherwise approved provider module.
const futureField = analyzeCredentialAccess(
  'export async function send() { return prisma.apiConnection.findUnique({ select: { id: true, refreshToken: true } }) }',
  { fileName: 'gravity-mvp/src/modules/fleet_operations/provider-adapter.ts' },
)
assert.equal(futureField.accesses[0].credential_exposure, 'SECRET_READ')
assert.deepEqual(futureField.accesses[0].exposed_sensitive_field_names, ['refreshToken'])

console.log('credential-boundary-negative-probes: PASS (7 probes)')
