#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const authorityPath = 'architecture/migrations/v1/production-migration-authority.json'
export const PREDECESSOR_INVENTORY_PATH = 'architecture/migrations/v1/predecessor-runtime-migration-inventory.json'
export const PREDECESSOR_INVENTORY_DIGEST = 'f07ca981e8acb53b48aacee882bce19473e0f33dafd07f716780ec192dd84c01'
export const PREDECESSOR_RUNTIME_ARTIFACT_SHA256 = '88b20e7a6ce3dfca3df6488f42331a5957494af3825265bb27b63c785d212bb3'
export const RAW_PREDECESSOR_EVIDENCE_PATH = 'architecture/migrations/v1/provenance/raw/runtime-20260808T205042Z.json.gz.b64'
export const RAW_PREDECESSOR_EVIDENCE_SHA256 = '57c776c79c3212a649940824b278bf007856c77891979e4cd0e97fc9cb3129cf'
export const RAW_PREDECESSOR_EVIDENCE_SIZE = 244625
export const SEPARATE_TG_ROW = { name: '20260223211509_add_is_linear_to_survey', sha256: '1e6f4be04902cc74473bb37b512acb3d1c3ce1010ad696dea48e8969f762fc8e', size: 2688 }

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function digestRows(rows) {
  return createHash('sha256').update(`${JSON.stringify(rows)}\n`).digest('hex')
}

const digestBytes = (bytes) => createHash('sha256').update(bytes).digest('hex')

function normalizedRows(rows) {
  return rows.map(({ name, sha256, size }) => ({ name, sha256, size }))
    .sort((left, right) => left.name.localeCompare(right.name))
}

export function assertSanitizedPredecessorInventory(inventory) {
  assert(inventory?.schema === 'yoko.crm.predecessor-runtime-migration-inventory.v1' && inventory.version === 1, 'sanitized predecessor inventory identity mismatch')
  assert(inventory.provenance?.source_artifact === '/opt/codex-work/crm-arch-000-evidence/crm-arch-000r/20260808T204949Z-operator/raw/runtime.json', 'sanitized predecessor inventory source mismatch')
  assert(inventory.provenance?.source_artifact_sha256 === PREDECESSOR_RUNTIME_ARTIFACT_SHA256, 'sanitized predecessor source checksum mismatch')
  assert(inventory.provenance?.observed_at === '2026-08-08T20:50:42Z' && inventory.provenance?.source_operation === 'evidence.runtime-content-manifest', 'sanitized predecessor inventory provenance mismatch')
  const rows = normalizedRows(inventory.rows ?? [])
  assert(rows.length === 62, 'sanitized predecessor inventory row count mismatch')
  assert(new Set(rows.map((row) => row.name)).size === rows.length, 'sanitized predecessor inventory duplicate migration')
  assert(rows.every((row) => typeof row.name === 'string' && /^[0-9][A-Za-z0-9_]*$/.test(row.name) && /^[0-9a-f]{64}$/.test(row.sha256) && Number.isInteger(row.size) && row.size > 0), 'sanitized predecessor inventory invalid row')
  assert(JSON.stringify(rows) === JSON.stringify(inventory.rows), 'sanitized predecessor inventory ordering mismatch')
  assert(inventory.inventory_sha256 === PREDECESSOR_INVENTORY_DIGEST && digestRows(rows) === PREDECESSOR_INVENTORY_DIGEST, 'sanitized predecessor inventory digest mismatch')
  assert(JSON.stringify(rows.find((row) => row.name === SEPARATE_TG_ROW.name)) === JSON.stringify(SEPARATE_TG_ROW), 'sanitized predecessor separate TG row mismatch')
  return rows
}

