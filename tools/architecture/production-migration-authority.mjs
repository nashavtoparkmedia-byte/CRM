import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { access, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { gunzipSync } from 'node:zlib'
import os from 'node:os'
import path from 'node:path'
import {
  assertAuthorityPredecessorInventory,
  assertRepositoryRawPredecessorEvidence,
  assertSanitizedPredecessorInventory,
  PREDECESSOR_INVENTORY_PATH,
  RAW_PREDECESSOR_EVIDENCE_PATH,
  RAW_PREDECESSOR_EVIDENCE_SHA256,
  RAW_PREDECESSOR_EVIDENCE_SIZE,
} from './verify-production-migration-runtime.mjs'
import {
  PROVENANCE_EVIDENCE_AUTHORITY,
  verifyProductionMigrationProvenanceEvidence,
} from './verify-production-migration-provenance.mjs'

export const AUTHORITY_PATH = 'architecture/migrations/v1/production-migration-authority.json'
export const PENDING_SOURCE_PATH = 'architecture/migrations/v1/pending-source-migrations.json'
export const ARCHIVE_ROOT = 'architecture/migrations/v1/archive/pre-outbox'
const SHA256 = /^[0-9a-f]{64}$/

const digest = (value) => createHash('sha256').update(value).digest('hex')
const stable = (value) => {
  if (Array.isArray(value)) return value.map(stable)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]))
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const exactObject = (value, expected) => JSON.stringify(stable(value)) === JSON.stringify(stable(expected))

