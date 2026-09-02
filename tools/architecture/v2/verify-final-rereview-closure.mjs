#!/usr/bin/env node

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

export const CLOSURE_PATH = 'architecture/recovery/whole-project-dod/v2/FINAL_EXTERNAL_REREVIEW_CLOSURE.json'
export const TEMPLATE_PATH = 'architecture/recovery/whole-project-dod/v2/FINAL_EXTERNAL_REREVIEW_CLOSURE.template.json'
export const MAPPING_PATH = 'architecture/recovery/whole-project-dod/v2/ORIGINAL_DOD_CANONICAL_MAPPING.json'
export const LEDGER_PATH = 'architecture/recovery/whole-project-dod/v2/EXTERNAL_REREVIEW_REMEDIATION_LEDGER.json'
export const EVIDENCE_PATHS = Object.freeze({
  accepted_source_record: 'architecture/recovery/whole-project-dod/v2/FINAL_ACCEPTED_SOURCE_RECORD_20260813.json',
  local_clean_ci_execution: 'architecture/recovery/whole-project-dod/v2/FINAL_LOCAL_CLEAN_CI_EXECUTION_20260813.json',
  fresh_clean_ci_execution: 'architecture/recovery/whole-project-dod/v2/FINAL_FRESH_CLEAN_CI_EXECUTION_20260813.json',
  runtime_release_seal: 'architecture/recovery/whole-project-dod/v2/FINAL_RUNTIME_V10_RELEASE_SEAL_20260813.json',
  runtime_owner_bootstrap: 'architecture/recovery/whole-project-dod/v2/FINAL_RUNTIME_V10_OWNER_BOOTSTRAP_20260813.json',
  runtime_production_acceptance: 'architecture/recovery/whole-project-dod/v2/FINAL_RUNTIME_V10_PRODUCTION_ACCEPTANCE_20260813.json',
  internal_critic_review: 'architecture/recovery/whole-project-dod/v2/FINAL_INTERNAL_ADVERSARIAL_REVIEW_20260813.json',
  internal_critic_verification: 'architecture/recovery/whole-project-dod/v2/FINAL_INTERNAL_ADVERSARIAL_VERIFICATION_20260813.json',
})

const SHA40 = /^[0-9a-f]{40}$/u
const SHA64 = /^[0-9a-f]{64}$/u
const IMAGE_SHA = /^sha256:[0-9a-f]{64}$/u
const UTC_SECOND = /^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/u
const GITHUB_REPOSITORY = 'nashavtoparkmedia-byte/CRM'
const WORKFLOW_PATH = '.github/workflows/architecture-enforcement.yml'
const RUNNER_PATH = 'tools/architecture/run-authoritative-ci.mjs'
const RUNTIME_PATH = '/usr/local/sbin/yoko-privileged-runtime'
const INTERNAL_VALIDATOR_REPOSITORY_PATH = 'architecture/recovery/control-plane/v2/owner-bootstrap/crm-external-rereview-source-only-v10/packaging/verify-independent-critic.py'
const INTERNAL_VALIDATOR_PATH = 'packaging/verify-independent-critic.py'
const NODE_SHA256 = '6295488653f0d93b0a157841746fef7e72cc4328cfb60c4bbe0ca2668a836ffd'
const MAX_PRODUCTION_EVIDENCE_AGE_SECONDS = 7200
const ATTACK_IDS = Object.freeze([
  'clean-checkout-ci',
  'raw-credential-synthetic-bypass',
  'unauthorized-migration-write',
  'public-internal-facade-laundering',
  'overlapping-manifest-ownership',
  'stale-forbidden-dependency-plan',
  'missing-migration-provenance',
  'denominator-drift',
])
const ATTACK_COMMANDS = Object.freeze({
  'clean-checkout-ci': [['tools/architecture/run-authoritative-ci.mjs']],
  'raw-credential-synthetic-bypass': [['tools/architecture/v2/test-authoritative-credential-inventory.mjs']],
  'unauthorized-migration-write': [
    [
      'tools/architecture/v2/analyze.mjs', '--root', '.', '--strict', '--workers', '4',
      '--worker-timeout-ms', '120000', '--progress-every', '25', '--surface-registry',
      'architecture/recovery/whole-project-dod/v2/LIFECYCLE_SURFACE_CLASSIFICATION_REGISTRY.json',
      '--progress-jsonl', '$FRESH_WRITE_PROGRESS', '--output', '$FRESH_WRITE_ANALYSIS',
    ],
    ['tools/architecture/v2/test-migration-write-site-authorizations.mjs', '$FRESH_WRITE_ANALYSIS'],
  ],
  'public-internal-facade-laundering': [['tools/architecture/test-architecture-enforcement.mjs']],
  'overlapping-manifest-ownership': [['--test', 'tools/architecture/__tests__/context-manifests.test.mjs']],
  'stale-forbidden-dependency-plan': [['tools/architecture/test-final-dependency-artifact.mjs']],
  'missing-migration-provenance': [['tools/architecture/test-production-migration-authority.mjs']],
  'denominator-drift': [['tools/architecture/v2/test-original-dod-canonical-mapping.mjs']],
})
const FINDING_IDS = Object.freeze(Array.from({ length: 7 }, (_, index) => `EXTERNAL-REREVIEW-${String(index + 1).padStart(3, '0')}`))
const DOD_IDS = Object.freeze(Array.from({ length: 22 }, (_, index) => `ORIGINAL-DOD-${String(index + 1).padStart(3, '0')}`))
const FINAL_CHANGED_PATHS = Object.freeze([
  CLOSURE_PATH,
  'architecture/recovery/whole-project-dod/v2/FINAL_CLOSURE_TRANSITION_20260813.md',
  LEDGER_PATH,
  MAPPING_PATH,
  ...Object.values(EVIDENCE_PATHS),
].sort())
const PREREQUISITES = Object.freeze([
  'npm ci --prefix gravity-mvp --ignore-scripts',
  'npm ci --prefix tg-bot --ignore-scripts',
  'npm run --prefix gravity-mvp gen',
  'npm run --prefix tg-bot gen',
])
const EMPTY_SHA256 = createHash('sha256').update('').digest('hex')
const CLOSURE_TOKEN = Symbol('verified-final-rereview-closure')
export const FINAL_CLOSURE_CONTROL_CATALOG = Object.freeze([
  'authoritative-ci-inventory',
  'whole-repository-credential-inventory',
  'fresh-credential-verification',
  'whole-repository-write-scan',
  'fresh-write-verification',
  'fresh-migration-write-site-authorizations',
  'original-dod-canonical-mapping',
  'original-dod-canonical-mapping-negatives',
  'manifest-policy',
  'manifest-negatives',
  'executable-path-ownership-negatives',
  'final-dependency-artifact',
  'module-scaffold-negatives',
  'production-migration-authority',
  'production-migration-authority-negatives',
  'production-migration-default-clean-checkout',
  'production-migration-runtime-semantics',
  'source-only-runtime-v10-contract',
  'production-migration-committed-runtime-inventory',
  'production-migration-canonical-replay',
  'production-migration-predecessor-recovery-replay',
  'architecture-policy',
  'architecture-negatives',
  'write-analyzer-negatives',
  'write-runner-negatives',
  'write-gate-negatives',
  'surface-lifecycle-negatives',
  'ambiguity-reconciliation',
  'scoped-ownership-negatives',
  'maintenance-capability-negatives',
  'credential-field-registry',
  'credential-analyzer-negatives',
  'credential-inventory-negatives',
  'credential-boundary-negatives',
  'credential-gate-negatives',
  'credential-migration-boundary',
  'contract-registry-policy',
  'contract-registry-negatives',
  'contract-policy',
  'contract-behavior',
  'outbox-policy',
  'outbox-behavior-negatives',
  'static-sql-policy',
  'typescript-baseline-negatives',
  'typescript-baseline',
  'blast-radius-negatives',
  'blast-radius',
  'boundary-control-lifecycle-negatives',
  'all-current-boundaries',
  'independent-source-critic',
  'gravity-security',
  'tg-bot-security',
])
export const FINAL_CLOSURE_CONTROL_CATALOG_SHA256 = '7268cb0b049390bee10aebf53277c1f771b04670ed5c59ae022db0e9ff317680'
export const FINAL_CLOSURE_SEMANTIC_CATALOG_SHA256 = '24ad32ba5a97e617e34bd19a3bcb2109807bf946636737d02b12fd7607185483'

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]))
  }
  return value
}

