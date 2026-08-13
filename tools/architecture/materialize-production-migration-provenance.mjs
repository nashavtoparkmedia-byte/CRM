#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { cp, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyProductionMigrationProvenanceEvidence } from './verify-production-migration-provenance.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const authorityPath = path.join(root, 'architecture/migrations/v1/production-migration-authority.json')
const gitEvidenceRelative = 'architecture/migrations/v1/provenance/git/production-migration-lineage-v1.json'
const snapshotRelative = 'architecture/migrations/v1/provenance/snapshot/20260808T070726Z'
const defaultSnapshotSource = '/opt/codex-work/crm-arch-000-evidence/20260808T070726Z'
const snapshotSource = path.resolve(process.argv[2] ?? defaultSnapshotSource)
const rootBrokerRelative = 'architecture/migrations/v1/provenance/root-broker/20260808T122923Z'
const defaultRootBrokerSource = '/opt/codex-work/crm-arch-000-evidence/crm-arch-000r/20260808T122923Z'
const rootBrokerSource = path.resolve(process.argv[3] ?? defaultRootBrokerSource)
const patchRelative = 'architecture/migrations/v1/provenance/root-broker/patches'
const defaultPatchSource = '/opt/codex-work/crm'
const patchSource = path.resolve(process.argv[4] ?? defaultPatchSource)

const FETCHED_REF = 'refs/remotes/origin/feature/personal-max-text-canary-autonomous-20260728T211316Z'
const FETCHED_COMMIT = '8a9e7f79d91268ee4baf11ae5c440041875de424'
const RECOVERED_ROOT_TREE = '9c4d4291c5d530d2ef1238bffd9b5d2737e9b13f'
const SNAPSHOT_MIGRATION = '20260717000000_add_driver_telegram_submitted_phone'
const GIT_COMMIT_MIGRATION = '20260806181500_repair_max_sergey_mirror_timeline'
const GIT_COMMIT = '74657f827153babbe601a2765bf6c526efbb73d2'
const GIT_COMMIT_BLOB = 'a805d5d2ecbf80aeb0c73532924bbbec0192614e'

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const sha1GitObject = (type, bytes) => createHash('sha1')
  .update(Buffer.from(`${type} ${bytes.length}\0`, 'ascii'))
  .update(bytes)
  .digest('hex')

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function git(args, encoding = null) {
  const result = spawnSync('git', args, { cwd: root, encoding, maxBuffer: 16 * 1024 * 1024 })
  assert(result.status === 0, `git ${args.join(' ')} failed: ${result.stderr?.toString('utf8').trim() ?? ''}`)
  return result.stdout
}

function parseCommit(bytes) {
  const header = bytes.subarray(0, bytes.indexOf(Buffer.from('\n\n'))).toString('utf8')
  const tree = /^tree ([0-9a-f]{40})$/mu.exec(header)?.[1]
  const parents = [...header.matchAll(/^parent ([0-9a-f]{40})$/gmu)].map((match) => match[1])
  assert(tree, 'commit object has no canonical tree header')
  return { tree, parents }
}

function parseTree(bytes) {
  const entries = []
  let offset = 0
  while (offset < bytes.length) {
    const space = bytes.indexOf(0x20, offset)
    const nul = bytes.indexOf(0x00, space + 1)
    assert(space > offset && nul > space && nul + 21 <= bytes.length, 'malformed tree object')
    const mode = bytes.subarray(offset, space).toString('ascii')
    const name = bytes.subarray(space + 1, nul).toString('utf8')
    const oid = bytes.subarray(nul + 1, nul + 21).toString('hex')
    entries.push({ mode, name, oid })
    offset = nul + 21
  }
  return entries
}

const authority = JSON.parse(await readFile(authorityPath, 'utf8'))
const objects = new Map()