const FETCHED_REF = 'refs/remotes/origin/feature/personal-max-text-canary-autonomous-20260728T211316Z'
const FETCHED_COMMIT = '8a9e7f79d91268ee4baf11ae5c440041875de424'
const FETCHED_SOURCE_BLOBS = new Map([
  ['20260712000000_multi_park_driver_profiles', 'f80f94511f4c3a06e518e9c00b7b5e03cb172112'],
  ['20260713000000_stable_park_identity', '0b39a78013701051ba50155d73de847632c939cd'],
  ['20260713010000_driver_profile_person_resolution', '9de1cf48a48d8e88cd78ab2afa1be1acc69db30d'],
  ['20260726162043_add_max_raw_transport_journal', '06c63a56d47e60e4e2ca9158cf68d92eaf34b1c7'],
  ['20260726190658_add_max_route_registry', 'ed30f05e54a5d2b7b04425e446fe64c873f7c194'],
  ['20260726205437_add_max_inbound_normalization', 'c1d242b010473ddaac8b9381629324d809fb7c73'],
  ['20260726215715_add_max_per_chat_outbound_actor', 'f37d0e2a1858e1cbb5540bd9fe761d90d7d48979'],
  ['20260726225737_add_max_dispatch_ledger', '3f99cb38bdc649cf7db0d641da1ffc83fd496d9b'],
  ['20260727053744_add_max_provider_confirmation_matcher', '9bdef8be4731dbf979ec710a19c9cefac367f1da'],
  ['20260727141925_add_max_shadow_semantic_comparison', 'fd3ba16cf5f38456e9c3f71d689b1f33f5903dea'],
  ['20260727154647_add_max_capture_ingress', '18dbc0245b1c218433a2fdee28235056971459a1'],
  ['20260728213000_add_max_account_session_owner', '4af909fcb389e19ff1c8ea3cf243f0bf2d04207a'],
  ['20260728214000_add_max_outbound_shadow_plan', 'fc6eb6211f812ecadb11d83ff9872cfea1e09c98'],
])
const SPECIAL_PROVENANCE = new Map([
  ['20260717000000_add_driver_telegram_submitted_phone', {
    kind: 'evidence_snapshot',
    artifact: '/opt/codex-work/crm-arch-000-evidence/20260808T070726Z/files/gravity-mvp/prisma/migrations/20260717000000_add_driver_telegram_submitted_phone/migration.sql',
    artifact_sha256: '03013fdf531f45c3b012c13fa15581be29f6399019f5b1dd308c4f8c407ae7e5',
    repository_package_root: 'architecture/migrations/v1/provenance/snapshot/20260808T070726Z',
    package_member: 'files/gravity-mvp/prisma/migrations/20260717000000_add_driver_telegram_submitted_phone/migration.sql',
    package_sha256: 'ba987cb23ebf6be8111b59f423ca6d2aadd6b508e82281365c60a870f1bc0a3c',
    repository_capture: 'architecture/migrations/v1/archive/pre-outbox/20260717000000_add_driver_telegram_submitted_phone/migration.sql',
  }],
  ['20260728213000_add_max_account_session_owner', {
    kind: 'fetched_ref', ref: FETCHED_REF, introduced_by: 'b562dea608942c47c2b0ade6f87fed77a10b54a0',
  }],
  ['20260728214000_add_max_outbound_shadow_plan', {
    kind: 'fetched_ref', ref: FETCHED_REF, introduced_by: 'efbdcd893b222ed5e2e4246d2b8e01cb3b094056', later_present_at: 'dfce596b2f69e9a9004ae04cc550bf26be90a35c',
  }],
  ['20260805073000_add_bot_user_registry', {
    kind: 'root_broker_untracked_capture',
    root_broker_package: 'architecture/migrations/v1/provenance/root-broker/20260808T122923Z',
    raw_git_state_sha256: '6318696f1d66d7bb7451d3a097b20846ace850fd954d1737905aeb33d4ce8f13',
    untracked_record: { mode: '0644', path: 'gravity-mvp/prisma/migrations/20260805073000_add_bot_user_registry/migration.sql', sensitive_path: false, sha256: 'ef2df9ac72e1cec7d9ce00cc81e5e13eaf35161d0cfd20c379e82cec24cf4b0c', size: 3539, working_blob: '32eef929cf8568809c5886f0571ac53e35dd1215' },
    supporting_patch: { migration_name: '20260805073000_add_bot_user_registry', path: 'architecture/migrations/v1/provenance/root-broker/patches/_bot_registry_prod_20260805.patch', sha256: '3744122e0f505a1af24043f20c1401fd3df633ea80b08aabeb48dcfd54349f4e', size: 54109 },
    supplemental_root_tree: { authority: 'SUPPLEMENTAL_NON_AUTHORIZING', tree: '9c4d4291c5d530d2ef1238bffd9b5d2737e9b13f', path: 'gravity-mvp/prisma/migrations/20260805073000_add_bot_user_registry/migration.sql', blob: '32eef929cf8568809c5886f0571ac53e35dd1215' },
    repository_capture: 'architecture/migrations/v1/archive/pre-outbox/20260805073000_add_bot_user_registry/migration.sql',
  }],
  ['20260805093000_prune_unverified_bot_registry_backfill', {
    kind: 'root_broker_untracked_capture',
    root_broker_package: 'architecture/migrations/v1/provenance/root-broker/20260808T122923Z',
    raw_git_state_sha256: '6318696f1d66d7bb7451d3a097b20846ace850fd954d1737905aeb33d4ce8f13',
    untracked_record: { mode: '0644', path: 'gravity-mvp/prisma/migrations/20260805093000_prune_unverified_bot_registry_backfill/migration.sql', sensitive_path: false, sha256: '0b1bfbb272692e281bc4037c4fc8e8246e64656603fc64b53a9179d2e6731871', size: 409, working_blob: '1d587c53577347ddbb57c3b8d589f8c39465c0aa' },
    supporting_patch: { migration_name: '20260805093000_prune_unverified_bot_registry_backfill', path: 'architecture/migrations/v1/provenance/root-broker/patches/_bot_registry_cleanup_prod_20260805.patch', sha256: 'ffcf6faef49247a5e7157b94860a5694b38196948a497fa4b50453bc7c979bda', size: 782 },
    supplemental_root_tree: { authority: 'SUPPLEMENTAL_NON_AUTHORIZING', tree: '9c4d4291c5d530d2ef1238bffd9b5d2737e9b13f', path: 'gravity-mvp/prisma/migrations/20260805093000_prune_unverified_bot_registry_backfill/migration.sql', blob: '1d587c53577347ddbb57c3b8d589f8c39465c0aa' },
    repository_capture: 'architecture/migrations/v1/archive/pre-outbox/20260805093000_prune_unverified_bot_registry_backfill/migration.sql',
  }],
  ['20260805110000_restore_linked_bot_registry', {
    kind: 'root_broker_untracked_capture',
    root_broker_package: 'architecture/migrations/v1/provenance/root-broker/20260808T122923Z',
    raw_git_state_sha256: '6318696f1d66d7bb7451d3a097b20846ace850fd954d1737905aeb33d4ce8f13',
    untracked_record: { mode: '0644', path: 'gravity-mvp/prisma/migrations/20260805110000_restore_linked_bot_registry/migration.sql', sensitive_path: false, sha256: 'b84f066aca9a197050247d5958771c213c6d9d142bd242ba1f8769974a9bcaa4', size: 639, working_blob: '901894736817062b87b01dcdc481f35cfd10e578' },
    supporting_patch: { migration_name: '20260805110000_restore_linked_bot_registry', path: 'architecture/migrations/v1/provenance/root-broker/patches/_bot_profile_linked_registry_prod_20260805.patch', sha256: '4a86d9ca805d32fb15276a875462abc60b4b7644bf47b591fa9bdef301b2820e', size: 994 },
    supplemental_root_tree: { authority: 'SUPPLEMENTAL_NON_AUTHORIZING', tree: '9c4d4291c5d530d2ef1238bffd9b5d2737e9b13f', path: 'gravity-mvp/prisma/migrations/20260805110000_restore_linked_bot_registry/migration.sql', blob: '901894736817062b87b01dcdc481f35cfd10e578' },
    repository_capture: 'architecture/migrations/v1/archive/pre-outbox/20260805110000_restore_linked_bot_registry/migration.sql',
  }],
  ['20260806181500_repair_max_sergey_mirror_timeline', {
    kind: 'git_commit', commit: '74657f827153babbe601a2765bf6c526efbb73d2',
    source_path: 'gravity-mvp/prisma/migrations/20260806181500_repair_max_sergey_mirror_timeline/migration.sql',
    source_blob: 'a805d5d2ecbf80aeb0c73532924bbbec0192614e',
  }],
  ['20260809140000_add_domain_outbox', {
    kind: 'current_target_source', path: 'gravity-mvp/prisma/migrations/20260809140000_add_domain_outbox/migration.sql',
  }],
])

