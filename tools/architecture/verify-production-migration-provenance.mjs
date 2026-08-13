import { createHash } from 'node:crypto'
import { lstat, readFile, readdir } from 'node:fs/promises'
import path from 'node:path'

const SHA1 = /^[0-9a-f]{40}$/u
const SHA256 = /^[0-9a-f]{64}$/u
const utf8 = new TextDecoder('utf-8', { fatal: true })

export const PROVENANCE_EVIDENCE_AUTHORITY = {
  git_object_lineage: {
    schema: 'yoko.crm.production-migration-git-object-lineage.v1',
    path: 'architecture/migrations/v1/provenance/git/production-migration-lineage-v1.json',
    sha256: 'b18df326af497a449d90465c44c17c097c5244d80b8d01e078465fa89086e699',
    size: 316756,
    object_count: 125,
    claim_count: 14,
  },
  snapshot_package: {
    schema: 'crm-arch-000r-production-only-evidence-v1',
    root: 'architecture/migrations/v1/provenance/snapshot/20260808T070726Z',
    snapshot_id: '20260808T070726Z',
    package_digest_algorithm: 'crm-arch-000r-package-digest-v1',
    package_sha256: 'ba987cb23ebf6be8111b59f423ca6d2aadd6b508e82281365c60a870f1bc0a3c',
    ledger_path: 'architecture/migrations/v1/provenance/snapshot/20260808T070726Z/PACKAGE_CONTENTS.tsv',
    ledger_sha256: 'ba987cb23ebf6be8111b59f423ca6d2aadd6b508e82281365c60a870f1bc0a3c',
    ledger_size: 3448,
    digest_path: 'architecture/migrations/v1/provenance/snapshot/20260808T070726Z/PACKAGE_SHA256',
    digest_sha256: '2973052a3179d3d44161e98848bc55ebce192795a67e63f13c4733b95aa2f4f9',
    digest_size: 87,
    manifest_path: 'architecture/migrations/v1/provenance/snapshot/20260808T070726Z/manifest.json',
    manifest_sha256: 'b42c1e3bae282422694edcedbd5fe47dba529d0a5f86e8fc2df938510059cee4',
    manifest_size: 28060,
    ledger_members: 30,
    package_files: 32,
  },
  root_broker_package: {
    schema: 'CRM-ARCH-000R-EVIDENCE-MANIFEST-1',
    root: 'architecture/migrations/v1/provenance/root-broker/20260808T122923Z',
    original_evidence_root: '/opt/codex-work/crm-arch-000-evidence/crm-arch-000r/20260808T122923Z',
    manifest_path: 'architecture/migrations/v1/provenance/root-broker/20260808T122923Z/MANIFEST.json',
    manifest_sha256: 'd05ccb1d63315c2a24c8627e718d724961014e2f8b93959445d25d9ed84b1c7f',
    manifest_size: 1487,
    checksums_path: 'architecture/migrations/v1/provenance/root-broker/20260808T122923Z/SHA256SUMS',
    checksums_sha256: '09366be1d2b0a7b85e39336745c2b311ef60836e97adc172548fae3df550a355',
    checksums_size: 3791,
    checksummed_members: 35,
    package_files: 37,
    raw_git_state_path: 'architecture/migrations/v1/provenance/root-broker/20260808T122923Z/production-git-index/raw/production-git-state.raw.json',
    raw_git_state_sha256: '6318696f1d66d7bb7451d3a097b20846ace850fd954d1737905aeb33d4ce8f13',
    raw_git_state_size: 50282,
    normalized_git_state_path: 'architecture/migrations/v1/provenance/root-broker/20260808T122923Z/production-git-index/normalized/production-git-state.normalized.json',
    normalized_git_state_sha256: '6318696f1d66d7bb7451d3a097b20846ace850fd954d1737905aeb33d4ce8f13',
    normalized_git_state_size: 50282,
    capture_path: 'architecture/migrations/v1/provenance/root-broker/20260808T122923Z/production-git-index/production-git-state.capture.json',
    capture_sha256: '159915c52e09c5c7aa419d8dcb96006544fbae97ed7b00102f1e12c968dff82d',
    capture_size: 435,
    secret_safety_report_path: 'architecture/migrations/v1/provenance/root-broker/20260808T122923Z/normalized/secret-safety-report.json',
    secret_safety_report_sha256: 'fa466d994c0ed0de63b977f02f40c5fead188610c96f1d19de532d405cfa5202',
    secret_safety_report_size: 759,
    patch_root: 'architecture/migrations/v1/provenance/root-broker/patches',
    patches: [
      {
        migration_name: '20260805073000_add_bot_user_registry',
        path: 'architecture/migrations/v1/provenance/root-broker/patches/_bot_registry_prod_20260805.patch',
        sha256: '3744122e0f505a1af24043f20c1401fd3df633ea80b08aabeb48dcfd54349f4e',
        size: 54109,
      },
      {
        migration_name: '20260805093000_prune_unverified_bot_registry_backfill',
        path: 'architecture/migrations/v1/provenance/root-broker/patches/_bot_registry_cleanup_prod_20260805.patch',
        sha256: 'ffcf6faef49247a5e7157b94860a5694b38196948a497fa4b50453bc7c979bda',
        size: 782,
      },
      {
        migration_name: '20260805110000_restore_linked_bot_registry',
        path: 'architecture/migrations/v1/provenance/root-broker/patches/_bot_profile_linked_registry_prod_20260805.patch',
        sha256: '4a86d9ca805d32fb15276a875462abc60b4b7644bf47b591fa9bdef301b2820e',
        size: 994,
      },
    ],
  },
}

const EXPECTED_REF = 'refs/remotes/origin/feature/personal-max-text-canary-autonomous-20260728T211316Z'
const EXPECTED_REF_COMMIT = '8a9e7f79d91268ee4baf11ae5c440041875de424'
const SNAPSHOT_MIGRATION = '20260717000000_add_driver_telegram_submitted_phone'
const ROOT_BROKER_TREE = '9c4d4291c5d530d2ef1238bffd9b5d2737e9b13f'