export function assertRepositoryRawPredecessorEvidence(bytes, inventory) {
  assert(Buffer.isBuffer(bytes), 'raw predecessor evidence must be verified from repository bytes')
  assert(bytes.length === RAW_PREDECESSOR_EVIDENCE_SIZE && digestBytes(bytes) === RAW_PREDECESSOR_EVIDENCE_SHA256, 'raw predecessor evidence capture checksum/size mismatch')
  let raw
  try {
    raw = gunzipSync(Buffer.from(bytes.toString('ascii').replace(/\s/gu, ''), 'base64'))
  } catch (error) {
    throw new Error('raw predecessor evidence capture decode failed', { cause: error })
  }
  assert(raw.length === 1210008 && digestBytes(raw) === PREDECESSOR_RUNTIME_ARTIFACT_SHA256, 'decoded raw predecessor artifact checksum/size mismatch')
  const evidence = JSON.parse(raw.toString('utf8'))
  assert(evidence.schema === 'yoko.project-operator.response.v1'
    && evidence.ok === true
    && evidence.operation === 'evidence.runtime-content-manifest'
    && evidence.timestamp === '2026-08-08T20:50:42Z'
    && evidence.evidence?.schema === 'yoko.project-operator.runtime-content-manifest.v1', 'raw predecessor runtime manifest identity mismatch')
  const containers = new Map((evidence.evidence?.containers ?? []).map((container) => [container.name, container]))
  const gravity = containers.get('crm-gravity-mvp')
  const tg = containers.get('crm-tg-bot')
  assert(gravity?.container_id === '37ce24fdaf2421e3a8e655746c47e0f4faf920488097b65bd53317283ef692ee'
    && gravity.image_id === 'sha256:b36751e5a6d2b52e7a7676ee5babcd70f496111e9715e5056f6338d04b028f68'
    && gravity.manifest_sha256 === '7733f638d63a592a64dd318fa5ae42f653eca73731646618a7ae33cda6ec8baa', 'raw predecessor Gravity image identity mismatch')
  assert(tg?.container_id === 'c3fae82f86726739c6e768cd524f5903a1d0a9a0e926f86d9cc559ac633c0f7a'
    && tg.image_id === 'sha256:0849c4c9912aecf3cb7c35b51abba22cdb1c85a385afa6c2746000d14b9835f6'
    && tg.manifest_sha256 === '784a69a60e3cda2c6e67224c341e779ea582476de57dba48901254a6a48fecea', 'raw predecessor TG image identity mismatch')
  const gravityRows = runtimeMigrationRows(gravity)
  const tgRows = runtimeMigrationRows(tg)
  assert(gravityRows.length === 61, 'raw predecessor Gravity migration denominator mismatch')
  assert(tgRows.length === 1 && JSON.stringify(tgRows[0]) === JSON.stringify(SEPARATE_TG_ROW), 'raw predecessor TG migration row mismatch')
  const observed = [...gravityRows, ...tgRows].sort((left, right) => left.name.localeCompare(right.name))
  const expected = assertSanitizedPredecessorInventory(inventory)
  assert(observed.length === 62 && JSON.stringify(observed) === JSON.stringify(expected), 'raw predecessor evidence inventory checksum/name/size mismatch')
  return observed
}

export function assertAuthorityPredecessorInventory(authority, inventory) {
  const observed = assertSanitizedPredecessorInventory(inventory)
  const expected = normalizedRows(authority.migrations.filter((row) => row.name !== authority.current_target.name).concat([SEPARATE_TG_ROW]))
  assert(JSON.stringify(observed) === JSON.stringify(expected), 'authority predecessor inventory checksum/name/size mismatch')
  return { rows: observed.length, exact_inventory_match: true }
}

export function runtimeMigrationRows(runtime) {
  const rows = []
  const visit = (value) => {
    if (!value || typeof value !== 'object') return
    if (typeof value.path === 'string' && /^\/app\/prisma\/migrations\/[^/]+\/migration\.sql$/.test(value.path)) {
      rows.push({ name: value.path.split('/')[4], sha256: value.sha256, size: value.size })
    }
    Object.values(value).forEach(visit)
  }
  visit(runtime)
  return rows.sort((left, right) => left.name.localeCompare(right.name))
}

export function assertPredecessorRuntimeInventory(runtime, authority, inventory) {
  const observed = runtimeMigrationRows(runtime)
  const expected = assertSanitizedPredecessorInventory(inventory)
  assert(observed.length === authority.predecessor_runtime.image_migration_rows, 'runtime image migration row count mismatch')
  assert(JSON.stringify(observed) === JSON.stringify(expected), 'runtime image migration inventory checksum/name/size mismatch')
  assertAuthorityPredecessorInventory(authority, inventory)
  return { rows: observed.length, exact_inventory_match: true }
}

async function main() {
  const index = process.argv.indexOf('--runtime-manifest')
  const [authority, inventory] = await Promise.all([
    readFile(path.join(root, authorityPath), 'utf8').then(JSON.parse),
    readFile(path.join(root, PREDECESSOR_INVENTORY_PATH), 'utf8').then(JSON.parse),
  ])
  if (index >= 0 && process.argv[index + 1]) {
    const runtime = JSON.parse(await readFile(path.resolve(process.argv[index + 1]), 'utf8'))
    process.stdout.write(`${JSON.stringify({ ok: true, ...assertPredecessorRuntimeInventory(runtime, authority, inventory) })}\n`)
    return
  }
  assert(process.argv.includes('--sanitized-inventory'), 'usage: verify-production-migration-runtime.mjs --runtime-manifest <runtime.json> | --sanitized-inventory')
  const rawCapture = await readFile(path.join(root, RAW_PREDECESSOR_EVIDENCE_PATH))
  assertRepositoryRawPredecessorEvidence(rawCapture, inventory)
  process.stdout.write(`${JSON.stringify({ ok: true, ...assertAuthorityPredecessorInventory(authority, inventory) })}\n`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 })
}