function expectedProvenance(row, predecessorNames) {
  const repository_capture = row.storage === 'archive'
    ? `${ARCHIVE_ROOT}/${row.name}/migration.sql`
    : `gravity-mvp/prisma/migrations/${row.name}/migration.sql`
  const special = SPECIAL_PROVENANCE.get(row.name)
  if (special) {
    const provenance = { ...special, repository_capture }
    if (provenance.kind === 'fetched_ref') {
      provenance.resolved_commit = FETCHED_COMMIT
      provenance.source_path = `gravity-mvp/prisma/migrations/${row.name}/migration.sql`
      provenance.source_blob = FETCHED_SOURCE_BLOBS.get(row.name)
    }
    return provenance
  }
  if (row.storage === 'archive') return {
    kind: 'fetched_ref',
    ref: FETCHED_REF,
    resolved_commit: FETCHED_COMMIT,
    source_path: `gravity-mvp/prisma/migrations/${row.name}/migration.sql`,
    source_blob: FETCHED_SOURCE_BLOBS.get(row.name),
    repository_capture,
  }
  if (predecessorNames.has(row.name)) return { kind: 'predecessor_image_exact', repository_capture }
  return null
}

function assertExactSourceBytes(row, bytes, description) {
  assert(digest(bytes) === row.sha256 && bytes.length === row.size, `${description} checksum/size mismatch: ${row.name}`)
}