export const ROOT_BROKER_MIGRATIONS = [
  {
    migration_name: '20260805073000_add_bot_user_registry',
    mode: '0644',
    path: 'gravity-mvp/prisma/migrations/20260805073000_add_bot_user_registry/migration.sql',
    sensitive_path: false,
    sha256: 'ef2df9ac72e1cec7d9ce00cc81e5e13eaf35161d0cfd20c379e82cec24cf4b0c',
    size: 3539,
    working_blob: '32eef929cf8568809c5886f0571ac53e35dd1215',
    patch: PROVENANCE_EVIDENCE_AUTHORITY.root_broker_package.patches[0],
  },
  {
    migration_name: '20260805093000_prune_unverified_bot_registry_backfill',
    mode: '0644',
    path: 'gravity-mvp/prisma/migrations/20260805093000_prune_unverified_bot_registry_backfill/migration.sql',
    sensitive_path: false,
    sha256: '0b1bfbb272692e281bc4037c4fc8e8246e64656603fc64b53a9179d2e6731871',
    size: 409,
    working_blob: '1d587c53577347ddbb57c3b8d589f8c39465c0aa',
    patch: PROVENANCE_EVIDENCE_AUTHORITY.root_broker_package.patches[1],
  },
  {
    migration_name: '20260805110000_restore_linked_bot_registry',
    mode: '0644',
    path: 'gravity-mvp/prisma/migrations/20260805110000_restore_linked_bot_registry/migration.sql',
    sensitive_path: false,
    sha256: 'b84f066aca9a197050247d5958771c213c6d9d142bd242ba1f8769974a9bcaa4',
    size: 639,
    working_blob: '901894736817062b87b01dcdc481f35cfd10e578',
    patch: PROVENANCE_EVIDENCE_AUTHORITY.root_broker_package.patches[2],
  },
]

const EXPECTED_HISTORY_CLAIMS = [
  {
    migration_name: '20260728213000_add_max_account_session_owner',
    kind: 'introduced_by',
    commit: 'b562dea608942c47c2b0ade6f87fed77a10b54a0',
    parent: 'd060c74a9faa395f044132a373c5204b052b6444',
    descendant_ref_commit: EXPECTED_REF_COMMIT,
    path: 'gravity-mvp/prisma/migrations/20260728213000_add_max_account_session_owner/migration.sql',
    blob: '4af909fcb389e19ff1c8ea3cf243f0bf2d04207a',
  },
  {
    migration_name: '20260728214000_add_max_outbound_shadow_plan',
    kind: 'introduced_by',
    commit: 'efbdcd893b222ed5e2e4246d2b8e01cb3b094056',
    parent: 'b562dea608942c47c2b0ade6f87fed77a10b54a0',
    descendant_ref_commit: EXPECTED_REF_COMMIT,
    path: 'gravity-mvp/prisma/migrations/20260728214000_add_max_outbound_shadow_plan/migration.sql',
    blob: '7a2f83640b895e2393e3d55e8d7c91331ccb2abc',
  },
  {
    migration_name: '20260728214000_add_max_outbound_shadow_plan',
    kind: 'later_present_at',
    commit: 'dfce596b2f69e9a9004ae04cc550bf26be90a35c',
    descendant_ref_commit: EXPECTED_REF_COMMIT,
    path: 'gravity-mvp/prisma/migrations/20260728214000_add_max_outbound_shadow_plan/migration.sql',
    blob: 'fc6eb6211f812ecadb11d83ff9872cfea1e09c98',
  },
]

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const gitOid = (type, bytes) => createHash('sha1')
  .update(Buffer.from(`${type} ${bytes.length}\0`, 'ascii'))
  .update(bytes)
  .digest('hex')

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const stable = (value) => {
  if (Array.isArray(value)) return value.map(stable)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]))
}
const exactObject = (value, expected) => JSON.stringify(stable(value)) === JSON.stringify(stable(expected))