export function canonicalBytes(value) {
  return Buffer.from(`${JSON.stringify(stableValue(value))}\n`, 'utf8')
}

function exactObject(value, keys, label) {
  assert.equal(value !== null && typeof value === 'object' && !Array.isArray(value), true, `${label} must be an object`)
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${label} exact-key mismatch`)
  return value
}

function positiveGithubId(value, label) {
  const normalized = typeof value === 'number' ? String(value) : value
  assert.equal(typeof normalized === 'string' && /^[1-9][0-9]*$/u.test(normalized), true, `${label} must be a positive GitHub id`)
  return normalized
}

function utc(value, label) {
  assert.equal(typeof value === 'string' && UTC_SECOND.test(value), true, `${label} must be an exact UTC-second timestamp`)
  assert.equal(Number.isNaN(Date.parse(value)), false, `${label} is not a real timestamp`)
  return value
}

// JSON.parse silently accepts duplicate object keys.  Closure evidence is an
// authority document, so scan the complete grammar first and reject duplicates
// at every nesting level before handing the bytes to JSON.parse.
export function parseJsonRejectDuplicates(raw, label = 'JSON document') {
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw)
  let offset = 0
  const white = () => { while (/\s/u.test(text[offset] ?? '')) offset += 1 }
  const stringToken = () => {
    assert.equal(text[offset], '"', `${label} contains invalid JSON string`)
    const start = offset
    offset += 1
    while (offset < text.length) {
      if (text[offset] === '\\') {
        offset += 2
        continue
      }
      if (text[offset] === '"') {
        offset += 1
        return JSON.parse(text.slice(start, offset))
      }
      offset += 1
    }
    throw new Error(`${label} contains an unterminated JSON string`)
  }
  const value = () => {
    white()
    if (text[offset] === '{') {
      offset += 1
      white()
      const keys = new Set()
      if (text[offset] === '}') { offset += 1; return }
      while (true) {
        white()
        const key = stringToken()
        assert.equal(keys.has(key), false, `${label} contains duplicate JSON key: ${key}`)
        keys.add(key)
        white()
        assert.equal(text[offset], ':', `${label} contains invalid JSON object`)
        offset += 1
        value()
        white()
        if (text[offset] === '}') { offset += 1; return }
        assert.equal(text[offset], ',', `${label} contains invalid JSON object`)
        offset += 1
      }
    }
    if (text[offset] === '[') {
      offset += 1
      white()
      if (text[offset] === ']') { offset += 1; return }
      while (true) {
        value()
        white()
        if (text[offset] === ']') { offset += 1; return }
        assert.equal(text[offset], ',', `${label} contains invalid JSON array`)
        offset += 1
      }
    }
    if (text[offset] === '"') { stringToken(); return }
    const match = /^(?:-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?|true|false|null)/u.exec(text.slice(offset))
    assert(match, `${label} contains invalid JSON value`)
    offset += match[0].length
  }
  value()
  white()
  assert.equal(offset, text.length, `${label} contains trailing data`)
  return JSON.parse(text)
}

export function verifyClosureTemplate(template) {
  exactObject(template, [
    'schema', 'status', 'closure_schema', 'instruction', 'required_evidence_files',
    'required_final_counts', 'external_project_rereview_satisfied',
  ], 'final closure template')
  assert.equal(template.schema, 'yoko.crm.external-rereview-final-closure-template.v1')
  assert.equal(template.status, 'PENDING', 'closure template must remain non-authorizing')
  assert.equal(template.closure_schema, 'yoko.crm.external-rereview-final-closure.v1')
  assert.equal(typeof template.instruction === 'string' && template.instruction.includes('Placeholder or PENDING values never authorize closure.'), true)
  assert.deepEqual(template.required_evidence_files, EVIDENCE_PATHS)
  assert.deepEqual(template.required_final_counts, {
    external_findings_closed: 7,
    canonical_dod_closed: 22,
    authoritative_ci_controls_passed: 52,
    internal_attacks_passed: 8,
    production_migrations_active: 62,
  })
  assert.equal(template.external_project_rereview_satisfied, false)
  assert.equal(JSON.stringify(template).includes('REPLACE_WITH'), false, 'closure template must not contain fabricated identity placeholders')
  return { status: 'PASS', phase: 'PENDING' }
}

function expectedCatalog() {
  const catalog = [...FINAL_CLOSURE_CONTROL_CATALOG]
  assert.equal(
    sha256(canonicalBytes(catalog)),
    FINAL_CLOSURE_CONTROL_CATALOG_SHA256,
    'historical final-closure control catalog digest drift',
  )
  return catalog
}

function verifyHostedCi(attestation, source, repository) {
  exactObject(attestation, [
    'schema', 'provider', 'repository', 'source', 'workflow', 'runner', 'run',
    'check', 'jobs', 'artifact', 'controls',
  ], 'hosted CI attestation')
  assert.equal(attestation.schema, 'yoko.crm.hosted-authoritative-ci-attestation.v1')
  assert.equal(attestation.provider, 'github-actions')
  assert.equal(attestation.repository, GITHUB_REPOSITORY)
  assert.deepEqual(attestation.source, source, 'hosted CI source SHA mismatch')
  assert.deepEqual(attestation.workflow, { path: WORKFLOW_PATH, sha256: repository.workflowSha256 }, 'hosted workflow SHA mismatch')
  assert.deepEqual(attestation.runner, { path: RUNNER_PATH, sha256: repository.runnerSha256 }, 'hosted runner SHA mismatch')

  const run = exactObject(attestation.run, ['id', 'attempt', 'url', 'head_sha', 'conclusion'], 'hosted run')
  const runId = positiveGithubId(run.id, 'hosted run id')
  positiveGithubId(run.attempt, 'hosted run attempt')
  assert.equal(run.url, `https://github.com/${GITHUB_REPOSITORY}/actions/runs/${runId}`)
  assert.equal(run.head_sha, source.commit)
  assert.equal(run.conclusion, 'success')
  assert.equal(Array.isArray(attestation.jobs) && attestation.jobs.length === 2, true, 'hosted jobs must be exact')
  const jobNames = ['architecture', 'gravity-artifact']
  for (let index = 0; index < jobNames.length; index += 1) {
    const job = exactObject(attestation.jobs[index], ['id', 'name', 'url', 'head_sha', 'status', 'conclusion'], `hosted ${jobNames[index]} job`)
    const id = positiveGithubId(job.id, 'hosted job id')
    assert.deepEqual(job, {
      id: job.id,
      name: jobNames[index],
      url: `https://github.com/${GITHUB_REPOSITORY}/actions/runs/${runId}/job/${id}`,
      head_sha: source.commit,
      status: 'completed',
      conclusion: 'success',
    })
  }
  const check = exactObject(attestation.check, ['id', 'name', 'url', 'head_sha', 'conclusion'], 'hosted check')
  assert.deepEqual(check, {
    id: attestation.jobs[0].id,
    name: 'architecture',
    url: attestation.jobs[0].url,
    head_sha: source.commit,
    conclusion: 'success',
  })
  const artifact = exactObject(attestation.artifact, [
    'id', 'name', 'url', 'expired', 'size_in_bytes', 'digest', 'workflow_run_id', 'head_sha',
  ], 'hosted artifact')
  const artifactId = positiveGithubId(artifact.id, 'hosted artifact id')
  assert.equal(Number(artifact.size_in_bytes) >= 1024, true)
  assert.equal(artifact.name, `gravity-image-${source.commit}`)
  assert.equal(artifact.url, `https://github.com/${GITHUB_REPOSITORY}/actions/runs/${runId}/artifacts/${artifactId}`)
  assert.equal(artifact.expired, false)
  assert.equal(/^sha256:[0-9a-f]{64}$/u.test(artifact.digest), true)
  assert.equal(String(artifact.workflow_run_id), runId)
  assert.equal(artifact.head_sha, source.commit)

  const catalog = expectedCatalog()
  assert.equal(catalog.length, 52, 'authoritative control catalog is not 52')
  assert.deepEqual(attestation.controls, {
    count: 52,
    catalog_sha256: FINAL_CLOSURE_CONTROL_CATALOG_SHA256,
    semantic_catalog_sha256: FINAL_CLOSURE_SEMANTIC_CATALOG_SHA256,
    catalog,
  }, 'hosted CI does not contain the exact ordered 52-control catalog')
  return attestation
}

