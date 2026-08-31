#!/usr/bin/env node
import assert from 'node:assert/strict'
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { canonicalInventoryDigest, validateProductionMigrationAuthority } from './production-migration-authority.mjs'
import {
  extractNewFilePatch,
  ROOT_BROKER_MIGRATIONS,
  verifyGitObjectLineageBytes,
  verifyRootBrokerPackage,
} from './verify-production-migration-provenance.mjs'

const root = process.cwd()
const authorityPath = 'architecture/migrations/v1/production-migration-authority.json'
const pendingSourcePath = 'architecture/migrations/v1/pending-source-migrations.json'
const authority = JSON.parse(await readFile(path.join(root, authorityPath), 'utf8'))

async function makeFixtureTreeWritable(directory) {
  await chmod(directory, 0o700)
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) await makeFixtureTreeWritable(target)
    else await chmod(target, 0o600)
  }
}
const result = await validateProductionMigrationAuthority(root)
assert.deepEqual(result, {
  active: 44,
  archive: 18,
  total: 62,
  inventoryDigest: authority.inventory_digest,
})
assert.equal(authority.migrations.find((row) => row.name === '20260728213000_add_max_account_session_owner').sha256, 'a541540b9093e8532c3f4b0e13f2a1136b770830d880b648e87cd2bb9b88991c')
assert.equal(authority.migrations.find((row) => row.name === '20260728214000_add_max_outbound_shadow_plan').sha256, '2a1f5bc06b3e14ccfc1e4006aae34545e907805e5775e5556a1c86e07aaccc67')
assert.equal(authority.migrations.find((row) => row.name === '20260809140000_add_domain_outbox').sha256, '433b0d503f054ed6a8161a059e2650d5e401829dabe8c9d992a1d1763eef0016')
for (const [name, blob] of [
  ['20260805073000_add_bot_user_registry', '32eef929cf8568809c5886f0571ac53e35dd1215'],
  ['20260805093000_prune_unverified_bot_registry_backfill', '1d587c53577347ddbb57c3b8d589f8c39465c0aa'],
  ['20260805110000_restore_linked_bot_registry', '901894736817062b87b01dcdc481f35cfd10e578'],
]) {
  const row = authority.migrations.find((candidate) => candidate.name === name)
  assert.equal(row.storage, 'archive')
  assert.equal(row.provenance.kind, 'root_broker_untracked_capture')
  assert.equal(row.provenance.untracked_record.working_blob, blob)
  assert.equal(row.provenance.supplemental_root_tree.authority, 'SUPPLEMENTAL_NON_AUTHORIZING')
}
assert.deepEqual(await verifyRootBrokerPackage(root, authority), {
  files: 37,
  checksummedMembers: 35,
  rawGitStateSha256: '6318696f1d66d7bb7451d3a097b20846ace850fd954d1737905aeb33d4ce8f13',
  migrations: 3,
  patches: 3,
})
assert.equal(canonicalInventoryDigest(authority.migrations), authority.inventory_digest)