function assertKeys(value, keys, label) {
  assert(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`)
  assert(exactObject(Object.keys(value).sort(), [...keys].sort()), `${label} has unexpected fields`)
}

function decodeBase64(value, label) {
  assert(typeof value === 'string' && value.length > 0 && value.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/u.test(value), `${label} is not canonical base64`)
  const bytes = Buffer.from(value, 'base64')
  assert(bytes.toString('base64') === value, `${label} is not canonical base64`)
  return bytes
}

function decodeUtf8(bytes, label) {
  try {
    return utf8.decode(bytes)
  } catch (error) {
    throw new Error(`${label} is not canonical UTF-8`, { cause: error })
  }
}

function parseCommit(bytes, oid) {
  const separator = bytes.indexOf(Buffer.from('\n\n'))
  assert(separator > 0, `Git commit ${oid} has no header terminator`)
  const lines = decodeUtf8(bytes.subarray(0, separator), `Git commit ${oid} header`).split('\n')
  const trees = lines.filter((line) => line.startsWith('tree '))
  assert(trees.length === 1 && /^tree [0-9a-f]{40}$/u.test(trees[0]), `Git commit ${oid} has an invalid tree header`)
  assert(lines[0] === trees[0], `Git commit ${oid} tree is not its first header`)
  const parents = lines.filter((line) => line.startsWith('parent '))
  assert(parents.every((line) => /^parent [0-9a-f]{40}$/u.test(line)), `Git commit ${oid} has an invalid parent header`)
  return { tree: trees[0].slice(5), parents: parents.map((line) => line.slice(7)) }
}

function parseTree(bytes, oid) {
  const entries = []
  const names = new Set()
  let offset = 0
  while (offset < bytes.length) {
    const space = bytes.indexOf(0x20, offset)
    const nul = bytes.indexOf(0x00, space + 1)
    assert(space > offset && nul > space && nul + 21 <= bytes.length, `Git tree ${oid} is malformed`)
    const mode = bytes.subarray(offset, space).toString('ascii')
    const name = decodeUtf8(bytes.subarray(space + 1, nul), `Git tree ${oid} entry name`)
    const child = bytes.subarray(nul + 1, nul + 21).toString('hex')
    assert(/^(100644|100755|120000|160000|40000)$/u.test(mode), `Git tree ${oid} has invalid mode`)
    assert(name && name !== '.' && name !== '..' && !name.includes('/'), `Git tree ${oid} has unsafe entry name`)
    assert(!names.has(name), `Git tree ${oid} has duplicate entry name`)
    names.add(name)
    entries.push({ mode, name, oid: child })
    offset = nul + 21
  }
  assert(offset === bytes.length, `Git tree ${oid} has trailing bytes`)
  return entries
}

function expectedGitClaims(authority) {
  return authority.migrations.flatMap((row) => {
    if (row.provenance.kind === 'fetched_ref') return [{
      migration_name: row.name,
      provenance_kind: row.provenance.kind,
      anchor: { kind: 'ref', ref: row.provenance.ref, resolved_commit: row.provenance.resolved_commit },
      path: row.provenance.source_path,
      blob: row.provenance.source_blob,
    }]
    if (row.provenance.kind === 'root_broker_untracked_capture') return []
    if (row.provenance.kind === 'git_commit') return [{
      migration_name: row.name,
      provenance_kind: row.provenance.kind,
      anchor: { kind: 'commit', commit: row.provenance.commit },
      path: row.provenance.source_path,
      blob: row.provenance.source_blob,
    }]
    return []
  }).sort((left, right) => left.migration_name.localeCompare(right.migration_name))
}

export async function verifyGitObjectLineageBytes(root, authority, evidenceBytes) {
  let evidence
  try {
    evidence = JSON.parse(decodeUtf8(evidenceBytes, 'Git object lineage evidence'))
  } catch (error) {
    if (error?.message?.includes('canonical UTF-8')) throw error
    throw new Error('Git object lineage evidence is not valid JSON', { cause: error })
  }
  assertKeys(evidence, ['schema', 'version', 'object_format', 'ref_snapshot', 'claims', 'history_claims', 'objects'], 'Git object lineage evidence')
  assert(evidence.schema === 'yoko.crm.production-migration-git-object-lineage.v1' && evidence.version === 1, 'Git object lineage evidence identity mismatch')
  assert(exactObject(evidence.object_format, {
    object_id: 'sha1(type + SP + decimal-size + NUL + raw-payload)',
    payload_encoding: 'base64',
    tree_entry_format: 'mode SP name NUL 20-byte-object-id',
  }), 'Git object lineage encoding mismatch')
  assert(Array.isArray(evidence.objects) && evidence.objects.length === PROVENANCE_EVIDENCE_AUTHORITY.git_object_lineage.object_count, 'Git object lineage object count mismatch')
  const objects = new Map()
  for (const record of evidence.objects) {
    assertKeys(record, ['oid', 'type', 'size', 'payload_base64'], 'Git object evidence record')
    assert(SHA1.test(record.oid) && ['blob', 'tree', 'commit'].includes(record.type), `Git object evidence identity is invalid: ${record.oid}`)
    assert(Number.isInteger(record.size) && record.size >= 0, `Git object evidence size is invalid: ${record.oid}`)
    assert(!objects.has(record.oid), `duplicate Git object evidence: ${record.oid}`)
    const bytes = decodeBase64(record.payload_base64, `Git object ${record.oid} payload`)
    assert(bytes.length === record.size, `Git object size mismatch: ${record.oid}`)
    assert(gitOid(record.type, bytes) === record.oid, `Git object canonical SHA-1 mismatch: ${record.oid}`)
    objects.set(record.oid, { type: record.type, bytes })
  }

  const used = new Set()
  const object = (oid, type) => {
    assert(SHA1.test(oid), `invalid referenced Git object id: ${oid}`)
    const record = objects.get(oid)
    assert(record, `referenced Git object is not preserved: ${oid}`)
    assert(record.type === type, `referenced Git object type mismatch: ${oid}`)
    used.add(oid)
    return record.bytes
  }
  const commit = (oid) => parseCommit(object(oid, 'commit'), oid)
  const tree = (oid) => parseTree(object(oid, 'tree'), oid)

  const resolvePath = (rootTree, sourcePath, expectedBlob) => {
    assert(typeof sourcePath === 'string' && sourcePath.split('/').every((segment) => segment && segment !== '.' && segment !== '..'), `unsafe claimed Git path: ${sourcePath}`)
    const segments = sourcePath.split('/')
    let currentTree = rootTree
    for (let index = 0; index < segments.length; index += 1) {
      const entry = tree(currentTree).find((candidate) => candidate.name === segments[index])
      assert(entry, `claimed Git path is absent: ${sourcePath}`)
      if (index < segments.length - 1) {
        assert(entry.mode === '40000', `claimed Git path component is not a tree: ${segments[index]}`)
        currentTree = entry.oid
      } else {
        assert(entry.mode === '100644', `claimed migration Git mode is not 100644: ${sourcePath}`)
        assert(entry.oid === expectedBlob, `claimed Git path resolves to the wrong blob: ${sourcePath}`)
        return object(entry.oid, 'blob')
      }
    }
    throw new Error(`unreachable claimed Git path state: ${sourcePath}`)
  }

  const directoryAbsent = (rootTree, directoryPath) => {
    const segments = directoryPath.split('/')
    let currentTree = rootTree
    for (let index = 0; index < segments.length; index += 1) {
      const entry = tree(currentTree).find((candidate) => candidate.name === segments[index])
      if (!entry) return
      assert(index < segments.length - 1, `introduced migration directory already exists in parent: ${directoryPath}`)
      assert(entry.mode === '40000', `introduced migration parent path component is not a tree: ${segments[index]}`)
      currentTree = entry.oid
    }
    throw new Error(`unreachable introduced migration absence state: ${directoryPath}`)
  }

  const firstParentAncestor = (descendant, ancestor) => {
    let current = descendant
    for (let depth = 0; depth < 2048; depth += 1) {
      const parsed = commit(current)
      if (current === ancestor) return
      assert(parsed.parents.length > 0, `Git commit ${ancestor} is not a preserved first-parent ancestor of ${descendant}`)
      current = parsed.parents[0]
    }
    throw new Error(`preserved Git first-parent ancestry exceeded safety bound: ${descendant} -> ${ancestor}`)
  }

  assertKeys(evidence.ref_snapshot, ['format', 'sha256', 'size', 'payload_base64'], 'Git ref snapshot')
  const refBytes = decodeBase64(evidence.ref_snapshot.payload_base64, 'Git ref snapshot payload')
  assert(evidence.ref_snapshot.format === 'git-show-ref-v1'
    && evidence.ref_snapshot.sha256 === sha256(refBytes)
    && evidence.ref_snapshot.size === refBytes.length, 'Git ref snapshot checksum/size mismatch')
  const expectedRefBytes = Buffer.from(`${EXPECTED_REF_COMMIT} ${EXPECTED_REF}\n`, 'ascii')
  assert(refBytes.equals(expectedRefBytes), 'Git ref snapshot does not bind the pinned ref to the pinned commit')

  const expectedClaims = expectedGitClaims(authority)
  assert(Array.isArray(evidence.claims) && evidence.claims.length === PROVENANCE_EVIDENCE_AUTHORITY.git_object_lineage.claim_count
    && exactObject(evidence.claims, expectedClaims), 'Git object lineage claims mismatch')
  const rows = new Map(authority.migrations.map((row) => [row.name, row]))
  for (const claim of evidence.claims) {
    const row = rows.get(claim.migration_name)
    assert(row, `Git object lineage names an unknown migration: ${claim.migration_name}`)
    let rootTree
    if (claim.anchor.kind === 'ref') {
      assert(claim.anchor.ref === EXPECTED_REF && claim.anchor.resolved_commit === EXPECTED_REF_COMMIT, `Git claim ref anchor mismatch: ${claim.migration_name}`)
      rootTree = commit(claim.anchor.resolved_commit).tree
    } else if (claim.anchor.kind === 'commit') {
      rootTree = commit(claim.anchor.commit).tree
    } else {
      assert(claim.anchor.kind === 'root_tree', `unsupported Git claim anchor: ${claim.migration_name}`)
      assert(claim.provenance_kind === 'supplemental_unanchored_root_tree'
        && row.provenance.kind === 'root_broker_untracked_capture'
        && row.provenance.supplemental_root_tree?.authority === 'SUPPLEMENTAL_NON_AUTHORIZING', `unanchored root tree cannot authorize migration provenance: ${claim.migration_name}`)
      rootTree = claim.anchor.tree
    }
    const blob = resolvePath(rootTree, claim.path, claim.blob)
    const capture = await readFile(path.join(root, row.provenance.repository_capture))
    assert(blob.equals(capture), `preserved Git blob differs from repository capture: ${claim.migration_name}`)
    assert(blob.length === row.size && sha256(blob) === row.sha256, `preserved Git blob checksum/size mismatch: ${claim.migration_name}`)
  }

  assert(Array.isArray(evidence.history_claims) && exactObject(evidence.history_claims, EXPECTED_HISTORY_CLAIMS), 'Git history lineage claims mismatch')
  for (const claim of evidence.history_claims) {
    firstParentAncestor(claim.descendant_ref_commit, claim.commit)
    const parsed = commit(claim.commit)
    resolvePath(parsed.tree, claim.path, claim.blob)
    if (claim.kind === 'introduced_by') {
      assert(parsed.parents[0] === claim.parent, `introduced-by Git parent mismatch: ${claim.migration_name}`)
      directoryAbsent(commit(claim.parent).tree, claim.path.slice(0, -'/migration.sql'.length))
    } else {
      assert(claim.kind === 'later_present_at', `unsupported Git history claim: ${claim.migration_name}`)
    }
  }
  assert(used.size === objects.size && [...objects.keys()].every((oid) => used.has(oid)), 'Git object evidence contains unreferenced objects')
  return { objects: objects.size, claims: evidence.claims.length, historyClaims: evidence.history_claims.length }
}

async function packageFileNames(directory, prefix = '') {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name
    const absolute = path.join(directory, entry.name)
    const metadata = await lstat(absolute)
    assert(!metadata.isSymbolicLink(), `snapshot package symlink is forbidden: ${relative}`)
    if (metadata.isDirectory()) files.push(...await packageFileNames(absolute, relative))
    else {
      assert(metadata.isFile(), `snapshot package special file is forbidden: ${relative}`)
      files.push(relative)
    }
  }
  return files
}

function safePackagePath(relative) {
  return typeof relative === 'string'
    && relative.length > 0
    && !relative.startsWith('/')
    && !relative.includes('\\')
    && !relative.includes('\0')
    && relative.split('/').every((segment) => segment && segment !== '.' && segment !== '..')
}

async function assertRealDirectoryPath(root, relative, label) {
  assert(safePackagePath(relative), `${label} path is unsafe`)
  const rootMetadata = await lstat(root).catch((error) => {
    throw new Error(`${label} checkout root is missing`, { cause: error })
  })
  assert(rootMetadata.isDirectory() && !rootMetadata.isSymbolicLink(), `${label} checkout root is not a real directory`)

  let current = root
  let traversed = ''
  for (const segment of relative.split('/')) {
    traversed = traversed ? `${traversed}/${segment}` : segment
    current = path.join(current, segment)
    const metadata = await lstat(current).catch((error) => {
      throw new Error(`${label} directory component is missing: ${traversed}`, { cause: error })
    })
    assert(metadata.isDirectory() && !metadata.isSymbolicLink(), `${label} directory component is not a real directory: ${traversed}`)
  }
  return current
}

export function parseRootBrokerChecksums(bytes) {
  const text = decodeUtf8(bytes, 'root-broker SHA256SUMS')
  assert(text.endsWith('\n') && !text.endsWith('\n\n'), 'root-broker SHA256SUMS must have one trailing LF')
  const rows = text.slice(0, -1).split('\n').map((line) => {
    const match = /^([0-9a-f]{64})  (.+)$/u.exec(line)
    assert(match && safePackagePath(match[2]), 'root-broker SHA256SUMS row is malformed or unsafe')
    return { sha256: match[1], path: match[2] }
  })
  assert(rows.length === 35, 'root-broker SHA256SUMS denominator mismatch')
  assert(rows.every((row, index) => index === 0 || rows[index - 1].path < row.path), 'root-broker SHA256SUMS is not uniquely path-sorted')
  return rows
}

function parseExactJson(bytes, label) {
  try {
    return JSON.parse(decodeUtf8(bytes, label))
  } catch (error) {
    if (error?.message?.includes('canonical UTF-8')) throw error
    throw new Error(`${label} is not valid JSON`, { cause: error })
  }
}

function assertSecretSafeJson(value, label, trail = []) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertSecretSafeJson(entry, label, [...trail, String(index)]))
    return
  }
  if (!value || typeof value !== 'object') return
  for (const [key, entry] of Object.entries(value)) {
    if (/^(password|passwd|secret|token|api_?key|authorization|cookie|session|dsn|database_?url|private_?key)$/iu.test(key)) {
      assert(entry === null || entry === false || entry === '' || entry === 'REDACTED' || entry === '[REDACTED]', `${label} contains a prohibited sensitive JSON scalar: ${[...trail, key].join('.')}`)
    }
    assertSecretSafeJson(entry, label, [...trail, key])
  }
}

function assertSecretSafeBytes(bytes, label, parseJson = false) {
  const text = decodeUtf8(bytes, label)
  for (const [name, pattern] of [
    ['private-key marker', /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/u],
    ['AWS access key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/u],
    ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{20,}\b/u],
    ['Slack token', /\bxox(?:a|b|p|r|s)-[A-Za-z0-9-]{20,}\b/u],
    ['OpenAI key', /\bsk-[A-Za-z0-9_-]{20,}\b/u],
    ['Telegram bot token', /\b[0-9]{8,12}:[A-Za-z0-9_-]{25,}\b/u],
    ['JWT', /\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\b/u],
    ['Docker auth value', /"auth"\s*:\s*"[A-Za-z0-9+/=]{8,}"/u],
  ]) assert(!pattern.test(text), `${label} contains a prohibited ${name}`)
  const credentialedUrl = /(?:https?|postgres(?:ql)?|mysql|redis|amqps?|mongodb(?:\+srv)?):\/\/([^\s/:@]+):([^\s/@]+)@/gu
  for (const match of text.matchAll(credentialedUrl)) {
    const environmentReference = /^\$\{[A-Z][A-Z0-9_]{1,63}\}$/u
    assert(environmentReference.test(match[1]) && environmentReference.test(match[2]), `${label} contains a credentialed URL value`)
  }
  if (parseJson) assertSecretSafeJson(parseExactJson(bytes, label), label)
}

export function extractNewFilePatch(patchBytes, targetPath) {
  assert(safePackagePath(targetPath), 'supporting patch target path is unsafe')
  const text = decodeUtf8(patchBytes, 'supporting patch')
  assert(!text.includes('\r'), 'supporting patch is not canonical LF text')
  const lines = text.split('\n')
  const targetHeader = `+++ b/${targetPath}`
  const matches = lines.flatMap((line, index) => line === targetHeader ? [index] : [])
  assert(matches.length === 1, `supporting patch must contain exactly one new-file target: ${targetPath}`)
  const header = matches[0]
  assert(lines[header - 1] === '--- /dev/null', `supporting patch target is not a new file: ${targetPath}`)
  const hunk = /^@@ -0,0 \+1,([1-9][0-9]*) @@(?: .*)?$/u.exec(lines[header + 1])
  assert(hunk, `supporting patch new-file hunk header is invalid: ${targetPath}`)
  const expectedLines = Number(hunk[1])
  const output = []
  let index = header + 2
  while (index < lines.length && output.length < expectedLines) {
    assert(lines[index].startsWith('+') && !lines[index].startsWith('+++'), `supporting patch new-file hunk is not addition-only: ${targetPath}`)
    output.push(lines[index].slice(1))
    index += 1
  }
  assert(output.length === expectedLines, `supporting patch new-file hunk is truncated: ${targetPath}`)
  assert(lines[index] !== '\\ No newline at end of file', `supporting patch migration lacks final LF: ${targetPath}`)
  assert(index === lines.length - 1 || lines[index].startsWith('diff --git ') || lines[index].startsWith('--- '), `supporting patch has an unexpected second hunk for: ${targetPath}`)
  return Buffer.from(`${output.join('\n')}\n`, 'utf8')
}

export async function verifyRootBrokerPackage(root, authority, descriptor = authority.provenance_evidence?.root_broker_package) {
  assert(descriptor, 'root-broker evidence package descriptor is missing')
  assert(safePackagePath(descriptor.root), 'root-broker evidence package root is unsafe')
  assert(safePackagePath(descriptor.patch_root), 'root-broker supporting patch root is unsafe')
  const packageRoot = await assertRealDirectoryPath(root, descriptor.root, 'root-broker evidence package')
  const patchRoot = await assertRealDirectoryPath(root, descriptor.patch_root, 'root-broker supporting patch')
  const fileNames = await packageFileNames(packageRoot)
  const prefix = `${descriptor.root}/`
  for (const [field, expectedRelative] of [
    ['manifest_path', 'MANIFEST.json'],
    ['checksums_path', 'SHA256SUMS'],
    ['raw_git_state_path', 'production-git-index/raw/production-git-state.raw.json'],
    ['normalized_git_state_path', 'production-git-index/normalized/production-git-state.normalized.json'],
    ['capture_path', 'production-git-index/production-git-state.capture.json'],
    ['secret_safety_report_path', 'normalized/secret-safety-report.json'],
  ]) assert(descriptor[field] === `${prefix}${expectedRelative}`, `root-broker ${field} escapes or misnames the package root`)
  assert(fileNames.length === descriptor.package_files, 'root-broker evidence package file count mismatch')
  assert(fileNames.filter((name) => name.endsWith('.json')).length === 28, 'root-broker JSON parse denominator mismatch')
  const patchFiles = await packageFileNames(patchRoot)
  assert(exactObject(patchFiles, descriptor.patches.map((record) => path.basename(record.path)).sort()), 'root-broker supporting patch file set mismatch')
  assert(descriptor.patches.every((record) => record.path === `${descriptor.patch_root}/${path.basename(record.path)}`), 'root-broker supporting patch path escapes or misnames the patch root')

  const checksums = await readFile(path.join(root, descriptor.checksums_path))
  assert(checksums.length === descriptor.checksums_size && sha256(checksums) === descriptor.checksums_sha256, 'root-broker SHA256SUMS checksum/size mismatch')
  const checksumRows = parseRootBrokerChecksums(checksums)
  assert(checksumRows.length === descriptor.checksummed_members, 'root-broker checksummed member count mismatch')
  assert(exactObject(fileNames, [...checksumRows.map((row) => row.path), 'MANIFEST.json', 'SHA256SUMS'].sort()), 'root-broker evidence package file set mismatch')
  for (const record of checksumRows) {
    const bytes = await readFile(path.join(packageRoot, record.path))
    assert(sha256(bytes) === record.sha256, `root-broker package member checksum mismatch: ${record.path}`)
    assertSecretSafeBytes(bytes, `root-broker package member ${record.path}`, record.path.endsWith('.json'))
  }

  const manifestBytes = await readFile(path.join(root, descriptor.manifest_path))
  assert(manifestBytes.length === descriptor.manifest_size && sha256(manifestBytes) === descriptor.manifest_sha256, 'root-broker manifest checksum/size mismatch')
  assertSecretSafeBytes(manifestBytes, 'root-broker manifest', true)
  const manifest = parseExactJson(manifestBytes, 'root-broker manifest')
  assertKeys(manifest, [
    'schema', 'created_at', 'host', 'executor', 'observation_started_at', 'observation_ended_at',
    'evidence_root', 'verdict', 'final_report', 'final_report_sha256', 'checksum_file',
    'checksum_file_sha256', 'checksummed_entry_count', 'checksum_exclusions', 'checksum_policy',
    'installed_package_version', 'installed_broker_sha256', 'successor_package_path',
    'successor_package_sha256', 'successor_broker_sha256', 'successor_installed', 'secret_scan',
    'production_mutation', 'crm_arch_001_started',
  ], 'root-broker manifest')
  assert(manifest.schema === descriptor.schema
    && manifest.created_at === '2026-08-08T13:05:26Z'
    && manifest.host === 'jvxthcorvm'
    && manifest.executor === 'codexbot'
    && manifest.observation_started_at === '2026-08-08T12:29:23.745165602Z'
    && manifest.observation_ended_at === '2026-08-08T12:59:12.762814381Z'
    && manifest.evidence_root === descriptor.original_evidence_root
    && manifest.verdict === 'BLOCKED_PRIVILEGE'
    && manifest.final_report === 'reports/CRM-ARCH-000R-FINAL.md'
    && manifest.final_report_sha256 === '391fdd8ebc32757fb55168cb41d18226d2ff3143aa18265bb3cc4bdbc3e73496'
    && manifest.checksum_file === 'SHA256SUMS'
    && manifest.checksum_file_sha256 === descriptor.checksums_sha256
    && manifest.checksummed_entry_count === descriptor.checksummed_members
    && exactObject(manifest.checksum_exclusions, ['SHA256SUMS', 'MANIFEST.json'])
    && manifest.checksum_policy === 'Non-circular: every regular file present before manifest creation is checksummed except the checksum file and this manifest.'
    && manifest.installed_package_version === '1.0.2-1'
    && manifest.installed_broker_sha256 === '0a8f18bad0467056c3b7460827618b5d8df8ac8678da57040988478dba34ab18'
    && manifest.successor_package_path === '/opt/codex-work/crm-arch-000-capability-v3/dist/yoko-crm-arch-evidence_1.2.0-1_all.deb'
    && manifest.successor_package_sha256 === 'af6512b446a662734f292fda3f3f861500dd9610657bfd7f9cbfcca4551a9e47'
    && manifest.successor_broker_sha256 === '00bbd2a7fdc93a653db2f2891426d43185a33dd236b631feca83b2e2ef226306'
    && manifest.successor_installed === false
    && manifest.secret_scan === 'PASS'
    && manifest.production_mutation === false
    && manifest.crm_arch_001_started === false, 'root-broker manifest identity or safety contract mismatch')

  const rawBytes = await readFile(path.join(root, descriptor.raw_git_state_path))
  const normalizedBytes = await readFile(path.join(root, descriptor.normalized_git_state_path))
  const captureBytes = await readFile(path.join(root, descriptor.capture_path))
  const safetyBytes = await readFile(path.join(root, descriptor.secret_safety_report_path))
  for (const [bytes, size, hash, label] of [
    [rawBytes, descriptor.raw_git_state_size, descriptor.raw_git_state_sha256, 'raw production-git-state'],
    [normalizedBytes, descriptor.normalized_git_state_size, descriptor.normalized_git_state_sha256, 'normalized production-git-state'],
    [captureBytes, descriptor.capture_size, descriptor.capture_sha256, 'production-git-state capture'],
    [safetyBytes, descriptor.secret_safety_report_size, descriptor.secret_safety_report_sha256, 'secret-safety report'],
  ]) assert(bytes.length === size && sha256(bytes) === hash, `root-broker ${label} checksum/size mismatch`)
  assert(rawBytes.equals(normalizedBytes), 'root-broker normalized production-git-state differs from raw broker output')
  const raw = parseExactJson(rawBytes, 'root-broker raw production-git-state')
  const capture = parseExactJson(captureBytes, 'root-broker production-git-state capture')
  const safety = parseExactJson(safetyBytes, 'root-broker secret-safety report')
  assert(exactObject(capture, {
    command: 'sudo -n /usr/local/sbin/yoko-crm-arch-evidence production-git-state',
    started_at: '2026-08-08T12:31:38.446026389Z',
    ended_at: '2026-08-08T12:31:39.969657557Z',
    exit_status: 0,
    output_sha256: descriptor.raw_git_state_sha256,
    broker_sha256: manifest.installed_broker_sha256,
    package_version: manifest.installed_package_version,
    host: manifest.host,
  }), 'root-broker command/capture/broker identity mismatch')
  assert(exactObject(safety, {
    validated_at: '2026-08-08T13:05:26Z',
    scope: descriptor.original_evidence_root,
    regular_files_scanned: 37,
    json_files_parsed: 28,
    all_json_parsed: true,
    prohibited_json_key_matches: 0,
    private_key_marker_matches: 0,
    credentialed_url_matches: 0,
    docker_auth_shape_matches: 0,
    production_compose_content_copied: false,
    production_compose_metadata_only: true,
    free_switch_v1_component_propagated: false,
    free_switch_v1_component_quarantined: true,
    command_argument_values_emitted_by_successor: false,
    symlink_target_values_emitted_by_successor: false,
    final_report_scanned: true,
    owner_action_scanned: true,
    conclusion: 'NO SECRET VALUES DISCLOSED',
  }), 'root-broker secret-safety report identity mismatch')
  assertKeys(raw, ['schema', 'command', 'repository', 'head', 'branch', 'upstream', 'index_entry_count', 'staged_count', 'staged', 'unstaged_count', 'unstaged', 'untracked_count', 'untracked'], 'root-broker raw production-git-state')
  assert(raw.schema === 'CRM-ARCH-000R-1'
    && raw.command === 'production-git-state'
    && raw.repository === '/opt/crm'
    && raw.head === 'e6a0a833fbb756216b058bfe326f9f9c77c4cc6d'
    && raw.branch === 'feature/ai-knowledge-core'
    && raw.upstream === 'origin/feature/ai-knowledge-core'
    && raw.index_entry_count === 1513
    && raw.staged_count === 0 && Array.isArray(raw.staged) && raw.staged.length === 0
    && raw.unstaged_count === 85 && Array.isArray(raw.unstaged) && raw.unstaged.length === 85
    && raw.untracked_count === 102 && Array.isArray(raw.untracked) && raw.untracked.length === 102, 'root-broker raw repository/head/index identity mismatch')
  assert(raw.untracked.every((record, index) => index === 0 || raw.untracked[index - 1].path < record.path)
    && new Set(raw.untracked.map((record) => record.path)).size === raw.untracked.length, 'root-broker untracked denominator is duplicate or unsorted')
  const selected = raw.untracked.filter((record) => ROOT_BROKER_MIGRATIONS.some((expected) => expected.path === record.path))
  const expectedSelected = ROOT_BROKER_MIGRATIONS.map(({ migration_name: _name, patch: _patch, ...record }) => record)
  assert(exactObject(selected, expectedSelected), 'root-broker exact three untracked migration rows mismatch')

  const authorityRows = new Map(authority.migrations.map((row) => [row.name, row]))
  for (const expected of ROOT_BROKER_MIGRATIONS) {
    const row = authorityRows.get(expected.migration_name)
    const { migration_name: _migrationName, patch, ...untrackedRecord } = expected
    assert(row?.provenance?.kind === 'root_broker_untracked_capture'
      && row.provenance.root_broker_package === descriptor.root
      && row.provenance.raw_git_state_sha256 === descriptor.raw_git_state_sha256
      && exactObject(row.provenance.untracked_record, untrackedRecord)
      && exactObject(row.provenance.supporting_patch, patch)
      && exactObject(row.provenance.supplemental_root_tree, {
        authority: 'SUPPLEMENTAL_NON_AUTHORIZING',
        tree: ROOT_BROKER_TREE,
        path: expected.path,
        blob: expected.working_blob,
      }), `root-broker migration authority relationship mismatch: ${expected.migration_name}`)
    const canonical = await readFile(path.join(root, row.provenance.repository_capture))
    assert(canonical.length === expected.size && sha256(canonical) === expected.sha256
      && gitOid('blob', canonical) === expected.working_blob, `root-broker migration capture/blob mismatch: ${expected.migration_name}`)
    const patchBytes = await readFile(path.join(root, patch.path))
    assert(patchBytes.length === patch.size && sha256(patchBytes) === patch.sha256, `root-broker supporting patch checksum/size mismatch: ${expected.migration_name}`)
    assertSecretSafeBytes(patchBytes, `root-broker supporting patch ${expected.migration_name}`)
    assert(extractNewFilePatch(patchBytes, expected.path).equals(canonical), `root-broker supporting patch hunk differs from canonical SQL: ${expected.migration_name}`)
  }
  return {
    files: fileNames.length,
    checksummedMembers: checksumRows.length,
    rawGitStateSha256: descriptor.raw_git_state_sha256,
    migrations: ROOT_BROKER_MIGRATIONS.length,
    patches: descriptor.patches.length,
  }
}

export async function verifySnapshotPackageContents(root, authority, descriptor = authority.provenance_evidence?.snapshot_package) {
  const packageRoot = path.join(root, descriptor.root)
  const metadata = await lstat(packageRoot).catch((error) => {
    throw new Error('snapshot evidence package root is missing', { cause: error })
  })
  assert(metadata.isDirectory() && !metadata.isSymbolicLink(), 'snapshot evidence package root is not a directory')
  const fileNames = await packageFileNames(packageRoot)
  const packagePrefix = `${descriptor.root}/`
  for (const [field, expectedRelative] of [
    ['ledger_path', 'PACKAGE_CONTENTS.tsv'],
    ['digest_path', 'PACKAGE_SHA256'],
    ['manifest_path', 'manifest.json'],
  ]) {
    assert(descriptor[field] === `${packagePrefix}${expectedRelative}`, `snapshot package ${field} escapes or misnames the package root`)
  }
  assert(fileNames.length === descriptor.package_files, 'snapshot package file count mismatch')
  assert(!fileNames.includes('files/deploy/docker-compose.production.yml'), 'snapshot package contains excluded secret-bearing compose bytes')
  assert(fileNames.includes('exclusions/deploy/docker-compose.production.yml.metadata.json'), 'snapshot package secret-safe exclusion metadata is missing')

  const ledger = await readFile(path.join(root, descriptor.ledger_path))
  assert(ledger.length === descriptor.ledger_size && sha256(ledger) === descriptor.ledger_sha256, 'snapshot package ledger checksum/size mismatch')
  const ledgerText = decodeUtf8(ledger, 'snapshot package ledger')
  assert(ledgerText.endsWith('\n') && !ledgerText.endsWith('\n\n'), 'snapshot package ledger must have one trailing LF')
  const rows = ledgerText.slice(0, -1).split('\n').map((line) => {
    const match = /^([0-9a-f]{64})\t(0|[1-9][0-9]*)\t([^\t]+)$/u.exec(line)
    assert(match && safePackagePath(match[3]), 'snapshot package ledger row is malformed')
    return { sha256: match[1], size: Number(match[2]), path: match[3] }
  })
  assert(rows.length === descriptor.ledger_members, 'snapshot package ledger member count mismatch')
  assert(rows.every((row, index) => index === 0 || rows[index - 1].path < row.path), 'snapshot package ledger is not uniquely path-sorted')
  const expectedFiles = fileNames.filter((name) => name !== 'PACKAGE_CONTENTS.tsv' && name !== 'PACKAGE_SHA256')
  assert(exactObject(rows.map((row) => row.path), expectedFiles), 'snapshot package ledger coverage mismatch')
  for (const row of rows) {
    const bytes = await readFile(path.join(packageRoot, row.path))
    assert(bytes.length === row.size && sha256(bytes) === row.sha256, `snapshot package member checksum/size mismatch: ${row.path}`)
  }

  const digestBytes = await readFile(path.join(root, descriptor.digest_path))
  assert(digestBytes.length === descriptor.digest_size && sha256(digestBytes) === descriptor.digest_sha256, 'snapshot package digest file checksum/size mismatch')
  assert(sha256(ledger) === descriptor.package_sha256, 'snapshot package canonical digest mismatch')
  assert(digestBytes.equals(Buffer.from(`${descriptor.package_sha256}  PACKAGE_CONTENTS.tsv\n`, 'ascii')), 'snapshot package digest file does not bind the canonical ledger')

  const manifestBytes = await readFile(path.join(root, descriptor.manifest_path))
  assert(manifestBytes.length === descriptor.manifest_size && sha256(manifestBytes) === descriptor.manifest_sha256, 'snapshot package manifest checksum/size mismatch')
  let manifest
  try {
    manifest = JSON.parse(decodeUtf8(manifestBytes, 'snapshot package manifest'))
  } catch (error) {
    if (error?.message?.includes('canonical UTF-8')) throw error
    throw new Error('snapshot package manifest is not valid JSON', { cause: error })
  }
  assert(manifest.schema === descriptor.schema
    && manifest.snapshot?.snapshot_id === descriptor.snapshot_id
    && manifest.package_digest?.algorithm === descriptor.package_digest_algorithm
    && manifest.package_digest?.ledger_file === 'PACKAGE_CONTENTS.tsv'
    && manifest.package_digest?.digest_file === 'PACKAGE_SHA256', 'snapshot package manifest identity/digest contract mismatch')
  assert(manifest.secret_screen?.result === 'CONTENT_EXCLUDED'
    && exactObject(manifest.secret_screen?.files_excluded, ['deploy/docker-compose.production.yml']), 'snapshot package secret-screen contract mismatch')
  assert(manifest.secret_screen?.finding_count === 3
    && manifest.snapshot?.production_head === 'e6a0a833fbb756216b058bfe326f9f9c77c4cc6d'
    && manifest.snapshot?.prior_sha256_matches === 28
    && manifest.snapshot?.prior_sha256_changes === 0, 'snapshot package capture continuity summary mismatch')
  assert(Array.isArray(manifest.files) && manifest.files.length === 28, 'snapshot package manifest file inventory mismatch')
  const manifestPaths = new Set()
  let preserved = 0
  let excluded = 0
  for (const record of manifest.files) {
    assert(safePackagePath(record.relative_path) && !manifestPaths.has(record.relative_path), 'snapshot package manifest has an unsafe or duplicate source path')
    manifestPaths.add(record.relative_path)
    assert(SHA256.test(record.current_sha256) && record.current_sha256 === record.old_reported_sha256
      && Number.isInteger(record.size_bytes) && record.size_bytes >= 0
      && record.hash_continuity === 'MATCH' && record.source_stable_during_capture === true, `snapshot manifest source continuity mismatch: ${record.relative_path}`)
    if (record.content_status === 'PRESERVED_EXACT') {
      preserved += 1
      assert(record.snapshot_path === `files/${record.relative_path}` && record.snapshot_sha256 === record.current_sha256, `snapshot manifest preserved path/hash mismatch: ${record.relative_path}`)
      const bytes = await readFile(path.join(packageRoot, record.snapshot_path))
      assert(bytes.length === record.size_bytes && sha256(bytes) === record.snapshot_sha256, `snapshot manifest preserved member mismatch: ${record.relative_path}`)
    } else {
      excluded += 1
      assert(record.content_status === 'EXCLUDED_SECRET_SAFE'
        && record.relative_path === 'deploy/docker-compose.production.yml'
        && record.snapshot_path === null && record.snapshot_sha256 === null
        && safePackagePath(record.exclusion_metadata_path), 'snapshot manifest exclusion record mismatch')
      assert(fileNames.includes(record.exclusion_metadata_path), 'snapshot manifest exclusion metadata member is missing')
      const exclusionBytes = await readFile(path.join(packageRoot, record.exclusion_metadata_path))
      let exclusion
      try {
        exclusion = JSON.parse(decodeUtf8(exclusionBytes, 'snapshot package exclusion metadata'))
      } catch (error) {
        if (error?.message?.includes('canonical UTF-8')) throw error
        throw new Error('snapshot package exclusion metadata is not valid JSON', { cause: error })
      }
      assert(exclusion.schema === 'crm-arch-000r-content-exclusion-v1'
        && exclusion.content_status === record.content_status
        && exclusion.relative_original_path === record.relative_path
        && exclusion.current_sha256 === record.current_sha256
        && exclusion.old_reported_sha256 === record.old_reported_sha256
        && exclusion.size_bytes === record.size_bytes
        && exactObject(exclusion.findings, record.secret_screen_findings), 'snapshot package exclusion metadata/manifest relationship mismatch')
    }
  }
  assert(preserved === 27 && excluded === 1
    && manifest.snapshot?.exact_content_files_preserved === preserved
    && manifest.snapshot?.content_files_excluded_secret_safe === excluded
    && manifest.snapshot?.expected_file_entries === manifest.files.length, 'snapshot package manifest preservation counts mismatch')

  const row = authority.migrations.find((candidate) => candidate.name === SNAPSHOT_MIGRATION)
  assert(row?.provenance.kind === 'evidence_snapshot'
    && row.provenance.repository_package_root === descriptor.root
    && row.provenance.package_sha256 === descriptor.package_sha256
    && row.provenance.package_member === `files/gravity-mvp/prisma/migrations/${SNAPSHOT_MIGRATION}/migration.sql`, 'snapshot migration package relationship mismatch')
  const member = await readFile(path.join(packageRoot, row.provenance.package_member))
  const capture = await readFile(path.join(root, row.provenance.repository_capture))
  assert(member.equals(capture) && member.length === row.size && sha256(member) === row.sha256
    && row.provenance.artifact_sha256 === row.sha256, 'snapshot migration member/capture relationship mismatch')
  return { files: fileNames.length, ledgerMembers: rows.length, packageSha256: descriptor.package_sha256 }
}

export async function verifyProductionMigrationProvenanceEvidence(root, authority) {
  assert(exactObject(authority.provenance_evidence, PROVENANCE_EVIDENCE_AUTHORITY), 'production migration provenance evidence authority mismatch')
  const gitDescriptor = authority.provenance_evidence.git_object_lineage
  const gitBytes = await readFile(path.join(root, gitDescriptor.path)).catch((error) => {
    throw new Error('Git object lineage evidence is missing', { cause: error })
  })
  assert(gitBytes.length === gitDescriptor.size && sha256(gitBytes) === gitDescriptor.sha256, 'Git object lineage evidence checksum/size mismatch')
  const git = await verifyGitObjectLineageBytes(root, authority, gitBytes)
  const snapshot = await verifySnapshotPackageContents(root, authority)
  const rootBroker = await verifyRootBrokerPackage(root, authority)
  return { git, snapshot, rootBroker }
}