function verifyExecutionProof(proof, source, repository) {
  exactObject(proof, ['schema', 'outcome', 'source', 'workflow', 'runner', 'runtime', 'controls'], 'CI execution proof')
  assert.equal(proof.schema, 'yoko.crm.authoritative-ci-execution-proof.v1')
  assert.equal(proof.outcome, 'PASS')
  assert.deepEqual(proof.source, source, 'clean CI source SHA mismatch')
  assert.deepEqual(proof.workflow, { path: WORKFLOW_PATH, sha256: repository.workflowSha256 })
  assert.deepEqual(proof.runner, { path: RUNNER_PATH, sha256: repository.runnerSha256 })
  exactObject(proof.runtime, ['node', 'blast_base', 'blast_base_commit'], 'CI proof runtime')
  assert.equal(proof.runtime.node, '20.20.2')
  assert.equal(proof.runtime.blast_base, 'HEAD^')
  assert.equal(
    proof.runtime.blast_base_commit,
    repository.acceptedSourceParent,
    'clean CI blast base must bind the exact accepted-source parent commit',
  )
  const catalog = expectedCatalog()
  assert.deepEqual(proof.controls, {
    count: 52,
    catalog_sha256: FINAL_CLOSURE_CONTROL_CATALOG_SHA256,
    semantic_catalog_sha256: FINAL_CLOSURE_SEMANTIC_CATALOG_SHA256,
    executions: catalog.map((id) => ({ id, status: 'PASS' })),
  }, 'clean CI proof requires all exact 52 ordered PASS controls')
}