const fixture = await mkdtemp(path.join(os.tmpdir(), 'yoko-migration-authority-'))
const externalCustodyFixtures = []
try {
  await cp(path.join(root, 'gravity-mvp/prisma/migrations'), path.join(fixture, 'gravity-mvp/prisma/migrations'), { recursive: true })
  await cp(path.join(root, 'architecture/migrations/v1/archive/pre-outbox'), path.join(fixture, 'architecture/migrations/v1/archive/pre-outbox'), { recursive: true })
  await mkdir(path.join(fixture, 'gravity-mvp/prisma'), { recursive: true })
  await cp(path.join(root, 'gravity-mvp/prisma/schema.prisma'), path.join(fixture, 'gravity-mvp/prisma/schema.prisma'))
  await mkdir(path.join(fixture, 'architecture/migrations/v1'), { recursive: true })
  await cp(path.join(root, authorityPath), path.join(fixture, authorityPath), { recursive: true })
  await cp(path.join(root, pendingSourcePath), path.join(fixture, pendingSourcePath))
  await cp(path.join(root, 'architecture/migrations/v1/provenance'), path.join(fixture, 'architecture/migrations/v1/provenance'), { recursive: true })
  await makeFixtureTreeWritable(path.join(fixture, 'architecture/migrations/v1/provenance'))
  await cp(
    path.join(root, 'architecture/migrations/v1/predecessor-runtime-migration-inventory.json'),
    path.join(fixture, 'architecture/migrations/v1/predecessor-runtime-migration-inventory.json'),
  )
  await writeFile(path.join(fixture, 'architecture/migrations/v1/archive/pre-outbox/20260728213000_add_max_account_session_owner/migration.sql'), '-- drift\n')
  await assert.rejects(() => validateProductionMigrationAuthority(fixture), /repository canonical provenance capture checksum\/size mismatch: 20260728213000_add_max_account_session_owner/)
  await cp(path.join(root, authorityPath), path.join(fixture, authorityPath))
  await cp(
    path.join(root, 'architecture/migrations/v1/archive/pre-outbox/20260728213000_add_max_account_session_owner/migration.sql'),
    path.join(fixture, 'architecture/migrations/v1/archive/pre-outbox/20260728213000_add_max_account_session_owner/migration.sql'),
  )

  const recovered = '20260805073000_add_bot_user_registry'
  const canonicalArchive = path.join(fixture, 'architecture/migrations/v1/archive/pre-outbox', recovered, 'migration.sql')
  const activeVariant = path.join(fixture, 'gravity-mvp/prisma/migrations', recovered, 'migration.sql')
  await rm(canonicalArchive)
  await assert.rejects(() => validateProductionMigrationAuthority(fixture), /authoritative migration provenance capture missing: 20260805073000_add_bot_user_registry/)
  await cp(path.join(root, 'architecture/migrations/v1/archive/pre-outbox', recovered, 'migration.sql'), canonicalArchive)

  await rm(activeVariant)
  await assert.rejects(() => validateProductionMigrationAuthority(fixture), /noncanonical source variant missing: 20260805073000_add_bot_user_registry/)
  await cp(path.join(root, 'gravity-mvp/prisma/migrations', recovered, 'migration.sql'), activeVariant)
  await writeFile(activeVariant, '-- drift\n')
  await assert.rejects(() => validateProductionMigrationAuthority(fixture), /noncanonical source variant mismatch: 20260805073000_add_bot_user_registry/)
  await cp(path.join(root, 'gravity-mvp/prisma/migrations', recovered, 'migration.sql'), activeVariant)

  // Alter both an authoritative source and its matching authority row.  The
  // independently committed predecessor inventory must still reject this
  // coordinated rewrite.
  const coTampered = JSON.parse(await readFile(path.join(fixture, authorityPath), 'utf8'))
  const coTamperedRow = coTampered.migrations.find((row) => row.storage === 'active' && row.name !== coTampered.current_target.name)
  assert(coTamperedRow, 'fixture must include a non-outbox active predecessor migration')
  const coTamperedPath = path.join(fixture, 'gravity-mvp/prisma/migrations', coTamperedRow.name, 'migration.sql')
  const coTamperedSql = '-- coordinated authority and source rewrite\n'
  coTamperedRow.sha256 = createHash('sha256').update(coTamperedSql).digest('hex')
  coTamperedRow.size = Buffer.byteLength(coTamperedSql)
  coTampered.inventory_digest = canonicalInventoryDigest(coTampered.migrations)
  await writeFile(coTamperedPath, coTamperedSql)
  await writeFile(path.join(fixture, authorityPath), `${JSON.stringify(coTampered, null, 2)}\n`)
  await assert.rejects(() => validateProductionMigrationAuthority(fixture), /raw predecessor evidence inventory checksum\/name\/size mismatch|authority predecessor inventory checksum\/name\/size mismatch/)
  await cp(path.join(root, authorityPath), path.join(fixture, authorityPath))
  await cp(path.join(root, 'gravity-mvp/prisma/migrations', coTamperedRow.name, 'migration.sql'), coTamperedPath)

  const substitutedProof = JSON.parse(await readFile(path.join(fixture, authorityPath), 'utf8'))
  const outbox = substitutedProof.migrations.find((row) => row.name === substitutedProof.current_target.name)
  outbox.live_ledger.proof.kind = 'exact_finite_predecessor_runtime_inventory'
  await writeFile(path.join(fixture, authorityPath), `${JSON.stringify(substitutedProof, null, 2)}\n`)
  await assert.rejects(() => validateProductionMigrationAuthority(fixture), /outbox live migration ledger provenance mismatch/)
  await cp(path.join(root, authorityPath), path.join(fixture, authorityPath))

  const fakeProvenance = JSON.parse(await readFile(path.join(fixture, authorityPath), 'utf8'))
  fakeProvenance.migrations[0].provenance = { kind: 'made_up_but_bytes_unchanged' }
  await writeFile(path.join(fixture, authorityPath), `${JSON.stringify(fakeProvenance, null, 2)}\n`)
  await assert.rejects(() => validateProductionMigrationAuthority(fixture), /migration provenance mismatch: 0_init/)
  await cp(path.join(root, authorityPath), path.join(fixture, authorityPath))

  const embellishedProvenance = JSON.parse(await readFile(path.join(fixture, authorityPath), 'utf8'))
  embellishedProvenance.migrations[0].provenance.unverified_claim = 'accepted'
  await writeFile(path.join(fixture, authorityPath), `${JSON.stringify(embellishedProvenance, null, 2)}\n`)
  await assert.rejects(() => validateProductionMigrationAuthority(fixture), /migration provenance mismatch: 0_init/)
  await cp(path.join(root, authorityPath), path.join(fixture, authorityPath))

  const movingRefOnly = JSON.parse(await readFile(path.join(fixture, authorityPath), 'utf8'))
  const fetched = movingRefOnly.migrations.find((row) => row.provenance.kind === 'fetched_ref')
  delete fetched.provenance.resolved_commit
  await writeFile(path.join(fixture, authorityPath), `${JSON.stringify(movingRefOnly, null, 2)}\n`)
  await assert.rejects(() => validateProductionMigrationAuthority(fixture), new RegExp(`migration provenance mismatch: ${fetched.name}`))
  await cp(path.join(root, authorityPath), path.join(fixture, authorityPath))

  // SQL captures remain byte-for-byte correct in these cases.  The raw object
  // verifier must independently reject forged blob, tree, commit, ref and path
  // lineage even when invoked below the evidence-file checksum pin.
  const gitEvidencePath = authority.provenance_evidence.git_object_lineage.path
  const gitEvidence = JSON.parse(await readFile(path.join(fixture, gitEvidencePath), 'utf8'))
  const mutatedGitEvidenceBytes = (mutate) => {
    const copy = structuredClone(gitEvidence)
    mutate(copy)
    return Buffer.from(`${JSON.stringify(copy, null, 2)}\n`)
  }
  const mutatePayloadByte = (record) => {
    const payload = Buffer.from(record.payload_base64, 'base64')
    payload[payload.length - 1] ^= 0x01
    record.payload_base64 = payload.toString('base64')
  }
  const fetchedClaim = gitEvidence.claims.find((claim) => claim.provenance_kind === 'fetched_ref')
  const fetchedCommit = gitEvidence.objects.find((record) => record.oid === fetchedClaim.anchor.resolved_commit)
  const fetchedCommitTree = /^tree ([0-9a-f]{40})$/mu.exec(Buffer.from(fetchedCommit.payload_base64, 'base64').toString('utf8'))[1]

  await assert.rejects(
    () => verifyGitObjectLineageBytes(fixture, authority, mutatedGitEvidenceBytes((copy) => {
      mutatePayloadByte(copy.objects.find((record) => record.oid === fetchedClaim.blob))
    })),
    /Git object canonical SHA-1 mismatch/,
  )
  await assert.rejects(
    () => verifyGitObjectLineageBytes(fixture, authority, mutatedGitEvidenceBytes((copy) => {
      mutatePayloadByte(copy.objects.find((record) => record.oid === fetchedCommitTree))
    })),
    /Git object canonical SHA-1 mismatch/,
  )
  await assert.rejects(
    () => verifyGitObjectLineageBytes(fixture, authority, mutatedGitEvidenceBytes((copy) => {
      mutatePayloadByte(copy.objects.find((record) => record.oid === fetchedClaim.anchor.resolved_commit))
    })),
    /Git object canonical SHA-1 mismatch/,
  )
  await assert.rejects(
    () => verifyGitObjectLineageBytes(fixture, authority, mutatedGitEvidenceBytes((copy) => {
      const forgedRef = Buffer.from(`${fetchedClaim.anchor.resolved_commit} refs/remotes/origin/forged\n`, 'ascii')
      copy.ref_snapshot.payload_base64 = forgedRef.toString('base64')
      copy.ref_snapshot.size = forgedRef.length
      copy.ref_snapshot.sha256 = createHash('sha256').update(forgedRef).digest('hex')
    })),
    /Git ref snapshot does not bind the pinned ref to the pinned commit/,
  )
  await assert.rejects(
    () => verifyGitObjectLineageBytes(fixture, authority, mutatedGitEvidenceBytes((copy) => {
      copy.claims.find((claim) => claim.migration_name === fetchedClaim.migration_name).path = 'gravity-mvp/prisma/migrations/forged/migration.sql'
    })),
    /Git object lineage claims mismatch/,
  )

  const rootBrokerDescriptor = authority.provenance_evidence.root_broker_package
  const rootBrokerRoot = path.join(fixture, rootBrokerDescriptor.root)
  const rawGitStatePath = path.join(fixture, rootBrokerDescriptor.raw_git_state_path)
  const rawGitStateBytes = await readFile(rawGitStatePath)
  const rootBrokerManifestPath = path.join(fixture, rootBrokerDescriptor.manifest_path)
  const rootBrokerManifestBytes = await readFile(rootBrokerManifestPath)
  const rootBrokerChecksumsPath = path.join(fixture, rootBrokerDescriptor.checksums_path)
  const rootBrokerChecksumsBytes = await readFile(rootBrokerChecksumsPath)

  const forgedRaw = JSON.parse(rawGitStateBytes)
  forgedRaw.untracked.find((record) => record.path === ROOT_BROKER_MIGRATIONS[0].path).working_blob = '0'.repeat(40)
  await writeFile(rawGitStatePath, `${JSON.stringify(forgedRaw, null, 2)}\n`)
  await assert.rejects(
    () => verifyRootBrokerPackage(fixture, authority),
    /root-broker package member checksum mismatch: production-git-index\/raw\/production-git-state\.raw\.json/,
  )
  await writeFile(rawGitStatePath, rawGitStateBytes)

  const forgedManifest = JSON.parse(rootBrokerManifestBytes)
  forgedManifest.host = 'forged-host'
  await writeFile(rootBrokerManifestPath, `${JSON.stringify(forgedManifest, null, 2)}\n`)
  await assert.rejects(() => verifyRootBrokerPackage(fixture, authority), /root-broker manifest checksum\/size mismatch/)
  await writeFile(rootBrokerManifestPath, rootBrokerManifestBytes)

  const forgedChecksums = Buffer.from(rootBrokerChecksumsBytes)
  forgedChecksums[0] = forgedChecksums[0] === 0x30 ? 0x31 : 0x30
  await writeFile(rootBrokerChecksumsPath, forgedChecksums)
  await assert.rejects(() => verifyRootBrokerPackage(fixture, authority), /root-broker SHA256SUMS checksum\/size mismatch/)
  await writeFile(rootBrokerChecksumsPath, rootBrokerChecksumsBytes)

  const extraRootBrokerMember = path.join(rootBrokerRoot, 'unlisted-evidence.txt')
  await writeFile(extraRootBrokerMember, 'unlisted package member\n')
  await assert.rejects(() => verifyRootBrokerPackage(fixture, authority), /root-broker evidence package file count mismatch/)
  await rm(extraRootBrokerMember)

  const symlinkRootBrokerMember = path.join(rootBrokerRoot, 'unlisted-evidence-link')
  await symlink('/etc/passwd', symlinkRootBrokerMember)
  await assert.rejects(() => verifyRootBrokerPackage(fixture, authority), /symlink is forbidden/)
  await rm(symlinkRootBrokerMember)

  const traversalDescriptor = structuredClone(rootBrokerDescriptor)
  traversalDescriptor.raw_git_state_path = `${rootBrokerDescriptor.root}/../production-git-state.raw.json`
  await assert.rejects(() => verifyRootBrokerPackage(fixture, authority, traversalDescriptor), /escapes or misnames/)

  const rootTraversalDescriptor = structuredClone(rootBrokerDescriptor)
  rootTraversalDescriptor.root = `${rootBrokerDescriptor.root}/../20260808T122923Z`
  await assert.rejects(() => verifyRootBrokerPackage(fixture, authority, rootTraversalDescriptor), /root-broker evidence package root is unsafe/)

  const patchTraversalDescriptor = structuredClone(rootBrokerDescriptor)
  patchTraversalDescriptor.patch_root = `${rootBrokerDescriptor.patch_root}/../patches`
  await assert.rejects(() => verifyRootBrokerPackage(fixture, authority, patchTraversalDescriptor), /root-broker supporting patch root is unsafe/)

  const unanchoredAuthority = structuredClone(authority)
  const unanchoredRow = unanchoredAuthority.migrations.find((row) => row.name === ROOT_BROKER_MIGRATIONS[0].migration_name)
  unanchoredRow.provenance = {
    kind: 'recovered_git_blob',
    git_blob: ROOT_BROKER_MIGRATIONS[0].working_blob,
    reachable_snapshot_tree: '9c4d4291c5d530d2ef1238bffd9b5d2737e9b13f',
    snapshot_path: ROOT_BROKER_MIGRATIONS[0].path,
    repository_capture: unanchoredRow.provenance.repository_capture,
  }
  await assert.rejects(() => verifyRootBrokerPackage(fixture, unanchoredAuthority), /root-broker migration authority relationship mismatch/)

  const firstPatch = ROOT_BROKER_MIGRATIONS[0].patch
  const firstPatchBytes = await readFile(path.join(fixture, firstPatch.path))
  const firstCanonical = await readFile(path.join(fixture, authority.migrations.find((row) => row.name === ROOT_BROKER_MIGRATIONS[0].migration_name).provenance.repository_capture))
  assert((extractNewFilePatch(firstPatchBytes, ROOT_BROKER_MIGRATIONS[0].path)).equals(firstCanonical))
  const forgedPatchBytes = Buffer.from(firstPatchBytes)
  const targetHeaderOffset = forgedPatchBytes.indexOf(Buffer.from(`+++ b/${ROOT_BROKER_MIGRATIONS[0].path}\n`))
  const hunkOffset = forgedPatchBytes.indexOf(Buffer.from('CREATE'), targetHeaderOffset)
  assert(hunkOffset > 0)
  forgedPatchBytes[hunkOffset] = 0x58
  assert(!extractNewFilePatch(forgedPatchBytes, ROOT_BROKER_MIGRATIONS[0].path).equals(firstCanonical), 'forged supporting patch hunk must not equal canonical SQL')
  const firstPatchPath = path.join(fixture, firstPatch.path)
  await writeFile(firstPatchPath, forgedPatchBytes)
  await assert.rejects(() => verifyRootBrokerPackage(fixture, authority), /root-broker supporting patch checksum\/size mismatch/)
  await writeFile(firstPatchPath, firstPatchBytes)
  const extraPatch = path.join(fixture, rootBrokerDescriptor.patch_root, 'forged-extra.patch')
  await writeFile(extraPatch, '--- /dev/null\n+++ b/forged\n')
  await assert.rejects(() => verifyRootBrokerPackage(fixture, authority), /root-broker supporting patch file set mismatch/)
  await rm(extraPatch)

  const patchRoot = path.join(fixture, rootBrokerDescriptor.patch_root)
  const externalPatchFixture = await mkdtemp(path.join(os.tmpdir(), 'yoko-migration-external-patches-'))
  externalCustodyFixtures.push(externalPatchFixture)
  const externalPatchRoot = path.join(externalPatchFixture, 'patches')
  await cp(patchRoot, externalPatchRoot, { recursive: true })
  await rm(patchRoot, { recursive: true })
  await symlink(externalPatchRoot, patchRoot, 'dir')
  await assert.rejects(
    () => validateProductionMigrationAuthority(fixture),
    /root-broker supporting patch directory component is not a real directory: architecture\/migrations\/v1\/provenance\/root-broker\/patches/,
  )
  await rm(patchRoot)
  await cp(externalPatchRoot, patchRoot, { recursive: true })

  const rootBrokerAncestorRelative = path.dirname(rootBrokerDescriptor.root)
  const rootBrokerAncestor = path.join(fixture, rootBrokerAncestorRelative)
  const externalRootBrokerFixture = await mkdtemp(path.join(os.tmpdir(), 'yoko-migration-external-root-broker-'))
  externalCustodyFixtures.push(externalRootBrokerFixture)
  const externalRootBroker = path.join(externalRootBrokerFixture, 'root-broker')
  await cp(rootBrokerAncestor, externalRootBroker, { recursive: true })
  await rm(rootBrokerAncestor, { recursive: true })
  await symlink(externalRootBroker, rootBrokerAncestor, 'dir')
  await assert.rejects(
    () => validateProductionMigrationAuthority(fixture),
    /root-broker evidence package directory component is not a real directory: architecture\/migrations\/v1\/provenance\/root-broker/,
  )
  await rm(rootBrokerAncestor)
  await cp(externalRootBroker, rootBrokerAncestor, { recursive: true })

  const snapshotRow = authority.migrations.find((row) => row.provenance.kind === 'evidence_snapshot')
  assert(snapshotRow.provenance.repository_capture.startsWith('architecture/'), 'evidence snapshot requires a clean-checkout capture')
  assert.equal((await validateProductionMigrationAuthority(fixture)).total, 62)

  const snapshotDescriptor = authority.provenance_evidence.snapshot_package
  const snapshotManifest = path.join(fixture, snapshotDescriptor.manifest_path)
  const snapshotManifestBytes = await readFile(snapshotManifest)
  const tamperedManifest = Buffer.from(snapshotManifestBytes)
  tamperedManifest[tamperedManifest.indexOf(Buffer.from(snapshotDescriptor.snapshot_id))] ^= 0x01
  await writeFile(snapshotManifest, tamperedManifest)
  await assert.rejects(
    () => validateProductionMigrationAuthority(fixture),
    /snapshot package member checksum\/size mismatch: manifest\.json|snapshot package manifest checksum\/size mismatch/,
  )
  await writeFile(snapshotManifest, snapshotManifestBytes)

  const snapshotLedger = path.join(fixture, snapshotDescriptor.ledger_path)
  const snapshotLedgerBytes = await readFile(snapshotLedger)
  const tamperedLedger = Buffer.from(snapshotLedgerBytes)
  tamperedLedger[0] = tamperedLedger[0] === 0x30 ? 0x31 : 0x30
  await writeFile(snapshotLedger, tamperedLedger)
  await assert.rejects(() => validateProductionMigrationAuthority(fixture), /snapshot package ledger checksum\/size mismatch/)
  await writeFile(snapshotLedger, snapshotLedgerBytes)

  const extraSnapshotMember = path.join(fixture, snapshotDescriptor.root, 'unlisted-evidence.txt')
  await writeFile(extraSnapshotMember, 'unlisted package member\n')
  await assert.rejects(() => validateProductionMigrationAuthority(fixture), /snapshot package file count mismatch/)
  await rm(extraSnapshotMember)

  const schemaCapture = path.join(fixture, 'architecture/migrations/v1/provenance/schema/starting-c6f352a.prisma.gz.b64')
  const schemaCaptureBytes = await readFile(schemaCapture)
  await writeFile(schemaCapture, Buffer.concat([schemaCaptureBytes, Buffer.from('A')]))
  await assert.rejects(() => validateProductionMigrationAuthority(fixture), /schema starting capture checksum\/size mismatch/)
  await writeFile(schemaCapture, schemaCaptureBytes)

  await writeFile(path.join(fixture, 'gravity-mvp/prisma/schema.prisma'), '// schema drift\n')
  await assert.rejects(() => validateProductionMigrationAuthority(fixture), /pending source schema checksum\/size mismatch/)
  await cp(path.join(root, 'gravity-mvp/prisma/schema.prisma'), path.join(fixture, 'gravity-mvp/prisma/schema.prisma'))

  // Rewriting an archived migration and every self-authored checksum is still
  // rejected by the independently captured raw predecessor runtime bytes.
  const coordinatedArchive = JSON.parse(await readFile(path.join(fixture, authorityPath), 'utf8'))
  const coordinatedRow = coordinatedArchive.migrations.find((row) => row.provenance.kind === 'fetched_ref')
  assert(coordinatedRow, 'fixture must include fetched-ref provenance')
  const coordinatedPath = path.join(fixture, 'architecture/migrations/v1/archive/pre-outbox', coordinatedRow.name, 'migration.sql')
  const coordinatedSql = '-- coordinated archive and authority rewrite\n'
  coordinatedRow.sha256 = createHash('sha256').update(coordinatedSql).digest('hex')
  coordinatedRow.size = Buffer.byteLength(coordinatedSql)
  coordinatedArchive.inventory_digest = canonicalInventoryDigest(coordinatedArchive.migrations)
  await writeFile(coordinatedPath, coordinatedSql)
  await writeFile(path.join(fixture, authorityPath), `${JSON.stringify(coordinatedArchive, null, 2)}\n`)
  await assert.rejects(
    () => validateProductionMigrationAuthority(fixture),
    /preserved Git blob differs from repository capture|raw predecessor evidence inventory checksum\/name\/size mismatch|authority predecessor inventory checksum\/name\/size mismatch/,
  )
  await cp(path.join(root, authorityPath), path.join(fixture, authorityPath))
  await cp(path.join(root, 'architecture/migrations/v1/archive/pre-outbox', coordinatedRow.name, 'migration.sql'), coordinatedPath)

  const duplicate = '20260728213000_add_max_account_session_owner'
  const duplicateActive = path.join(fixture, 'gravity-mvp/prisma/migrations', duplicate, 'migration.sql')
  await mkdir(path.dirname(duplicateActive), { recursive: true })
  await cp(path.join(root, 'architecture/migrations/v1/archive/pre-outbox', duplicate, 'migration.sql'), duplicateActive)
  await assert.rejects(() => validateProductionMigrationAuthority(fixture), /unrecognized active variant: 20260728213000_add_max_account_session_owner/)
} finally {
  await rm(fixture, { recursive: true, force: true })
  for (const externalFixture of externalCustodyFixtures) await rm(externalFixture, { recursive: true, force: true })
}
process.stdout.write('production migration authority: PASS\n')