async function verifyProvenanceSourceBytes(root, row) {
  const capture = await readFile(path.join(root, row.provenance.repository_capture)).catch((error) => {
    throw new Error(`authoritative migration provenance capture missing: ${row.name}`, { cause: error })
  })
  assertExactSourceBytes(row, capture, 'repository canonical provenance capture')
  if (row.provenance.kind === 'predecessor_image_exact') return
  if (row.provenance.kind === 'fetched_ref') {
    return
  }
  if (row.provenance.kind === 'root_broker_untracked_capture') {
    return
  }
  if (row.provenance.kind === 'git_commit') {
    return
  }
  if (row.provenance.kind === 'evidence_snapshot') {
    assert(row.provenance.artifact_sha256 === row.sha256, `evidence snapshot lineage checksum mismatch: ${row.name}`)
    return
  }
  if (row.provenance.kind === 'current_target_source') {
    assert(row.provenance.path === row.provenance.repository_capture, `current-target capture path mismatch: ${row.name}`)
    return
  }
  throw new Error(`unsupported migration provenance kind: ${row.name}`)
}

async function readCompressedCapture(root, capture, label) {
  const encoded = await readFile(path.join(root, capture.path))
  assert(encoded.length === capture.capture_size && digest(encoded) === capture.capture_sha256, `schema ${label} capture checksum/size mismatch`)
  assert(capture.encoding === 'base64(gzip-n)', `schema ${label} capture encoding mismatch`)
  let decoded
  try {
    decoded = gunzipSync(Buffer.from(encoded.toString('ascii').replace(/\s/gu, ''), 'base64'))
  } catch (error) {
    throw new Error(`schema ${label} capture decode failed`, { cause: error })
  }
  assert(decoded.length === capture.decoded_size && digest(decoded) === capture.decoded_sha256, `schema ${label} decoded checksum/size mismatch`)
  return decoded
}

async function verifySchemaDerivation(root, currentSchema) {
  const derivation = currentSchema.derivation
  const starting = await readCompressedCapture(root, derivation.starting_schema_capture, 'starting')
  const base = await readCompressedCapture(root, derivation.merge_base_schema_capture, 'merge-base')
  const production = await readCompressedCapture(root, derivation.production_schema_capture, 'production-history')
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'yoko-schema-derivation-'))
  try {
    const ours = path.join(workspace, 'starting.prisma')
    const ancestor = path.join(workspace, 'base.prisma')
    const theirs = path.join(workspace, 'production.prisma')
    await Promise.all([writeFile(ours, starting), writeFile(ancestor, base), writeFile(theirs, production)])
    const merge = spawnSync('git', ['merge-file', '-p', ours, ancestor, theirs], { cwd: workspace, encoding: null })
    assert(merge.status === 0, `schema derivation merge is not clean: ${merge.stderr?.toString('utf8').trim() ?? ''}`)
    const merged = merge.stdout.toString('utf8')
    assert(digest(merge.stdout) === derivation.clean_merge_sha256, 'schema clean-merge checksum mismatch')
    const fieldAnchor = '  activeParkId  String?\n  createdAt'
    assert(merged.split(fieldAnchor).length === 2, 'recovered DriverTelegram field anchor is not unique')
    const recovered = merged.replace(
      fieldAnchor,
      '  activeParkId  String?\n  submittedPhone String?\n  submittedPhoneAt DateTime?\n  createdAt',
    )
    assert(digest(recovered) === currentSchema.sha256, 'reproducible schema derivation differs from pinned applied schema')
    return Buffer.from(recovered)
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
}

export function canonicalInventoryDigest(rows) {
  const canonical = rows.map(({ name, sha256, size }) => ({ name, sha256, size }))
    .sort((left, right) => left.name.localeCompare(right.name))
  return digest(`${JSON.stringify(canonical)}\n`)
}