function captureObject(oid, expectedType) {
  if (objects.has(oid)) {
    assert(objects.get(oid).type === expectedType, `object ${oid} type conflict`)
    return objects.get(oid).bytes
  }
  const type = git(['cat-file', '-t', oid], 'utf8').trim()
  assert(type === expectedType, `object ${oid} is ${type}, expected ${expectedType}`)
  const bytes = git(['cat-file', type, oid])
  assert(sha1GitObject(type, bytes) === oid, `Git object ${oid} failed canonical SHA-1 verification while capturing`)
  objects.set(oid, { type, bytes })
  return bytes
}

function captureCommit(oid) {
  return parseCommit(captureObject(oid, 'commit'))
}

function capturePath(anchorKind, anchorOid, sourcePath, expectedBlob, expectedPresence = true) {
  const segments = sourcePath.split('/')
  assert(segments.every((segment) => segment && segment !== '.' && segment !== '..'), `unsafe Git path: ${sourcePath}`)
  let tree = anchorKind === 'commit' ? captureCommit(anchorOid).tree : anchorOid
  for (let index = 0; index < segments.length; index += 1) {
    const entries = parseTree(captureObject(tree, 'tree'))
    const entry = entries.find((candidate) => candidate.name === segments[index])
    if (!entry) {
      assert(!expectedPresence && index === segments.length - 1, `Git path missing unexpectedly: ${sourcePath}`)
      return null
    }
    assert(expectedPresence || index < segments.length - 1, `Git path unexpectedly exists: ${sourcePath}`)
    if (index === segments.length - 1) {
      assert(entry.mode !== '40000' && entry.mode !== '040000', `Git path resolves to a tree: ${sourcePath}`)
      assert(entry.oid === expectedBlob, `Git path blob mismatch for ${sourcePath}: ${entry.oid}`)
      captureObject(entry.oid, 'blob')
      return entry.oid
    }
    assert(entry.mode === '40000' || entry.mode === '040000', `Git path component is not a tree: ${segments[index]}`)
    tree = entry.oid
  }
  throw new Error(`unreachable Git path capture state: ${sourcePath}`)
}

function captureDirectory(anchorKind, anchorOid, sourcePath, expectedPresence = true) {
  const segments = sourcePath.split('/')
  let tree = anchorKind === 'commit' ? captureCommit(anchorOid).tree : anchorOid
  for (let index = 0; index < segments.length; index += 1) {
    const entries = parseTree(captureObject(tree, 'tree'))
    const entry = entries.find((candidate) => candidate.name === segments[index])
    if (!entry) {
      assert(!expectedPresence, `Git directory missing unexpectedly: ${sourcePath}`)
      return null
    }
    if (!expectedPresence && index === segments.length - 1) {
      throw new Error(`Git directory unexpectedly exists: ${sourcePath}`)
    }
    assert(entry.mode === '40000' || entry.mode === '040000', `Git path component is not a tree: ${segments[index]}`)
    tree = entry.oid
  }
  return tree
}

function captureFirstParentAncestry(descendant, ancestor) {
  let current = descendant
  for (let depth = 0; depth < 2048; depth += 1) {
    const commit = captureCommit(current)
    if (current === ancestor) return
    assert(commit.parents.length > 0, `${ancestor} is not a first-parent ancestor of ${descendant}`)
    current = commit.parents[0]
  }
  throw new Error(`first-parent ancestry exceeded safety bound: ${descendant} -> ${ancestor}`)
}