function verifyCleanReproduction(document, kind, source, repository) {
  exactObject(document, [
    'schema', 'status', 'kind', 'executed_at', 'source', 'checkout',
    'generated_prerequisites', 'execution_proof',
  ], `${kind} clean reproduction`)
  assert.equal(document.schema, 'yoko.crm.clean-checkout-ci-reproduction.v1')
  assert.equal(document.status, 'PASS')
  assert.equal(document.kind, kind)
  utc(document.executed_at, `${kind} executed_at`)
  assert.deepEqual(document.source, source)
  exactObject(document.checkout, ['head', 'tree', 'tracked_changes', 'untracked_changes', 'environment_id_sha256'], `${kind} checkout`)
  assert.deepEqual({ commit: document.checkout.head, tree: document.checkout.tree }, source)
  assert.equal(document.checkout.tracked_changes, 0)
  assert.equal(document.checkout.untracked_changes, 0)
  assert.equal(SHA64.test(document.checkout.environment_id_sha256), true)
  assert.deepEqual(document.generated_prerequisites, PREREQUISITES)
  verifyExecutionProof(document.execution_proof, source, repository)
}

function verifyAcceptanceRecord(record, source, repository) {
  exactObject(record, [
    'schema', 'status', 'commit', 'tree', 'authoritative_ci', 'source_only',
    'migration_sql_change_from_7aea', 'schema_sync_to_production_authority',
    'accepted_by', 'accepted_at',
  ], 'accepted source record')
  assert.equal(record.schema, 'yoko.crm.accepted-clean-release-commit.v2')
  assert.equal(record.status, 'ACCEPTED')
  assert.deepEqual({ commit: record.commit, tree: record.tree }, source)
  assert.equal(record.source_only, true)
  assert.equal(record.migration_sql_change_from_7aea, false)
  assert.equal(record.schema_sync_to_production_authority, true)
  assert.equal(typeof record.accepted_by === 'string' && /^INDEPENDENT_[A-Z0-9_.:-]{3,120}$/u.test(record.accepted_by), true)
  assert.notEqual(record.accepted_by, 'INDEPENDENT_OFFLINE_TEST_FIXTURE')
  utc(record.accepted_at, 'accepted source timestamp')
  verifyHostedCi(record.authoritative_ci, source, repository)
}

function artifactIdentity(value, label) {
  exactObject(value, ['path', 'sha256', 'bytes', 'mode'], label)
  assert.equal(typeof value.path === 'string' && value.path.length > 0, true)
  assert.equal(SHA64.test(value.sha256), true)
  assert.equal(Number.isInteger(value.bytes) && value.bytes > 0, true)
  assert.equal(/^0[0-7]{3}$/u.test(value.mode), true)
  return value
}

function verifyReleaseSeal(seal, source, acceptedRecord, rawAcceptedRecord) {
  assert.equal(seal?.schema, 'yoko.crm.source-only-release-seal.v2')
  assert.equal(seal?.status, 'SEALED')
  assert.equal(seal?.package_version, '2.0.0-10', 'Runtime v9/stale release seal is forbidden')
  assert.equal(seal?.runtime_abi, '2.0.0')
  assert.deepEqual({ commit: seal?.commit, tree: seal?.tree }, source)
  assert.equal(seal?.profile_id, `crm-${source.commit.slice(0, 12)}-gravity-source-v1`)
  assert.deepEqual(seal?.hosted_authoritative_ci, acceptedRecord.authoritative_ci)
  assert.equal(seal?.acceptance_record_sha256, sha256(rawAcceptedRecord))
  assert.equal(SHA64.test(seal?.archive_sha256), true)
  assert.equal(SHA64.test(seal?.production_snapshot_sha256), true)
  assert.equal(SHA64.test(seal?.migration_authority_sha256), true)
  assert.equal(SHA64.test(seal?.predecessor_attestation_sha256), true)
  assert.equal(SHA64.test(seal?.canonical_migration_inventory_digest), true)
  assert.equal(SHA64.test(seal?.accepted_live_chronology_sha256), true)
  assert.equal(seal?.database_mutation_authorized, false)
  assert.equal(seal?.accepted_builder_source?.prefix, 'architecture/recovery/control-plane/v2/owner-bootstrap/crm-external-rereview-source-only-v10')
  assert.equal(Number.isInteger(seal?.accepted_builder_source?.file_count) && seal.accepted_builder_source.file_count > 0, true)
  assert.equal(SHA64.test(seal?.accepted_builder_source?.inventory_sha256), true)
  artifactIdentity(seal?.built_artifacts?.deb, 'sealed Debian package')
  artifactIdentity(seal?.built_artifacts?.bootstrap_tar, 'sealed bootstrap tar')
  assert.equal(IMAGE_SHA.test(seal?.gravity_image_artifact?.image_id), true)
  assert.deepEqual(
    seal?.gravity_image_artifact?.github_artifact,
    acceptedRecord.authoritative_ci.artifact,
    'sealed Gravity artifact differs from the exact hosted CI artifact',
  )
}

function verifyOwnerBootstrap(manifest, seal, reviewVerification) {
  assert.equal(manifest?.schema, 'yoko.crm.source-only-owner-bootstrap.v1')
  assert.equal(manifest?.status, 'ACCEPTED_WAITING_FOR_OWNER')
  assert.deepEqual(manifest?.seal, seal)
  assert.equal(manifest?.package?.version, '2.0.0-10')
  assert.equal(manifest?.package?.runtime_abi, '2.0.0')
  assert.equal(manifest?.package?.sha256, seal.built_artifacts.deb.sha256)
  assert.equal(manifest?.bootstrap_tar?.sha256, seal.built_artifacts.bootstrap_tar.sha256)
  assert.equal(manifest?.owner_command_authorized, true)
  assert.equal(typeof manifest?.owner_command === 'string' && manifest.owner_command.length > 100, true)
  assert.deepEqual(manifest?.enabled_zero_argument_profiles, ['database-status', 'release-preflight', 'release-activate', 'rollback'])
  assert.deepEqual(manifest?.disabled_profiles, ['config-activate', 'database-migrate'])
  assert.equal(manifest?.core_policy_sudoers_byte_identical, true)
  assert.equal(manifest?.self_issued_review_accepted, false, 'self-issued critic cannot authorize closure')
  assert.equal(manifest?.external_project_rereview_satisfied, false)
  assert.deepEqual(manifest?.internal_review_verification, reviewVerification)
}

function verifyAttackRows(attacks, label) {
  assert.equal(Array.isArray(attacks), true, `${label} attacks must be a list`)
  assert.deepEqual(attacks.map((attack) => attack.id), ATTACK_IDS, `${label} attack catalog missing, duplicate, or reordered`)
  for (const attack of attacks) {
    exactObject(attack, ['id', 'status', 'evidence_sha256'], `${label} attack`)
    assert.equal(attack.status, 'PASS')
    assert.equal(SHA64.test(attack.evidence_sha256), true)
  }
  return attacks
}