async function migrationFiles(root, relative) {
  const directory = path.join(root, relative)
  const entries = await readdir(directory, { withFileTypes: true })
  const records = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const file = path.join(directory, entry.name, 'migration.sql')
    try {
      const bytes = await readFile(file)
      records.push({ name: entry.name, sha256: digest(bytes), size: bytes.length, relative: path.join(relative, entry.name, 'migration.sql') })
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
  return records.sort((left, right) => left.name.localeCompare(right.name))
}

export async function validateProductionMigrationAuthority(root) {
  const authority = JSON.parse(await readFile(path.join(root, AUTHORITY_PATH), 'utf8'))
  const pending = JSON.parse(await readFile(path.join(root, PENDING_SOURCE_PATH), 'utf8'))
  const predecessorInventory = JSON.parse(await readFile(path.join(root, PREDECESSOR_INVENTORY_PATH), 'utf8'))
  assert(authority.schema === 'yoko.crm.production-migration-authority.v1' && authority.version === 1, 'migration authority identity mismatch')
  assert(exactObject(authority.provenance_evidence, PROVENANCE_EVIDENCE_AUTHORITY), 'production migration provenance evidence authority mismatch')
  assert(authority.predecessor_runtime?.artifact === '/opt/codex-work/crm-arch-000-evidence/crm-arch-000r/20260808T204949Z-operator/raw/runtime.json', 'predecessor runtime provenance mismatch')
  assert(authority.predecessor_runtime?.image_migration_rows === 62, 'predecessor image row count mismatch')
  assert(authority.predecessor_runtime?.excluded_separate_migration === '20260223211509_add_is_linear_to_survey', 'separate TG migration exclusion mismatch')
  assert(authority.predecessor_runtime?.normalized_pre_outbox_digest === 'f8e57fd9fe0166ac964c928c29eb0e87820797508959dae0ba11fd75d5907201', 'predecessor normalized digest mismatch')
  assert(authority.predecessor_runtime?.sanitized_inventory === PREDECESSOR_INVENTORY_PATH, 'predecessor sanitized inventory provenance mismatch')
  assert(authority.predecessor_runtime?.repository_raw_capture === RAW_PREDECESSOR_EVIDENCE_PATH
    && authority.predecessor_runtime?.repository_raw_capture_sha256 === RAW_PREDECESSOR_EVIDENCE_SHA256
    && authority.predecessor_runtime?.repository_raw_capture_size === RAW_PREDECESSOR_EVIDENCE_SIZE, 'repository raw predecessor evidence authority mismatch')
  const rawPredecessorEvidence = await readFile(path.join(root, RAW_PREDECESSOR_EVIDENCE_PATH)).catch((error) => {
    throw new Error('repository raw predecessor evidence capture missing', { cause: error })
  })
  assertRepositoryRawPredecessorEvidence(rawPredecessorEvidence, predecessorInventory)
  assert(Array.isArray(authority.migrations) && authority.migrations.length === 62, 'production migration inventory must contain exactly 62 rows')
  const names = authority.migrations.map((row) => row.name)
  assert(new Set(names).size === names.length, 'duplicate production migration name')
  assert([...names].every((name) => /^[0-9][A-Za-z0-9_]*$/.test(name) || name === '0_init'), 'invalid production migration name')
  assert(authority.migrations.every((row) => SHA256.test(row.sha256) && Number.isInteger(row.size) && row.size > 0), 'invalid production migration checksum or size')
  assert(authority.migrations.every((row, index) => index === 0 || authority.migrations[index - 1].name.localeCompare(row.name) < 0), 'production migration inventory is not canonically sorted')
  assert(authority.migrations.every((row, index) => row.canonical_ordinal === index + 1), 'canonical migration ordinal mismatch')
  const predecessorRows = authority.migrations.filter((row) => row.name !== authority.current_target.name)
  assert(predecessorRows.every((row) => row.live_ledger?.status === 'FINISHED_ACTIVE'
    && row.live_ledger?.proof?.kind === 'exact_finite_predecessor_runtime_inventory'
    && row.live_ledger?.proof?.runtime_artifact === authority.predecessor_runtime.artifact
    && row.live_ledger?.proof?.image_migration_rows === 62
    && row.live_ledger?.proof?.normalized_pre_outbox_digest === authority.predecessor_runtime.normalized_pre_outbox_digest
    && row.live_ledger?.applied_timestamp?.availability === 'UNAVAILABLE'
    && row.live_ledger?.applied_timestamp?.value === null
    && typeof row.live_ledger?.applied_timestamp?.provenance === 'string'), 'predecessor live migration ledger provenance mismatch')
  const outbox = authority.migrations.find((row) => row.name === authority.current_target.name)
  assert(outbox?.live_ledger?.status === 'FINISHED_ACTIVE'
    && outbox.live_ledger?.proof?.kind === 'post_outbox_runtime_database_status'
    && outbox.live_ledger?.proof?.acceptance_artifact === 'architecture/recovery/whole-project-dod/v2/PRODUCTION_ACTIVATION_ACCEPTANCE_20260812.json'
    && outbox.live_ledger?.proof?.runtime_package_version === '2.0.0-9'
    && outbox.live_ledger?.proof?.migration_count === 62
    && outbox.live_ledger?.proof?.migration_ledger_sha256 === 'a50f1a8988f79c85059354d6b2d45e9e8ed07284fc27c78d98face6680f25dfc'
    && outbox.live_ledger?.proof?.migration_state === 'APPROVED_OUTBOX_APPLIED'
    && outbox.live_ledger?.proof?.outbox_catalog_state === 'EXACT'
    && outbox.live_ledger?.applied_timestamp?.availability === 'UNAVAILABLE'
    && outbox.live_ledger?.applied_timestamp?.value === null
    && typeof outbox.live_ledger?.applied_timestamp?.provenance === 'string', 'outbox live migration ledger provenance mismatch')
  assert(authority.current_target?.name === '20260809140000_add_domain_outbox' && authority.current_target?.sha256 === '433b0d503f054ed6a8161a059e2650d5e401829dabe8c9d992a1d1763eef0016', 'current outbox target mismatch')
  assert(exactObject(authority.current_schema, {
    path: 'gravity-mvp/prisma/schema.prisma',
    sha256: '287d39d324cd0a2b616eb7127cd520ea8ee5ce9d517620aafc5b07240cdf0b48',
    expected_replay_parity: 'ZERO_PRISMA_DATAMODEL_DIFF',
    derivation: {
      starting_source_commit: 'c6f352aec53fabe6415ace6c1ea73072f2d73ac6',
      merge_base: 'e6a0a833fbb756216b058bfe326f9f9c77c4cc6d',
      production_history_ref: FETCHED_REF,
      production_history_commit: '8a9e7f79d91268ee4baf11ae5c440041875de424',
      starting_schema_blob: '206c12c2452c439939a12c710202724aaff4f46c',
      merge_base_schema_blob: '8db86c3e703eea4db4e54c921c55d2a7ea00ced2',
      production_schema_blob: '29b6d217bd971d0c2f2b8a871fe20bef60c39c66',
      separate_recovered_field_migration: '20260717000000_add_driver_telegram_submitted_phone',
      clean_merge_sha256: '5d4ba9e942b4c2aa0210899d121008d0234875d176529229822206c8b98b7dc4',
      starting_schema_capture: {
        path: 'architecture/migrations/v1/provenance/schema/starting-c6f352a.prisma.gz.b64',
        encoding: 'base64(gzip-n)',
        capture_sha256: '9def109adf110847a708b45f3d1bd516722d83115055957400d8fe1a27b69697',
        capture_size: 33714,
        decoded_sha256: 'cdedb7f65ef4077152a89acd9040ba6748c41eb89eceda5aff8d27ed7dfa8082',
        decoded_size: 88394,
      },
      merge_base_schema_capture: {
        path: 'architecture/migrations/v1/provenance/schema/merge-base-e6a0a83.prisma.gz.b64',
        encoding: 'base64(gzip-n)',
        capture_sha256: 'bc9729ca42ebac02d40917bcea786ea5bbfc4ac5c43085716a8fda8e45079d7d',
        capture_size: 33029,
        decoded_sha256: '64a830b2973bfc685b029ffac0dc887d4f661ccdf4157c00e32b4dbb5067defd',
        decoded_size: 86629,
      },
      production_schema_capture: {
        path: 'architecture/migrations/v1/provenance/schema/production-8a9e7f7.prisma.gz.b64',
        encoding: 'base64(gzip-n)',
        capture_sha256: 'ea23588e541b05516d9915eb0676d9f409245c18fa4bc1ede797ebdc94292d59',
        capture_size: 43238,
        decoded_sha256: '996801030613eaa90ef5c67cc9ee8cc4bc8615984dd62c2b0e3f24bb1c32419c',
        decoded_size: 133008,
      },
    },
  }), 'current production schema authority mismatch')
  await verifySchemaDerivation(root, authority.current_schema)
  assert(pending.schema === 'yoko.crm.pending-source-migrations.v1'
    && pending.version === 1
    && pending.status === 'SOURCE_ONLY_NOT_APPLIED', 'pending source migration authority identity mismatch')
  assert(exactObject(pending.base_authority, {
    path: AUTHORITY_PATH,
    current_target: authority.current_target.name,
    current_schema_sha256: authority.current_schema.sha256,
  }), 'pending source migration base authority mismatch')
  assert(Array.isArray(pending.migrations) && pending.migrations.length > 0, 'pending source migration inventory is empty')
  assert(pending.migrations.every((row) => /^[0-9][A-Za-z0-9_]*$/.test(row.name)
    && row.path === `gravity-mvp/prisma/migrations/${row.name}/migration.sql`
    && SHA256.test(row.sha256)
    && Number.isInteger(row.size) && row.size > 0
    && row.owner_context === 'calling'
    && row.classification === 'EXPAND_ONLY'
    && row.production_application === false), 'pending source migration record mismatch')
  assert(new Set(pending.migrations.map((row) => row.name)).size === pending.migrations.length, 'duplicate pending source migration name')
  assert(pending.migrations.every((row, index) => index === 0 || pending.migrations[index - 1].name.localeCompare(row.name) < 0), 'pending source migration inventory is not sorted')
  assert(pending.migrations.every((row) => !authority.migrations.some((applied) => applied.name === row.name)), 'pending source migration is claimed as applied')
  const sourceSchemaBytes = await readFile(path.join(root, pending.source_schema.path))
  assert(pending.source_schema.path === authority.current_schema.path
    && SHA256.test(pending.source_schema.sha256)
    && pending.source_schema.size === sourceSchemaBytes.length
    && digest(sourceSchemaBytes) === pending.source_schema.sha256
    && pending.source_schema.expected_isolated_replay_parity === 'ZERO_PRISMA_DATAMODEL_DIFF_AFTER_PENDING_SOURCE', 'pending source schema checksum/size mismatch')
  assert(exactObject(pending.proof, {
    database_scope: 'ISOLATED_REAL_POSTGRESQL_ONLY',
    migration_test: 'gravity-mvp/src/modules/calling/internal/ai-calls/ai-call-campaign-product.postgres.test.ts',
    authority_replay: 'tools/architecture/replay-production-migration-authority.mjs --allow-isolated-replay',
    production_database_touched: false,
  }), 'pending source migration proof boundary mismatch')
  assert(exactObject(pending.rollback_strategy, {
    deployment_order: 'MIGRATION_BEFORE_CODE',
    code_rollback: 'ROLL_BACK_CODE_KEEP_ADDITIVE_TABLES',
    schema_rollback: 'NO_DESTRUCTIVE_DOWN_MIGRATION',
    failed_apply_recovery: 'TRANSACTION_ROLLS_BACK_DDL_THEN_PRISMA_MIGRATE_RESOLVE_ROLLED_BACK_BEFORE_RETRY',
    authority_promotion: 'SEPARATE_REVIEW_MOVES_PENDING_SOURCE_TO_APPLIED_AUTHORITY',
  }), 'pending source migration rollback strategy mismatch')
  assert(authority.inventory_digest === canonicalInventoryDigest(authority.migrations), 'production migration inventory digest mismatch')
  const independentlyValidatedPredecessorRows = assertSanitizedPredecessorInventory(predecessorInventory)
  const predecessorNames = new Set(independentlyValidatedPredecessorRows
    .filter((row) => row.name !== authority.predecessor_runtime.excluded_separate_migration)
    .map((row) => row.name))
  assert(independentlyValidatedPredecessorRows.length === 62 && predecessorNames.size === 61, 'predecessor evidence denominator mismatch')
  for (const row of authority.migrations) {
    const expectedProvenanceValue = expectedProvenance(row, predecessorNames)
    assert(expectedProvenanceValue && exactObject(row.provenance, expectedProvenanceValue), `migration provenance mismatch: ${row.name}`)
    if (row.provenance.kind === 'predecessor_image_exact') {
      assert(predecessorNames.has(row.name), `predecessor provenance is not independently evidenced: ${row.name}`)
    }
    await verifyProvenanceSourceBytes(root, row)
  }
  await verifyProductionMigrationProvenanceEvidence(root, authority)
  const predecessorEvidence = assertAuthorityPredecessorInventory(authority, predecessorInventory)
  assert(predecessorEvidence.rows === 62, 'predecessor authority denominator mismatch')

  const expected = new Map(authority.migrations.map((row) => [row.name, row]))
  const expectedPending = new Map(pending.migrations.map((row) => [row.name, row]))
  const active = await migrationFiles(root, 'gravity-mvp/prisma/migrations')
  const archive = await migrationFiles(root, ARCHIVE_ROOT)
  assert(active.every((row) => expected.has(row.name) || expectedPending.has(row.name)), 'active Prisma migration is not authorized')
  assert(archive.every((row) => expected.has(row.name)), 'archived migration is not authorized')
  const activeByName = new Map(active.map((row) => [row.name, row]))
  const archiveByName = new Map(archive.map((row) => [row.name, row]))
  for (const row of authority.migrations) {
    const source = row.storage === 'archive' ? archiveByName.get(row.name) : activeByName.get(row.name)
    assert(source, `authoritative migration source missing: ${row.name}`)
    assert(row.sha256 === source.sha256 && row.size === source.size, `migration checksum mismatch: ${row.name}`)
    const variant = row.noncanonical_source_variant
    if (variant) {
      assert(row.storage === 'archive', `noncanonical source variant requires archived canonical migration: ${row.name}`)
      assert(SHA256.test(variant.sha256) && Number.isInteger(variant.size) && variant.size > 0, `invalid noncanonical source variant: ${row.name}`)
      const observed = activeByName.get(row.name)
      assert(observed, `noncanonical source variant missing: ${row.name}`)
      assert(observed.sha256 === variant.sha256 && observed.size === variant.size, `noncanonical source variant mismatch: ${row.name}`)
    } else if (row.storage === 'active') {
      assert(!archiveByName.has(row.name), `active migration shadowed by archive: ${row.name}`)
    } else {
      assert(!activeByName.has(row.name), `unrecognized active variant: ${row.name}`)
    }
  }
  for (const row of active) {
    if (!archiveByName.has(row.name)) continue
    const expectedRow = expected.get(row.name)
    assert(expectedRow?.noncanonical_source_variant, `unknown same-name active/archive duplicate: ${row.name}`)
  }
  for (const row of pending.migrations) {
    const observed = activeByName.get(row.name)
    assert(observed, `pending source migration missing: ${row.name}`)
    assert(observed.sha256 === row.sha256 && observed.size === row.size, `pending source migration checksum mismatch: ${row.name}`)
    assert(!archiveByName.has(row.name), `pending source migration shadowed by archive: ${row.name}`)
  }
  assert(authority.migrations.filter((row) => row.storage === 'archive').length === archive.length, 'archive inventory classification mismatch')
  assert(authority.migrations.filter((row) => row.storage === 'active').length + pending.migrations.length === active.filter((row) => !archiveByName.has(row.name)).length, 'active inventory classification mismatch')
  assert(authority.migrations.every((row) => row.storage === 'active' || row.storage === 'archive'), 'invalid migration storage classification')
  return {
    active: active.filter((row) => expected.has(row.name) && !archiveByName.has(row.name)).length,
    archive: archive.length,
    total: authority.migrations.length,
    inventoryDigest: authority.inventory_digest,
  }
}

export async function assertReadableAuthority(root) {
  await access(path.join(root, AUTHORITY_PATH))
  return validateProductionMigrationAuthority(root)
}