const migrationPath = (name) => `gravity-mvp/prisma/migrations/${name}/migration.sql`
const gitClaims = []
for (const row of authority.migrations.filter((candidate) => candidate.provenance.kind === 'fetched_ref')) {
  const sourcePath = migrationPath(row.name)
  capturePath('commit', row.provenance.resolved_commit, sourcePath, row.provenance.source_blob)
  gitClaims.push({
    migration_name: row.name,
    provenance_kind: 'fetched_ref',
    anchor: { kind: 'ref', ref: row.provenance.ref, resolved_commit: row.provenance.resolved_commit },
    path: sourcePath,
    blob: row.provenance.source_blob,
  })
}
for (const row of authority.migrations.filter((candidate) => candidate.provenance.kind === 'root_broker_untracked_capture')) {
  const supplemental = row.provenance.supplemental_root_tree
  assert(supplemental.authority === 'SUPPLEMENTAL_NON_AUTHORIZING', `unanchored root tree cannot authorize provenance: ${row.name}`)
}
capturePath('commit', GIT_COMMIT, migrationPath(GIT_COMMIT_MIGRATION), GIT_COMMIT_BLOB)
gitClaims.push({
  migration_name: GIT_COMMIT_MIGRATION,
  provenance_kind: 'git_commit',
  anchor: { kind: 'commit', commit: GIT_COMMIT },
  path: migrationPath(GIT_COMMIT_MIGRATION),
  blob: GIT_COMMIT_BLOB,
})

const historyClaims = [
  {
    migration_name: '20260728213000_add_max_account_session_owner',
    kind: 'introduced_by',
    commit: 'b562dea608942c47c2b0ade6f87fed77a10b54a0',
    parent: 'd060c74a9faa395f044132a373c5204b052b6444',
    descendant_ref_commit: FETCHED_COMMIT,
    path: migrationPath('20260728213000_add_max_account_session_owner'),
    blob: '4af909fcb389e19ff1c8ea3cf243f0bf2d04207a',
  },
  {
    migration_name: '20260728214000_add_max_outbound_shadow_plan',
    kind: 'introduced_by',
    commit: 'efbdcd893b222ed5e2e4246d2b8e01cb3b094056',
    parent: 'b562dea608942c47c2b0ade6f87fed77a10b54a0',
    descendant_ref_commit: FETCHED_COMMIT,
    path: migrationPath('20260728214000_add_max_outbound_shadow_plan'),
    blob: '7a2f83640b895e2393e3d55e8d7c91331ccb2abc',
  },
  {
    migration_name: '20260728214000_add_max_outbound_shadow_plan',
    kind: 'later_present_at',
    commit: 'dfce596b2f69e9a9004ae04cc550bf26be90a35c',
    descendant_ref_commit: FETCHED_COMMIT,
    path: migrationPath('20260728214000_add_max_outbound_shadow_plan'),
    blob: 'fc6eb6211f812ecadb11d83ff9872cfea1e09c98',
  },
]
for (const claim of historyClaims) {
  captureFirstParentAncestry(claim.descendant_ref_commit, claim.commit)
  capturePath('commit', claim.commit, claim.path, claim.blob)
  if (claim.kind === 'introduced_by') {
    const commit = captureCommit(claim.commit)
    assert(commit.parents[0] === claim.parent, `introduced-by parent mismatch: ${claim.migration_name}`)
    captureDirectory('commit', claim.parent, claim.path.slice(0, -'/migration.sql'.length), false)
  }
}

const refSnapshot = git(['show-ref', '--verify', FETCHED_REF])
const expectedRefSnapshot = Buffer.from(`${FETCHED_COMMIT} ${FETCHED_REF}\n`, 'ascii')
assert(refSnapshot.equals(expectedRefSnapshot), 'fetched ref no longer resolves to the pinned commit')

const gitEvidence = {
  schema: 'yoko.crm.production-migration-git-object-lineage.v1',
  version: 1,
  object_format: {
    object_id: 'sha1(type + SP + decimal-size + NUL + raw-payload)',
    payload_encoding: 'base64',
    tree_entry_format: 'mode SP name NUL 20-byte-object-id',
  },
  ref_snapshot: {
    format: 'git-show-ref-v1',
    sha256: sha256(refSnapshot),
    size: refSnapshot.length,
    payload_base64: refSnapshot.toString('base64'),
  },
  claims: gitClaims.sort((left, right) => left.migration_name.localeCompare(right.migration_name)),
  history_claims: historyClaims,
  objects: [...objects.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([oid, object]) => ({
      oid,
      type: object.type,
      size: object.bytes.length,
      payload_base64: object.bytes.toString('base64'),
    })),
}
const gitEvidenceBytes = Buffer.from(`${JSON.stringify(gitEvidence, null, 2)}\n`)
const gitEvidencePath = path.join(root, gitEvidenceRelative)
await mkdir(path.dirname(gitEvidencePath), { recursive: true })
await writeFile(gitEvidencePath, gitEvidenceBytes)