export function expectedValidatorIdentity(repository) {
  const executionCatalog = ATTACK_IDS.map((id) => ({
    id,
    commands: ATTACK_COMMANDS[id].map((command) => ['NODE_20.20.2', ...command]),
  }))
  return {
    schema: 'yoko.crm.internal-runtime-bootstrap-replay-validator.v1',
    path: INTERNAL_VALIDATOR_PATH,
    sha256: repository.validatorSha256,
    node_version: 'v20.20.2',
    node_sha256: NODE_SHA256,
    attack_catalog_sha256: sha256(canonicalBytes(ATTACK_IDS)),
    attack_execution_catalog_sha256: sha256(canonicalBytes(executionCatalog)),
  }
}

function verifyInternalCritic(review, verification, rawReview, source, seal, sealSha256, closure, repository) {
  exactObject(review, [
    'schema', 'verdict', 'reviewer_assertion', 'reviewed_at', 'separation_assertion',
    'bindings', 'validator', 'attacks', 'residual_findings',
    'repository_mutated_by_reviewer', 'production_mutated_by_reviewer',
  ], 'internal critic review')
  assert.equal(review.schema, 'yoko.crm.internal-runtime-bootstrap-review.v1')
  assert.equal(review.verdict, 'PASS')
  assert.equal(review.reviewer_assertion, closure.review_separation.reviewer_assertion)
  assert.equal(/^INTERNAL_CRITIC_[A-Z0-9_.:-]{3,120}$/u.test(review.reviewer_assertion), true)
  assert.notEqual(review.reviewer_assertion, closure.review_separation.executor_assertion, 'self-issued critic is forbidden')
  assert.equal(review.separation_assertion, 'NOT_THE_EXECUTOR_AND_NOT_THE_POST_READY_EXTERNAL_REVIEWER')
  utc(review.reviewed_at, 'internal critic reviewed_at')
  assert.deepEqual(review.validator, expectedValidatorIdentity(repository), 'internal critic validator is not the accepted-source exact validator')
  assert.deepEqual(review.bindings?.source, source)
  assert.equal(review.bindings?.sealed_release_sha256, sealSha256)
  assert.deepEqual(review.bindings?.hosted_authoritative_ci, seal.hosted_authoritative_ci)
  assert.equal(review.bindings?.hosted_authoritative_ci_sha256, sha256(canonicalBytes(seal.hosted_authoritative_ci)))
  assert.equal(review.bindings?.bootstrap_tar?.sha256, seal.built_artifacts.bootstrap_tar.sha256)
  assert.equal(review.bindings?.debian_package?.sha256, seal.built_artifacts.deb.sha256)
  assert.deepEqual(review.residual_findings, [])
  assert.equal(review.repository_mutated_by_reviewer, false)
  assert.equal(review.production_mutated_by_reviewer, false)
  verifyAttackRows(review.attacks, 'internal review')

  exactObject(verification, [
    'schema', 'status', 'reviewer_assertion', 'reviewed_at',
    'internal_review_artifact_sha256', 'sealed_release_sha256',
    'bootstrap_tar_sha256', 'debian_package_sha256',
    'hosted_authoritative_ci_sha256', 'attack_catalog_sha256',
    'attack_execution_catalog_sha256', 'attacks', 'validator',
    'external_project_rereview_satisfied',
  ], 'internal critic verification')
  assert.equal(verification.schema, 'yoko.crm.internal-runtime-bootstrap-review-verification.v1')
  assert.equal(verification.status, 'PASS')
  assert.equal(verification.reviewer_assertion, review.reviewer_assertion)
  assert.equal(verification.reviewed_at, review.reviewed_at)
  assert.equal(verification.internal_review_artifact_sha256, sha256(rawReview))
  assert.equal(verification.sealed_release_sha256, review.bindings.sealed_release_sha256)
  assert.equal(verification.bootstrap_tar_sha256, seal.built_artifacts.bootstrap_tar.sha256)
  assert.equal(verification.debian_package_sha256, seal.built_artifacts.deb.sha256)
  assert.equal(verification.hosted_authoritative_ci_sha256, review.bindings.hosted_authoritative_ci_sha256)
  assert.equal(verification.attack_catalog_sha256, expectedValidatorIdentity(repository).attack_catalog_sha256)
  assert.equal(verification.attack_execution_catalog_sha256, expectedValidatorIdentity(repository).attack_execution_catalog_sha256)
  assert.deepEqual(verification.validator, review.validator)
  assert.deepEqual(verification.attacks, review.attacks)
  verifyAttackRows(verification.attacks, 'internal verification')
  assert.equal(verification.external_project_rereview_satisfied, false)
}

function verifyRuntimeResponse(record, primitive, resource = null) {
  exactObject(record, ['captured_at', 'command', 'response_sha256', 'response'], `${primitive} observation`)
  utc(record.captured_at, `${primitive} captured_at`)
  assert.deepEqual(record.command, ['/usr/bin/sudo', '-n', RUNTIME_PATH, primitive, ...(resource ? [resource] : [])])
  assert.equal(record.response_sha256, sha256(canonicalBytes(record.response)))
  const response = exactObject(record.response, [
    'schema', 'runtime_version', 'primitive', 'resource', 'ok', 'timestamp',
    'evidence', 'warnings', 'errors',
  ], `${primitive} Runtime response`)
  assert.equal(response.schema, 'yoko.privileged-runtime.response.v1')
  assert.equal(response.runtime_version, '2.0.0')
  assert.equal(response.primitive, primitive)
  assert.equal(response.resource, resource)
  assert.equal(response.ok, true)
  assert.deepEqual(response.warnings, [])
  assert.deepEqual(response.errors, [])
  utc(response.timestamp, `${primitive} Runtime response timestamp`)
  const captureDelta = (Date.parse(record.captured_at) - Date.parse(response.timestamp)) / 1000
  assert.equal(captureDelta >= 0 && captureDelta <= 5, true, `${primitive} capture time is not bound to the Runtime response`)
  return response.evidence
}