async function packageFiles(directory, prefix = '') {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name
    const absolute = path.join(directory, entry.name)
    assert(!entry.isSymbolicLink(), `snapshot package symlink is forbidden: ${relative}`)
    if (entry.isDirectory()) files.push(...await packageFiles(absolute, relative))
    else {
      assert(entry.isFile(), `snapshot package special file is forbidden: ${relative}`)
      files.push(relative)
    }
  }
  return files
}

async function copyExactPackage(source, destination, label) {
  const sourceMetadata = await lstat(source)
  assert(sourceMetadata.isDirectory() && !sourceMetadata.isSymbolicLink(), `${label} source is not a real directory`)
  const sourceFiles = await packageFiles(source)
  let destinationExists = false
  try {
    const destinationMetadata = await lstat(destination)
    assert(destinationMetadata.isDirectory() && !destinationMetadata.isSymbolicLink(), `${label} destination is not a real directory`)
    const destinationFiles = await packageFiles(destination)
    assert(JSON.stringify(destinationFiles) === JSON.stringify(sourceFiles), `existing ${label} file set differs from source`)
    for (const relative of sourceFiles) {
      const [sourceBytes, destinationBytes] = await Promise.all([
        readFile(path.join(source, relative)),
        readFile(path.join(destination, relative)),
      ])
      assert(destinationBytes.equals(sourceBytes), `existing ${label} bytes differ: ${relative}`)
    }
    destinationExists = true
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  if (!destinationExists) {
    await mkdir(path.dirname(destination), { recursive: true })
    await cp(source, destination, { recursive: true, errorOnExist: true, force: false })
  }
  return sourceFiles
}

const ledgerPath = path.join(snapshotSource, 'PACKAGE_CONTENTS.tsv')
const digestPath = path.join(snapshotSource, 'PACKAGE_SHA256')
const manifestPath = path.join(snapshotSource, 'manifest.json')
const ledger = await readFile(ledgerPath)
const packageDigest = sha256(ledger)
assert((await readFile(digestPath, 'utf8')) === `${packageDigest}  PACKAGE_CONTENTS.tsv\n`, 'snapshot PACKAGE_SHA256 does not bind the ledger')
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
assert(manifest.schema === 'crm-arch-000r-production-only-evidence-v1', 'unexpected snapshot manifest schema')
assert(manifest.snapshot?.snapshot_id === '20260808T070726Z', 'unexpected snapshot identity')
assert(manifest.secret_screen?.result === 'CONTENT_EXCLUDED', 'snapshot was not secret-screened')
assert(JSON.stringify(manifest.secret_screen.files_excluded) === JSON.stringify(['deploy/docker-compose.production.yml']), 'unexpected secret exclusion set')
assert(!(await packageFiles(snapshotSource)).includes('files/deploy/docker-compose.production.yml'), 'secret-bearing compose bytes must not be captured')

const snapshotDestination = path.join(root, snapshotRelative)
await copyExactPackage(snapshotSource, snapshotDestination, 'snapshot package')

const rootBrokerDestination = path.join(root, rootBrokerRelative)
const rootBrokerFiles = await copyExactPackage(rootBrokerSource, rootBrokerDestination, 'root-broker package')
assert(rootBrokerFiles.length === 37, 'root-broker package must contain exactly 37 files')
const rootBrokerManifestBytes = await readFile(path.join(rootBrokerSource, 'MANIFEST.json'))
const rootBrokerChecksumsBytes = await readFile(path.join(rootBrokerSource, 'SHA256SUMS'))
const rootBrokerManifest = JSON.parse(rootBrokerManifestBytes)
assert(rootBrokerManifest.schema === 'CRM-ARCH-000R-EVIDENCE-MANIFEST-1'
  && rootBrokerManifest.evidence_root === defaultRootBrokerSource
  && rootBrokerManifest.checksum_file_sha256 === sha256(rootBrokerChecksumsBytes)
  && rootBrokerManifest.checksummed_entry_count === 35
  && rootBrokerManifest.secret_scan === 'PASS'
  && rootBrokerManifest.production_mutation === false, 'root-broker package manifest is not the exact secret-safe capture')

const patchNames = [
  '_bot_registry_prod_20260805.patch',
  '_bot_registry_cleanup_prod_20260805.patch',
  '_bot_profile_linked_registry_prod_20260805.patch',
]
await mkdir(path.join(root, patchRelative), { recursive: true })
for (const patchName of patchNames) {
  const source = path.join(patchSource, patchName)
  const destination = path.join(root, patchRelative, patchName)
  const sourceBytes = await readFile(source)
  try {
    const destinationMetadata = await lstat(destination)
    assert(destinationMetadata.isFile() && !destinationMetadata.isSymbolicLink(), `existing supporting patch is not a real file: ${patchName}`)
    assert((await readFile(destination)).equals(sourceBytes), `existing supporting patch differs from source: ${patchName}`)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    await cp(source, destination, { errorOnExist: true, force: false })
  }
}

const manifestBytes = await readFile(manifestPath)
const digestBytes = await readFile(digestPath)
const rawGitStateRelative = `${rootBrokerRelative}/production-git-index/raw/production-git-state.raw.json`
const normalizedGitStateRelative = `${rootBrokerRelative}/production-git-index/normalized/production-git-state.normalized.json`
const captureRelative = `${rootBrokerRelative}/production-git-index/production-git-state.capture.json`
const safetyRelative = `${rootBrokerRelative}/normalized/secret-safety-report.json`
const rootBrokerRawBytes = await readFile(path.join(root, rawGitStateRelative))
const rootBrokerNormalizedBytes = await readFile(path.join(root, normalizedGitStateRelative))
const rootBrokerCaptureBytes = await readFile(path.join(root, captureRelative))
const rootBrokerSafetyBytes = await readFile(path.join(root, safetyRelative))
const rootBrokerRaw = JSON.parse(rootBrokerRawBytes)
const rootBrokerRows = new Map(rootBrokerRaw.untracked.map((record) => [record.path, record]))
const patchDescriptors = [
  ['20260805073000_add_bot_user_registry', '_bot_registry_prod_20260805.patch'],
  ['20260805093000_prune_unverified_bot_registry_backfill', '_bot_registry_cleanup_prod_20260805.patch'],
  ['20260805110000_restore_linked_bot_registry', '_bot_profile_linked_registry_prod_20260805.patch'],
].map(([migration_name, patchName]) => {
  const patchPath = `${patchRelative}/${patchName}`
  return readFile(path.join(root, patchPath)).then((bytes) => ({ migration_name, path: patchPath, sha256: sha256(bytes), size: bytes.length }))
})
const resolvedPatchDescriptors = await Promise.all(patchDescriptors)
for (const row of authority.migrations) {
  if (row.provenance.kind === 'fetched_ref') row.provenance.source_path = migrationPath(row.name)
  if (row.name === '20260728213000_add_max_account_session_owner') {
    row.provenance.introduced_by = 'b562dea608942c47c2b0ade6f87fed77a10b54a0'
  }
  if (row.name === GIT_COMMIT_MIGRATION) {
    row.provenance.source_path = migrationPath(row.name)
    row.provenance.source_blob = GIT_COMMIT_BLOB
  }
  if (row.name === SNAPSHOT_MIGRATION) {
    row.provenance.repository_package_root = snapshotRelative
    row.provenance.package_member = `files/${migrationPath(row.name)}`
    row.provenance.package_sha256 = packageDigest
  }
  const patch = resolvedPatchDescriptors.find((candidate) => candidate.migration_name === row.name)
  if (patch) {
    const sourcePath = migrationPath(row.name)
    const record = rootBrokerRows.get(sourcePath)
    assert(record, `root-broker source row missing: ${row.name}`)
    row.provenance = {
      kind: 'root_broker_untracked_capture',
      root_broker_package: rootBrokerRelative,
      raw_git_state_sha256: sha256(rootBrokerRawBytes),
      untracked_record: record,
      supporting_patch: patch,
      supplemental_root_tree: {
        authority: 'SUPPLEMENTAL_NON_AUTHORIZING',
        tree: RECOVERED_ROOT_TREE,
        path: sourcePath,
        blob: record.working_blob,
      },
      repository_capture: row.provenance.repository_capture,
    }
  }
}
authority.provenance_evidence = {
  git_object_lineage: {
    schema: gitEvidence.schema,
    path: gitEvidenceRelative,
    sha256: sha256(gitEvidenceBytes),
    size: gitEvidenceBytes.length,
    object_count: gitEvidence.objects.length,
    claim_count: gitEvidence.claims.length,
  },
  snapshot_package: {
    schema: manifest.schema,
    root: snapshotRelative,
    snapshot_id: manifest.snapshot.snapshot_id,
    package_digest_algorithm: manifest.package_digest.algorithm,
    package_sha256: packageDigest,
    ledger_path: `${snapshotRelative}/PACKAGE_CONTENTS.tsv`,
    ledger_sha256: packageDigest,
    ledger_size: ledger.length,
    digest_path: `${snapshotRelative}/PACKAGE_SHA256`,
    digest_sha256: sha256(digestBytes),
    digest_size: digestBytes.length,
    manifest_path: `${snapshotRelative}/manifest.json`,
    manifest_sha256: sha256(manifestBytes),
    manifest_size: manifestBytes.length,
    ledger_members: ledger.toString('utf8').trimEnd().split('\n').length,
    package_files: (await packageFiles(snapshotSource)).length,
  },
  root_broker_package: {
    schema: rootBrokerManifest.schema,
    root: rootBrokerRelative,
    original_evidence_root: rootBrokerManifest.evidence_root,
    manifest_path: `${rootBrokerRelative}/MANIFEST.json`,
    manifest_sha256: sha256(rootBrokerManifestBytes),
    manifest_size: rootBrokerManifestBytes.length,
    checksums_path: `${rootBrokerRelative}/SHA256SUMS`,
    checksums_sha256: sha256(rootBrokerChecksumsBytes),
    checksums_size: rootBrokerChecksumsBytes.length,
    checksummed_members: rootBrokerManifest.checksummed_entry_count,
    package_files: rootBrokerFiles.length,
    raw_git_state_path: rawGitStateRelative,
    raw_git_state_sha256: sha256(rootBrokerRawBytes),
    raw_git_state_size: rootBrokerRawBytes.length,
    normalized_git_state_path: normalizedGitStateRelative,
    normalized_git_state_sha256: sha256(rootBrokerNormalizedBytes),
    normalized_git_state_size: rootBrokerNormalizedBytes.length,
    capture_path: captureRelative,
    capture_sha256: sha256(rootBrokerCaptureBytes),
    capture_size: rootBrokerCaptureBytes.length,
    secret_safety_report_path: safetyRelative,
    secret_safety_report_sha256: sha256(rootBrokerSafetyBytes),
    secret_safety_report_size: rootBrokerSafetyBytes.length,
    patch_root: patchRelative,
    patches: resolvedPatchDescriptors,
  },
}
await verifyProductionMigrationProvenanceEvidence(root, authority)
await writeFile(authorityPath, `${JSON.stringify(authority, null, 2)}\n`)

process.stdout.write(`${JSON.stringify(authority.provenance_evidence, null, 2)}\n`)