function verifyLiveRows(database, seal) {
  const rows = database.canonical_live_rows
  assert.equal(Array.isArray(rows) && rows.length === 62, true, 'production migration chronology must contain exactly 62 rows')
  assert.deepEqual(rows.map((row) => row.observed_chronological_ordinal), Array.from({ length: 62 }, (_, index) => index + 1))
  assert.equal(new Set(rows.map((row) => row.migration_id)).size, 62)
  assert.equal(new Set(rows.map((row) => row.migration_name)).size, 62)
  for (const row of rows) {
    exactObject(row, [
      'observed_chronological_ordinal', 'migration_id', 'migration_name', 'checksum',
      'status', 'started_at', 'finished_at', 'rolled_back_at',
      'applied_steps_count', 'logs_present', 'logs_bytes', 'logs_sha256',
    ], 'production migration row')
    assert.equal(typeof row.migration_name === 'string' && row.migration_name.length > 0, true)
    assert.equal(SHA64.test(row.checksum), true)
    assert.equal(row.status, 'FINISHED_ACTIVE')
    assert.equal(row.rolled_back_at, null)
    assert.equal(typeof row.started_at === 'string' && typeof row.finished_at === 'string', true)
  }
  assert.equal(database.canonical_live_rows_sha256, sha256(Buffer.from(JSON.stringify(stableValue(rows)), 'utf8')))
  assert.equal(database.expected_live_chronology_sha256, seal.accepted_live_chronology_sha256)
  const observedChronology = rows.map((row, index) => ({
    ordinal: index + 1,
    migration_name: row.migration_name,
    checksum: row.checksum,
  }))
  assert.equal(
    sha256(Buffer.from(JSON.stringify(stableValue(observedChronology)), 'utf8')),
    seal.accepted_live_chronology_sha256,
    'live production chronology does not match the source-bound seal authority',
  )
}

function verifyProductionAcceptance(document, source, seal, rawSeal) {
  exactObject(document, [
    'schema', 'status', 'captured_at', 'host', 'accepted_source', 'release',
    'observations', 'capture_transcript_sha256', 'secret_values_emitted',
    'production_mutated_by_acceptance_capture', 'known_non_gate_observation',
  ], 'Runtime v10 production acceptance')
  assert.equal(document.schema, 'yoko.crm.runtime-v10-production-acceptance.v1')
  assert.equal(document.status, 'ACCEPTED')
  utc(document.captured_at, 'production acceptance captured_at')
  assert.equal(document.host, 'jvxthcorvm')
  assert.deepEqual(document.accepted_source, source)
  const profileId = `crm-${source.commit.slice(0, 12)}-gravity-source-v1`
  assert.deepEqual(document.release, {
    seal_sha256: sha256(rawSeal),
    bootstrap_tar_sha256: seal.built_artifacts.bootstrap_tar.sha256,
    debian_package_sha256: seal.built_artifacts.deb.sha256,
    package_version: '2.0.0-10',
    runtime_abi: '2.0.0',
    profile_id: profileId,
  })
  const observations = exactObject(document.observations, [
    'installed_version', 'installed_self_check', 'preflight', 'activation',
    'steady_state_version', 'steady_state_self_check', 'steady_state_audit',
    'steady_state_database', 'gravity', 'telegram',
  ], 'production observations')
  assert.equal(document.capture_transcript_sha256, sha256(canonicalBytes(observations)))
  assert.equal(document.secret_values_emitted, false)
  assert.equal(document.production_mutated_by_acceptance_capture, false)
  for (const observation of Object.values(observations)) {
    const age = (Date.parse(document.captured_at) - Date.parse(observation.captured_at)) / 1000
    assert.equal(age >= 0 && age <= MAX_PRODUCTION_EVIDENCE_AGE_SECONDS, true, 'production observation is stale or from the future')
  }

  for (const key of ['installed_version', 'steady_state_version']) {
    const evidence = verifyRuntimeResponse(observations[key], 'version')
    assert.equal(evidence.package_version, '2.0.0-10', 'Runtime v9/stale production observation is forbidden')
    assert.equal(evidence.runtime_version, '2.0.0')
    assert.equal(evidence.activation_profile, profileId)
  }
  for (const key of ['installed_self_check', 'steady_state_self_check']) {
    const evidence = verifyRuntimeResponse(observations[key], 'self-check')
    assert.equal(evidence.package_version, '2.0.0-10')
    assert.equal(evidence.runtime_version, '2.0.0')
    assert.equal(evidence.activation_profile_id, profileId)
    assert.equal(evidence.generic_command_execution, false)
    assert.equal(evidence.arbitrary_paths, false)
    assert.equal(evidence.arbitrary_package_install, false)
    assert.equal(evidence.docker_socket_delegated, false)
  }
  const preflight = verifyRuntimeResponse(observations.preflight, 'release-preflight')
  assert.equal(preflight.profile_id, profileId)
  assert.equal(['PREFLIGHT_READY_DATABASE_ALREADY_MIGRATED', 'ALREADY_PREFLIGHTED'].includes(preflight.status), true)
  const activation = verifyRuntimeResponse(observations.activation, 'release-activate')
  assert.equal(activation.profile_id, profileId)
  assert.equal(['ACTIVATED', 'ACTIVATED_RECOVERED', 'ALREADY_ACTIVATED'].includes(activation.status), true)
  assert.equal(activation.automatic_rollback ?? false, false)
  const postcheck = activation.postcheck
  assert.equal(postcheck?.healthy, true)
  assert.equal(postcheck?.running, true)
  assert.equal(postcheck?.semantics_preserved, true)
  assert.equal(postcheck?.unrelated_containers_unchanged, true)
  for (const key of [
    'protected_messages_transport_inventory_exact', 'protected_messages_transport_ready',
    'protected_messages_delivery_failures_absent', 'protected_messages_retry_failures_absent',
    'protected_messages_integrity_issues_absent', 'protected_messages_route_contract_exact',
    'outbox_publisher_startup_observed', 'tg_bot_internal_api_reachable',
    'tg_bot_patch_metadata_exact',
  ]) assert.equal(postcheck?.[key], true, `production postcheck missing ${key}`)

  const audit = verifyRuntimeResponse(observations.steady_state_audit, 'audit-status')
  assert.equal(audit.state, 'VALID')
  assert.equal(Number.isInteger(audit.record_count) && audit.record_count > 0, true)
  assert.equal(SHA64.test(audit.last_digest), true)
  const database = verifyRuntimeResponse(observations.steady_state_database, 'database-status')
  assert.equal(database.profile_id, profileId)
  assert.equal(database.read_only, true)
  assert.equal(database.migration_state, 'APPROVED_OUTBOX_APPLIED')
  assert.equal(database.applied_migration_count, 62)
  assert.equal(database.canonical_active_map_exact, true)
  assert.equal(database.canonical_live_chronology_exact, true)
  assert.equal(database.interrupted_target_migrations, 0)
  assert.equal(database.rolled_back_target_migrations, 0)
  assert.equal(database.outbox_catalog_state, 'EXACT')
  assert.equal(database.secret_values_emitted, false)
  verifyLiveRows(database, seal)
  const counts = database.outbox_counts
  assert.equal(Number.isInteger(counts?.total) && counts.total >= 1, true)
  assert.equal(counts.published, counts.total)
  for (const key of ['pending', 'processing', 'retry_wait', 'dead_letter', 'stale_claimed', 'over_attempt_limit']) assert.equal(counts[key], 0)

  const gravity = verifyRuntimeResponse(observations.gravity, 'docker-inspect', 'crm.container.gravity_mvp')
  assert.equal(gravity.image_id, seal.gravity_image_artifact.image_id)
  assert.equal(gravity.oci_labels?.['org.opencontainers.image.revision'], source.commit)
  assert.equal(gravity.running, true)
  assert.equal(gravity.health, 'healthy')
  assert.equal(gravity.restart_count, 0)
  assert.equal(gravity.declared_user, 'app')
  const telegram = verifyRuntimeResponse(observations.telegram, 'docker-inspect', 'crm.container.telegram_bot')
  assert.equal(telegram.image_id, postcheck.tg_bot_image_id)
  assert.equal(telegram.running, true)
  assert.equal(telegram.health, 'healthy')
  assert.equal(telegram.restart_count, 0)
  assert.equal(postcheck.gravity_image_id, gravity.image_id)

  assert.deepEqual(document.known_non_gate_observation, {
    route: '/api/calls/stats',
    result: 'HTTP_500_PREEXISTING_NON_GATE_PRODUCT_DEFECT',
    classification: 'OUTSIDE_MODULAR_ARCHITECTURE_DOD',
    introduced_by_release: false,
    blocks_architecture_closure: false,
  })
}

function expectedFindingRows() {
  return FINDING_IDS.map((id) => ({
    id,
    status: 'CLOSED',
    evidence_file_ids: Object.keys(EVIDENCE_PATHS),
  }))
}

function expectedDodRows() {
  return DOD_IDS.map((canonical_id) => ({
    canonical_id,
    status: 'CLOSED',
    evidence_file_ids: Object.keys(EVIDENCE_PATHS),
  }))
}

export function isVerifiedClosure(value) {
  return value?.[CLOSURE_TOKEN] === true
}

export function verifyCleanRepositoryStatus(status) {
  assert.equal(status, '', 'final closure must verify from a clean evidence checkout, including untracked files')
}

export function verifyFinalClosureEvidence({
  closure,
  mapping,
  ledger,
  evidenceRaw,
  repository,
}) {
  exactObject(closure, [
    'schema', 'status', 'closed_at', 'accepted_source', 'evidence_commit',
    'evidence_files', 'review_separation', 'findings', 'canonical_dod',
    'known_non_gate_observation', 'external_project_rereview_satisfied',
  ], 'final closure')
  assert.equal(closure.schema, 'yoko.crm.external-rereview-final-closure.v1')
  assert.equal(closure.status, 'CLOSED_READY_FOR_INDEPENDENT_EXTERNAL_REREVIEW')
  utc(closure.closed_at, 'closure timestamp')
  const source = exactObject(closure.accepted_source, ['commit', 'tree'], 'accepted source')
  assert.equal(SHA40.test(source.commit), true)
  assert.equal(SHA40.test(source.tree), true)
  assert.deepEqual(source, repository.acceptedSource, 'closure accepted source differs from Git authority')

  const evidenceCommit = exactObject(closure.evidence_commit, [
    'accepted_source_is_parent', 'changed_paths',
  ], 'evidence commit')
  assert.equal(evidenceCommit.accepted_source_is_parent, true)
  assert.equal(repository.acceptedSourceIsParent, true, 'closure must be one evidence-only commit after accepted source')
  assert.deepEqual(evidenceCommit.changed_paths, FINAL_CHANGED_PATHS, 'evidence-only diff widening')
  assert.deepEqual(repository.changedPaths, FINAL_CHANGED_PATHS, 'Git evidence-only diff widening')

  assert.deepEqual(Object.keys(closure.evidence_files), Object.keys(EVIDENCE_PATHS))
  const evidence = {}
  for (const [id, expectedPath] of Object.entries(EVIDENCE_PATHS)) {
    const reference = exactObject(closure.evidence_files[id], ['path', 'sha256'], `${id} evidence reference`)
    assert.equal(reference.path, expectedPath)
    assert.equal(SHA64.test(reference.sha256), true)
    const raw = evidenceRaw[id]
    assert(raw, `missing final closure evidence bytes: ${id}`)
    assert.equal(sha256(raw), reference.sha256, `${id} evidence SHA mismatch`)
    evidence[id] = parseJsonRejectDuplicates(raw, id)
  }

  assert.deepEqual(closure.review_separation && Object.keys(closure.review_separation).sort(), ['executor_assertion', 'reviewer_assertion'])
  assert.notEqual(closure.review_separation.executor_assertion, closure.review_separation.reviewer_assertion, 'self-issued critic is forbidden')
  assert.equal(/^INTERNAL_EXECUTOR_[A-Z0-9_.:-]{3,120}$/u.test(closure.review_separation.executor_assertion), true)
  assert.equal(/^INTERNAL_CRITIC_[A-Z0-9_.:-]{3,120}$/u.test(closure.review_separation.reviewer_assertion), true)
  assert.deepEqual(closure.findings, expectedFindingRows(), 'exactly 7 findings must be CLOSED with complete evidence')
  assert.deepEqual(closure.canonical_dod, expectedDodRows(), 'exactly 22 canonical requirements must be CLOSED with complete evidence')
  assert.deepEqual(closure.known_non_gate_observation, {
    route: '/api/calls/stats',
    result: 'HTTP_500_PREEXISTING_NON_GATE_PRODUCT_DEFECT',
    classification: 'OUTSIDE_MODULAR_ARCHITECTURE_DOD',
    blocks_architecture_closure: false,
  })
  assert.equal(closure.external_project_rereview_satisfied, false)

  const acceptedRaw = evidenceRaw.accepted_source_record
  const sealRaw = evidenceRaw.runtime_release_seal
  const reviewRaw = evidenceRaw.internal_critic_review
  verifyAcceptanceRecord(evidence.accepted_source_record, source, repository)
  verifyCleanReproduction(evidence.local_clean_ci_execution, 'LOCAL_CLEAN_CHECKOUT', source, repository)
  verifyCleanReproduction(evidence.fresh_clean_ci_execution, 'FRESH_CLEAN_CHECKOUT', source, repository)
  assert.notEqual(
    evidence.local_clean_ci_execution.checkout.environment_id_sha256,
    evidence.fresh_clean_ci_execution.checkout.environment_id_sha256,
    'local and fresh clean reproductions must use distinct environments',
  )
  verifyReleaseSeal(evidence.runtime_release_seal, source, evidence.accepted_source_record, acceptedRaw)
  verifyInternalCritic(
    evidence.internal_critic_review,
    evidence.internal_critic_verification,
    reviewRaw,
    source,
    evidence.runtime_release_seal,
    closure.evidence_files.runtime_release_seal.sha256,
    closure,
    repository,
  )
  verifyOwnerBootstrap(
    evidence.runtime_owner_bootstrap,
    evidence.runtime_release_seal,
    evidence.internal_critic_verification,
  )
  verifyProductionAcceptance(evidence.runtime_production_acceptance, source, evidence.runtime_release_seal, sealRaw)
  const productionAge = (Date.parse(closure.closed_at) - Date.parse(evidence.runtime_production_acceptance.captured_at)) / 1000
  assert.equal(
    productionAge >= 0 && productionAge <= MAX_PRODUCTION_EVIDENCE_AGE_SECONDS,
    true,
    'Runtime v10 production snapshot is stale or newer than closure',
  )
  const evidenceCommitTime = Date.parse(repository.evidenceCommitTime)
  assert.equal(Number.isNaN(evidenceCommitTime), false, 'evidence commit time is invalid')
  const closureCommitDelta = (evidenceCommitTime - Date.parse(closure.closed_at)) / 1000
  assert.equal(closureCommitDelta >= 0 && closureCommitDelta <= 900, true, 'closure time is not fresh to the evidence commit')
  const productionCommitDelta = (evidenceCommitTime - Date.parse(evidence.runtime_production_acceptance.captured_at)) / 1000
  assert.equal(productionCommitDelta >= 0 && productionCommitDelta <= MAX_PRODUCTION_EVIDENCE_AGE_SECONDS, true, 'production evidence is stale to the evidence commit')

  assert.equal(mapping.requirements?.length, 22, 'closure mapping denominator drift')
  assert.equal(ledger.findings?.length, 7, 'closure ledger denominator drift')
  assert.deepEqual(mapping.requirements.map((row) => row.canonical_id), DOD_IDS)
  assert.deepEqual(ledger.findings.map((row) => row.id), FINDING_IDS)
  assert.equal(mapping.requirements.every((row) => row.current_status === 'CLOSED'), true, '7/22 partial closure is forbidden')
  assert.equal(ledger.findings.every((row) => row.status === 'CLOSED'), true, 'partial seven-finding closure is forbidden')

  return Object.freeze({
    [CLOSURE_TOKEN]: true,
    status: 'PASS',
    phase: 'FINAL_EVIDENCE_CLOSED',
    accepted_source: source,
    evidence_commit: repository.evidenceHead,
    external_findings_closed: 7,
    canonical_dod_closed: 22,
    authoritative_ci_controls_passed: 52,
    internal_attacks_passed: 8,
    production_migrations_active: 62,
  })
}

function git(root, args, encoding = 'utf8') {
  return execFileSync('git', args, { cwd: root, encoding, maxBuffer: 32 * 1024 * 1024 }).trim()
}

function gitBlob(root, commit, repositoryPath) {
  return execFileSync('git', ['show', `${commit}:${repositoryPath}`], {
    cwd: root,
    encoding: null,
    maxBuffer: 32 * 1024 * 1024,
  })
}

export async function verifyFinalClosureRepository(root, mapping, ledger, closureRaw) {
  const closure = parseJsonRejectDuplicates(closureRaw, 'final closure')
  const source = closure.accepted_source ?? {}
  assert.equal(SHA40.test(source.commit ?? ''), true)
  assert.equal(SHA40.test(source.tree ?? ''), true)
  assert.equal(git(root, ['rev-parse', `${source.commit}^{tree}`]), source.tree, 'accepted source tree mismatch')
  const head = git(root, ['rev-parse', 'HEAD^{commit}'])
  const headTree = git(root, ['rev-parse', 'HEAD^{tree}'])
  const parent = git(root, ['rev-parse', 'HEAD^'])
  const changedPaths = git(root, ['diff', '--name-only', '--no-renames', `${source.commit}..${head}`])
    .split('\n').filter(Boolean).sort()
  const status = git(root, ['status', '--porcelain', '--untracked-files=all'])
  verifyCleanRepositoryStatus(status)
  assert.equal(parent, source.commit, 'accepted source must be the direct parent of the evidence-only closure commit')
  assert.equal(git(root, ['merge-base', '--is-ancestor', source.commit, head]) === '', true)
  const repository = {
    acceptedSource: { commit: source.commit, tree: source.tree },
    acceptedSourceParent: git(root, ['rev-parse', `${source.commit}^`]),
    evidenceHead: { commit: head, tree: headTree },
    evidenceCommitTime: git(root, ['show', '-s', '--format=%cI', head]),
    acceptedSourceIsParent: parent === source.commit,
    changedPaths,
    workflowSha256: sha256(gitBlob(root, source.commit, WORKFLOW_PATH)),
    runnerSha256: sha256(gitBlob(root, source.commit, RUNNER_PATH)),
    validatorSha256: sha256(gitBlob(root, source.commit, INTERNAL_VALIDATOR_REPOSITORY_PATH)),
  }
  const evidenceRaw = {}
  for (const [id, repositoryPath] of Object.entries(EVIDENCE_PATHS)) {
    evidenceRaw[id] = await readFile(path.join(root, repositoryPath))
  }
  return verifyFinalClosureEvidence({ closure, mapping, ledger, evidenceRaw, repository })
}
