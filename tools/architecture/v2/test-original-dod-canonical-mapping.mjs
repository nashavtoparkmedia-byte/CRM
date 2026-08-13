#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

import {
  verifyCapturedAssertionSources,
  verifyCapturedControllingSource,
  verifyCapturedRecoverySource,
  verifyCapturedSourceBytes,
  verifyLegacyRecomputeCrosswalk,
  verifyOriginalDodCanonicalMapping,
  verifyRepositoryEvidenceExists,
  verifyRepositoryLedgerTestsExist,
} from './verify-original-dod-canonical-mapping.mjs'
import {
  CLOSURE_PATH,
  EVIDENCE_PATHS,
  canonicalBytes,
  expectedValidatorIdentity,
  parseJsonRejectDuplicates,
  sha256,
  verifyClosureTemplate,
  verifyCleanRepositoryStatus,
  verifyFinalClosureEvidence,
} from './verify-final-rereview-closure.mjs'
import {
  controlIdCatalogSha256,
  normalizedControlCatalog,
  semanticControlCatalogSha256,
} from '../run-authoritative-ci.mjs'

const mapping = JSON.parse(await readFile(
  'architecture/recovery/whole-project-dod/v2/ORIGINAL_DOD_CANONICAL_MAPPING.json',
  'utf8',
))
const ledger = JSON.parse(await readFile(
  'architecture/recovery/whole-project-dod/v2/EXTERNAL_REREVIEW_REMEDIATION_LEDGER.json',
  'utf8',
))
const clone = (value) => structuredClone(value)
const capturedSource = await readFile(mapping.sources.find((source) => source.authority === 'CONTROLLING').repository_byte_capture, 'utf8')
const recoverySource = mapping.sources.find((source) => source.id === 'WHOLE_PROJECT_RECOVERY_CONTRACT_20260810')
const capturedRecovery = await readFile(recoverySource.repository_byte_capture, 'utf8')
const adrSource = mapping.sources.find((source) => source.id === 'ARCHITECTURE_DECISIONS_ADR_0067_0068')
const capturedAdr = await readFile(adrSource.repository_byte_capture, 'utf8')
const capturedReview = await readFile(mapping.sources.find((source) => source.id === 'EXTERNAL_REVIEW_CONTRACT_20260812').repository_byte_capture, 'utf8')
const capturedRemediation = await readFile(mapping.sources.find((source) => source.id === 'EXTERNAL_REREVIEW_REMEDIATION_CONTRACT_20260813').repository_byte_capture, 'utf8')
const recompute = JSON.parse(await readFile('architecture/recovery/whole-project-dod/v2/ORIGINAL_DOD_RECOMPUTE_20260812.json', 'utf8'))

assert.equal(verifyOriginalDodCanonicalMapping(mapping, ledger).status, 'PASS')
await verifyRepositoryEvidenceExists(process.cwd(), mapping)
await verifyRepositoryLedgerTestsExist(process.cwd(), ledger)
assert.deepEqual(verifyCapturedControllingSource(mapping, capturedSource), {
  bytes: 42342,
  sha256: '0f06b9369c107f970e3ff702b4e59c78614f991fde7eaace4ffd4ae7548d1f03',
  requirements: 22,
})
assert.throws(() => verifyCapturedControllingSource(mapping, `A${capturedSource.slice(1)}`), /cannot be decoded|size drift|hash drift/)
assert.equal(verifyCapturedSourceBytes(mapping, recoverySource.id, capturedRecovery).length, 25111)
assert.equal(verifyCapturedSourceBytes(mapping, adrSource.id, capturedAdr).length, 47557)
assert.equal(verifyCapturedRecoverySource(mapping, capturedRecovery).requirements, 21)
assert.deepEqual(verifyCapturedAssertionSources(mapping, capturedReview, capturedRemediation), { review_assertion: true, remediation_assertion: true })
assert.deepEqual(verifyLegacyRecomputeCrosswalk(mapping, recompute), { rows: 19, source_bound: true })
assert.throws(() => verifyCapturedSourceBytes(mapping, recoverySource.id, `A${capturedRecovery.slice(1)}`), /cannot be decoded|size drift|hash drift/)
const missingRecoveryCapture = clone(mapping)
delete missingRecoveryCapture.sources.find((source) => source.id === recoverySource.id).repository_byte_capture
assert.throws(() => verifyCapturedSourceBytes(missingRecoveryCapture, recoverySource.id, capturedRecovery), /path missing or drifted/)
const captureMetadataDrift = clone(mapping)
captureMetadataDrift.sources.find((source) => source.authority === 'CONTROLLING').bytes += 1
assert.throws(() => verifyCapturedControllingSource(captureMetadataDrift, capturedSource), /size drift/)

const denominatorDrift = clone(mapping)
denominatorDrift.canonical_denominator = 19
assert.throws(
  () => verifyOriginalDodCanonicalMapping(denominatorDrift, ledger),
  /denominator drift/,
)

const missingMapping = clone(mapping)
missingMapping.requirements[12].source_mappings = []
assert.throws(
  () => verifyOriginalDodCanonicalMapping(missingMapping, ledger),
  /map to exactly one canonical requirement/,
)

const multipleMapping = clone(mapping)
multipleMapping.requirements[12].source_mappings.push({
  source_id: 'ORIGINAL_EXECUTION_CONTRACT_20260809',
  ordinal: 13,
  relation: 'EXACT',
})
assert.throws(
  () => verifyOriginalDodCanonicalMapping(multipleMapping, ledger),
  /map to exactly one canonical requirement/,
)

const exactTextDrift = clone(mapping)
exactTextDrift.requirements[17].exact_original_text = 'New modules may follow a standard module template.'
assert.throws(
  () => verifyOriginalDodCanonicalMapping(exactTextDrift, ledger),
  /exact original text drift/,
)

const missingEvidence = clone(mapping)
missingEvidence.requirements[7].runtime_production_evidence = []
assert.throws(
  () => verifyOriginalDodCanonicalMapping(missingEvidence, ledger),
  /has no runtime_production_evidence/,
)

const generatedRuntimeAsAuthority = clone(mapping)
const productionAuthorityRequirement = generatedRuntimeAsAuthority.requirements.find((requirement) => requirement.canonical_id === 'ORIGINAL-DOD-022')
productionAuthorityRequirement.code_evidence = productionAuthorityRequirement.code_evidence.map((entry) => (
  entry.endsWith('/templates/crm-activation-profile.py.in')
    ? entry.replace('/templates/crm-activation-profile.py.in', '/src/crm-activation-profile.py')
    : entry
))
assert.throws(
  () => verifyOriginalDodCanonicalMapping(generatedRuntimeAsAuthority, ledger),
  /must bind the canonical Runtime v10 template|generated Runtime v10 artifact cannot replace/,
)

const recoveryParaphraseDrift = clone(mapping)
recoveryParaphraseDrift.retained_recovery_contract_21_item_crosswalk.pop()
assert.throws(
  () => verifyOriginalDodCanonicalMapping(recoveryParaphraseDrift, ledger),
  /retained recovery crosswalk denominator drift/,
)

const fabricatedRecovery = clone(mapping)
for (const record of fabricatedRecovery.retained_recovery_contract_21_item_crosswalk) {
  record.exact_source_text = 'fabricated text'
  record.canonical_id = 'ORIGINAL-DOD-001'
}
assert.throws(() => verifyOriginalDodCanonicalMapping(fabricatedRecovery, ledger), /exact text drift|canonical mapping drift/)

const emptyLegacyMappings = clone(mapping)
for (const row of emptyLegacyMappings.legacy_19_row_recompute_crosswalk) row.canonical_ids = []
assert.throws(() => verifyOriginalDodCanonicalMapping(emptyLegacyMappings, ledger), /semantic drift/)

const reclassifiedChecklist = clone(mapping)
const checklist = reclassifiedChecklist.sources.find((source) => source.id === 'CRM_ARCH_007R_SOURCE_GATE_CHECKLIST')
checklist.authority = 'SUPERSEDING_WHOLE_PROJECT_CONTRACT'
checklist.mapping_required = false
assert.throws(() => verifyOriginalDodCanonicalMapping(reclassifiedChecklist, ledger), /catalog drift|authority drift/)

const narrativeDrift = clone(mapping)
const controllingNarrative = narrativeDrift.sources.find((source) => source.id === 'ORIGINAL_EXECUTION_CONTRACT_20260809')
controllingNarrative.path = '/fabricated/contract.txt'
controllingNarrative.chronology = 'after every source'
controllingNarrative.scope = 'narrow checklist'
controllingNarrative.supersession = 'superseded by alleged 23'
assert.throws(() => verifyOriginalDodCanonicalMapping(narrativeDrift, ledger), /catalog drift/)

const authorityDecisionDrift = clone(mapping)
authorityDecisionDrift.authority_resolution.decision = 'the alleged 23 supersedes the recovered contract'
assert.throws(() => verifyOriginalDodCanonicalMapping(authorityDecisionDrift, ledger), /authority-resolution decision drift/)

const unreportedStatus = clone(mapping)
unreportedStatus.requirements[0].current_status = 'BLOCKED_BUSINESS'
unreportedStatus.summary.implemented_not_accepted -= 1
assert.throws(() => verifyOriginalDodCanonicalMapping(unreportedStatus, ledger), /partial 7\/22 closure transition|acceptance evidence marker|evidence\/status semantic mapping drift|all-status summary drift/)

const coherentFalseClosure = clone(mapping)
for (const requirement of coherentFalseClosure.requirements) requirement.current_status = 'CLOSED'
Object.assign(coherentFalseClosure.summary, {
  closed: 22,
  implemented_not_accepted: 0,
  confirmed_open_gap: 0,
  disproven_with_current_evidence: 0,
  blocked_external_auth: 0,
  blocked_irreversible: 0,
  blocked_business: 0,
})
assert.throws(() => verifyOriginalDodCanonicalMapping(coherentFalseClosure, ledger), /partial 7\/22 closure transition|acceptance evidence marker|evidence\/status semantic mapping drift/)

const circularEvidence = clone(mapping)
for (const requirement of circularEvidence.requirements) {
  requirement.code_evidence = ['architecture/recovery/whole-project-dod/v2/ORIGINAL_DOD_CANONICAL_MAPPING.json']
  requirement.ci_evidence = ['architecture/recovery/whole-project-dod/v2/ORIGINAL_DOD_CANONICAL_MAPPING.json']
  requirement.runtime_production_evidence = ['architecture/recovery/whole-project-dod/v2/ORIGINAL_DOD_CANONICAL_MAPPING.json']
}
assert.throws(() => verifyOriginalDodCanonicalMapping(circularEvidence, ledger), /self-referential authority evidence/)

const markerOnClosedRequirement = clone(mapping)
markerOnClosedRequirement.requirements.find((requirement) => requirement.current_status === 'CLOSED').runtime_production_evidence = [
  'PENDING_EXTERNAL_ACCEPTANCE: a closed requirement cannot defer acceptance',
]
assert.throws(
  () => verifyOriginalDodCanonicalMapping(markerOnClosedRequirement, ledger),
  /CLOSED status cannot use an acceptance evidence marker/,
)

const directoryEvidence = clone(mapping)
directoryEvidence.requirements[0].code_evidence = ['architecture/contexts/v1']
await assert.rejects(
  () => verifyRepositoryEvidenceExists(process.cwd(), directoryEvidence),
  /must be an exact repository file/,
)

const missingRepositoryEvidence = clone(mapping)
missingRepositoryEvidence.requirements[0].code_evidence = ['architecture/contexts/v1/not-a-real-evidence-file.json']
await assert.rejects(
  () => verifyRepositoryEvidenceExists(process.cwd(), missingRepositoryEvidence),
  /evidence does not exist/,
)

const missingFinding = clone(ledger)
missingFinding.findings.pop()
assert.throws(
  () => verifyOriginalDodCanonicalMapping(mapping, missingFinding),
  /external re-review finding denominator drift/,
)

const unknownDodReference = clone(ledger)
unknownDodReference.findings[1].violated_original_dod_items.push('ORIGINAL-DOD-023')
assert.throws(
  () => verifyOriginalDodCanonicalMapping(mapping, unknownDodReference),
  /unknown original DoD id/,
)

const asymmetricExternalFindingCrosswalk = clone(ledger)
asymmetricExternalFindingCrosswalk.findings[2].violated_original_dod_items.shift()
assert.throws(
  () => verifyOriginalDodCanonicalMapping(mapping, asymmetricExternalFindingCrosswalk),
  /bidirectional external finding crosswalk drift/,
)

const findingLedgerSemanticDrift = clone(ledger)
findingLedgerSemanticDrift.findings[1].remediation[0] = 'Self-authorized replacement remediation.'
assert.throws(
  () => verifyOriginalDodCanonicalMapping(mapping, findingLedgerSemanticDrift),
  /external finding ledger invariant semantic drift|external finding ledger semantic drift/,
)

const coherentFalseLedgerClosure = clone(ledger)
for (const finding of coherentFalseLedgerClosure.findings) {
  finding.status = 'CLOSED'
  finding.current_reproduction_status = 'CLOSED_BY_THIS_LEDGER'
  finding.remediation = ['Self-attested by the remediation ledger.']
  finding.tests = ['architecture/recovery/whole-project-dod/v2/EXTERNAL_REREVIEW_REMEDIATION_LEDGER.json']
  finding.closure_criterion = 'The remediation ledger declares itself closed.'
}
Object.assign(coherentFalseLedgerClosure.summary, {
  confirmed: 0,
  disproven_with_current_evidence: 0,
  implemented_not_accepted: 0,
  closed: 7,
  blocked_external_auth: 0,
  blocked_irreversible: 0,
  blocked_business: 0,
})
assert.throws(
  () => verifyOriginalDodCanonicalMapping(mapping, coherentFalseLedgerClosure),
  /partial 7\/22 closure transition|self-referential authority evidence/,
)

const directoryLedgerTest = clone(ledger)
directoryLedgerTest.findings[0].tests = ['tools/architecture/v2']
await assert.rejects(
  () => verifyRepositoryLedgerTestsExist(process.cwd(), directoryLedgerTest),
  /must be an exact repository file/,
)

const missingLedgerTest = clone(ledger)
missingLedgerTest.findings[0].tests = ['tools/architecture/v2/not-a-real-test.mjs']
await assert.rejects(
  () => verifyRepositoryLedgerTestsExist(process.cwd(), missingLedgerTest),
  /test path does not exist/,
)

const closureTemplate = parseJsonRejectDuplicates(
  await readFile('architecture/recovery/whole-project-dod/v2/FINAL_EXTERNAL_REREVIEW_CLOSURE.template.json'),
  'closure template test fixture',
)
assert.deepEqual(verifyClosureTemplate(closureTemplate), { status: 'PASS', phase: 'PENDING' })
assert.throws(
  () => parseJsonRejectDuplicates('{"schema":"one","schema":"two"}\n', 'duplicate closure fixture'),
  /duplicate JSON key/,
)
assert.notEqual(
  sha256(canonicalBytes({ value: '\u00e9' })),
  sha256(canonicalBytes({ value: '\uffe9' })),
  'UTF-8 closure canonicalization must not collapse distinct non-ASCII evidence',
)
assert.throws(() => verifyCleanRepositoryStatus('?? attacker-untracked.json'), /including untracked files/)

const catalog = normalizedControlCatalog().map(({ id }) => id)
const fixtureRaw = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'ascii')
const fixtureDigestWithoutNewline = (value) => createHash('sha256')
  .update(JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]]))
    : item))
  .digest('hex')

function buildFinalClosureFixture() {
  const acceptedSource = { commit: 'a'.repeat(40), tree: 'b'.repeat(40) }
  const evidenceHead = { commit: 'c'.repeat(40), tree: 'd'.repeat(40) }
  const rows = Array.from({ length: 62 }, (_, index) => ({
    observed_chronological_ordinal: index + 1,
    migration_id: `migration-${String(index + 1).padStart(2, '0')}`,
    migration_name: `20260813${String(index + 1).padStart(6, '0')}_fixture`,
    checksum: sha256(`migration-${index + 1}`),
    status: 'FINISHED_ACTIVE',
    started_at: '2026-08-13T16:00:00Z',
    finished_at: '2026-08-13T16:00:01Z',
    rolled_back_at: null,
    applied_steps_count: 1,
    logs_present: false,
    logs_bytes: null,
    logs_sha256: null,
  }))
  const acceptedChronologySha256 = fixtureDigestWithoutNewline(rows.map((row, index) => ({
    ordinal: index + 1,
    migration_name: row.migration_name,
    checksum: row.checksum,
  })))
  const repository = {
    acceptedSource,
    evidenceHead,
    evidenceCommitTime: '2026-08-13T18:11:00Z',
    acceptedSourceIsParent: true,
    changedPaths: [
      CLOSURE_PATH,
      'architecture/recovery/whole-project-dod/v2/FINAL_CLOSURE_TRANSITION_20260813.md',
      'architecture/recovery/whole-project-dod/v2/EXTERNAL_REREVIEW_REMEDIATION_LEDGER.json',
      'architecture/recovery/whole-project-dod/v2/ORIGINAL_DOD_CANONICAL_MAPPING.json',
      ...Object.values(EVIDENCE_PATHS),
    ].sort(),
    workflowSha256: 'e'.repeat(64),
    runnerSha256: 'f'.repeat(64),
    validatorSha256: 'd'.repeat(64),
  }
  const runId = 1001
  const architectureJob = 2001
  const artifactJob = 2002
  const artifactId = 3001
  const hosted = {
    schema: 'yoko.crm.hosted-authoritative-ci-attestation.v1',
    provider: 'github-actions',
    repository: 'nashavtoparkmedia-byte/CRM',
    source: acceptedSource,
    workflow: { path: '.github/workflows/architecture-enforcement.yml', sha256: repository.workflowSha256 },
    runner: { path: 'tools/architecture/run-authoritative-ci.mjs', sha256: repository.runnerSha256 },
    run: {
      id: runId,
      attempt: 1,
      url: `https://github.com/nashavtoparkmedia-byte/CRM/actions/runs/${runId}`,
      head_sha: acceptedSource.commit,
      conclusion: 'success',
    },
    check: {
      id: architectureJob,
      name: 'architecture',
      url: `https://github.com/nashavtoparkmedia-byte/CRM/actions/runs/${runId}/job/${architectureJob}`,
      head_sha: acceptedSource.commit,
      conclusion: 'success',
    },
    jobs: [
      {
        id: architectureJob,
        name: 'architecture',
        url: `https://github.com/nashavtoparkmedia-byte/CRM/actions/runs/${runId}/job/${architectureJob}`,
        head_sha: acceptedSource.commit,
        status: 'completed',
        conclusion: 'success',
      },
      {
        id: artifactJob,
        name: 'gravity-artifact',
        url: `https://github.com/nashavtoparkmedia-byte/CRM/actions/runs/${runId}/job/${artifactJob}`,
        head_sha: acceptedSource.commit,
        status: 'completed',
        conclusion: 'success',
      },
    ],
    artifact: {
      id: artifactId,
      name: `gravity-image-${acceptedSource.commit}`,
      url: `https://github.com/nashavtoparkmedia-byte/CRM/actions/runs/${runId}/artifacts/${artifactId}`,
      expired: false,
      size_in_bytes: 4096,
      digest: `sha256:${'1'.repeat(64)}`,
      workflow_run_id: runId,
      head_sha: acceptedSource.commit,
    },
    controls: {
      count: 52,
      catalog_sha256: controlIdCatalogSha256(),
      semantic_catalog_sha256: semanticControlCatalogSha256(),
      catalog,
    },
  }
  const acceptedRecord = {
    schema: 'yoko.crm.accepted-clean-release-commit.v2',
    status: 'ACCEPTED',
    commit: acceptedSource.commit,
    tree: acceptedSource.tree,
    authoritative_ci: hosted,
    source_only: true,
    migration_sql_change_from_7aea: false,
    schema_sync_to_production_authority: true,
    accepted_by: 'INDEPENDENT_SOURCE_ACCEPTANCE_CRITIC',
    accepted_at: '2026-08-13T17:30:00Z',
  }
  const executionProof = {
    schema: 'yoko.crm.authoritative-ci-execution-proof.v1',
    outcome: 'PASS',
    source: acceptedSource,
    workflow: hosted.workflow,
    runner: hosted.runner,
    runtime: { node: '20.20.2' },
    controls: {
      count: 52,
      catalog_sha256: controlIdCatalogSha256(),
      semantic_catalog_sha256: semanticControlCatalogSha256(),
      executions: catalog.map((id) => ({ id, status: 'PASS' })),
    },
  }
  const clean = (kind, environmentId) => ({
    schema: 'yoko.crm.clean-checkout-ci-reproduction.v1',
    status: 'PASS',
    kind,
    executed_at: kind === 'LOCAL_CLEAN_CHECKOUT' ? '2026-08-13T17:10:00Z' : '2026-08-13T17:20:00Z',
    source: acceptedSource,
    checkout: {
      head: acceptedSource.commit,
      tree: acceptedSource.tree,
      tracked_changes: 0,
      untracked_changes: 0,
      environment_id_sha256: environmentId,
    },
    generated_prerequisites: [
      'npm ci --prefix gravity-mvp --ignore-scripts',
      'npm ci --prefix tg-bot --ignore-scripts',
      'npm run --prefix gravity-mvp gen',
      'npm run --prefix tg-bot gen',
    ],
    execution_proof: executionProof,
  })
  const acceptedRaw = fixtureRaw(acceptedRecord)
  const seal = {
    schema: 'yoko.crm.source-only-release-seal.v2',
    status: 'SEALED',
    package_version: '2.0.0-10',
    runtime_abi: '2.0.0',
    profile_id: `crm-${acceptedSource.commit.slice(0, 12)}-gravity-source-v1`,
    commit: acceptedSource.commit,
    tree: acceptedSource.tree,
    accepted_builder_source: {
      prefix: 'architecture/recovery/control-plane/v2/owner-bootstrap/crm-external-rereview-source-only-v10',
      file_count: 40,
      inventory_sha256: '3'.repeat(64),
    },
    archive_sha256: '4'.repeat(64),
    acceptance_record_sha256: sha256(acceptedRaw),
    hosted_authoritative_ci: hosted,
    gravity_image_artifact: {
      image_id: `sha256:${'5'.repeat(64)}`,
      github_artifact: hosted.artifact,
    },
    production_snapshot_sha256: '6'.repeat(64),
    migration_authority_sha256: '7'.repeat(64),
    predecessor_attestation_sha256: '8'.repeat(64),
    canonical_migration_inventory_digest: '9'.repeat(64),
    accepted_live_chronology_sha256: acceptedChronologySha256,
    database_mutation_authorized: false,
    built_artifacts: {
      deb: { path: 'dist/runtime.deb', sha256: 'b'.repeat(64), bytes: 1024, mode: '0444' },
      bootstrap_tar: { path: 'dist/runtime.tar', sha256: 'c'.repeat(64), bytes: 2048, mode: '0444' },
    },
  }
  const sealRaw = fixtureRaw(seal)
  const attacks = [
    'clean-checkout-ci',
    'raw-credential-synthetic-bypass',
    'unauthorized-migration-write',
    'public-internal-facade-laundering',
    'overlapping-manifest-ownership',
    'stale-forbidden-dependency-plan',
    'missing-migration-provenance',
    'denominator-drift',
  ].map((id) => ({ id, status: 'PASS', evidence_sha256: sha256(id) }))
  const validator = expectedValidatorIdentity(repository)
  const review = {
    schema: 'yoko.crm.internal-runtime-bootstrap-review.v1',
    verdict: 'PASS',
    reviewer_assertion: 'INTERNAL_CRITIC_ADVERSARIAL_GATE',
    reviewed_at: '2026-08-13T17:55:00Z',
    separation_assertion: 'NOT_THE_EXECUTOR_AND_NOT_THE_POST_READY_EXTERNAL_REVIEWER',
    bindings: {
      source: acceptedSource,
      hosted_authoritative_ci: hosted,
      hosted_authoritative_ci_sha256: sha256(canonicalBytes(hosted)),
      sealed_release_sha256: sha256(sealRaw),
      bootstrap_tar: { sha256: seal.built_artifacts.bootstrap_tar.sha256 },
      debian_package: { sha256: seal.built_artifacts.deb.sha256 },
    },
    validator,
    attacks,
    residual_findings: [],
    repository_mutated_by_reviewer: false,
    production_mutated_by_reviewer: false,
  }
  const reviewRaw = fixtureRaw(review)
  const verification = {
    schema: 'yoko.crm.internal-runtime-bootstrap-review-verification.v1',
    status: 'PASS',
    reviewer_assertion: review.reviewer_assertion,
    reviewed_at: review.reviewed_at,
    internal_review_artifact_sha256: sha256(reviewRaw),
    sealed_release_sha256: sha256(sealRaw),
    bootstrap_tar_sha256: seal.built_artifacts.bootstrap_tar.sha256,
    debian_package_sha256: seal.built_artifacts.deb.sha256,
    hosted_authoritative_ci_sha256: sha256(canonicalBytes(hosted)),
    attack_catalog_sha256: sha256(canonicalBytes(attacks.map(({ id }) => id))),
    attack_execution_catalog_sha256: validator.attack_execution_catalog_sha256,
    attacks,
    validator,
    external_project_rereview_satisfied: false,
  }
  const owner = {
    schema: 'yoko.crm.source-only-owner-bootstrap.v1',
    status: 'ACCEPTED_WAITING_FOR_OWNER',
    seal,
    bootstrap_tar: { sha256: seal.built_artifacts.bootstrap_tar.sha256 },
    package: { sha256: seal.built_artifacts.deb.sha256, version: '2.0.0-10', runtime_abi: '2.0.0' },
    enabled_zero_argument_profiles: ['database-status', 'release-preflight', 'release-activate', 'rollback'],
    disabled_profiles: ['config-activate', 'database-migrate'],
    core_policy_sudoers_byte_identical: true,
    owner_command_authorized: true,
    owner_command: 'AUTHORIZED_OWNER_COMMAND '.repeat(10),
    self_issued_review_accepted: false,
    external_project_rereview_satisfied: false,
    internal_review_verification: verification,
  }
  const response = (primitive, evidence, resource = null, capturedAt = '2026-08-13T18:00:00Z') => {
    const payload = {
      schema: 'yoko.privileged-runtime.response.v1',
      runtime_version: '2.0.0',
      primitive,
      resource,
      ok: true,
      timestamp: capturedAt,
      evidence,
      warnings: [],
      errors: [],
    }
    return {
      captured_at: capturedAt,
      command: ['/usr/bin/sudo', '-n', '/usr/local/sbin/yoko-privileged-runtime', primitive, ...(resource ? [resource] : [])],
      response_sha256: sha256(canonicalBytes(payload)),
      response: payload,
    }
  }
  const profileId = seal.profile_id
  const versionEvidence = {
    package_version: '2.0.0-10', runtime_version: '2.0.0',
    response_schema: 'yoko.privileged-runtime.response.v1', activation_profile: profileId,
  }
  const selfCheckEvidence = {
    package_version: '2.0.0-10', runtime_version: '2.0.0', activation_profile_id: profileId,
    generic_command_execution: false, arbitrary_paths: false, arbitrary_package_install: false,
    docker_socket_delegated: false,
  }
  const databaseEvidence = {
    profile_id: profileId,
    read_only: true,
    migration_state: 'APPROVED_OUTBOX_APPLIED',
    applied_migration_count: 62,
    canonical_active_map_exact: true,
    canonical_live_chronology_exact: true,
    expected_live_chronology_sha256: seal.accepted_live_chronology_sha256,
    canonical_live_rows: rows,
    canonical_live_rows_sha256: fixtureDigestWithoutNewline(rows),
    interrupted_target_migrations: 0,
    rolled_back_target_migrations: 0,
    outbox_catalog_state: 'EXACT',
    outbox_counts: { total: 4, published: 4, pending: 0, processing: 0, retry_wait: 0, dead_letter: 0, stale_claimed: 0, over_attempt_limit: 0 },
    secret_values_emitted: false,
  }
  const postcheck = {
    gravity_image_id: seal.gravity_image_artifact.image_id,
    tg_bot_image_id: `sha256:${'6'.repeat(64)}`,
    healthy: true,
    running: true,
    semantics_preserved: true,
    unrelated_containers_unchanged: true,
    protected_messages_transport_inventory_exact: true,
    protected_messages_transport_ready: true,
    protected_messages_delivery_failures_absent: true,
    protected_messages_retry_failures_absent: true,
    protected_messages_integrity_issues_absent: true,
    protected_messages_route_contract_exact: true,
    outbox_publisher_startup_observed: true,
    tg_bot_internal_api_reachable: true,
    tg_bot_patch_metadata_exact: true,
  }
  const observations = {
    installed_version: response('version', versionEvidence),
    installed_self_check: response('self-check', selfCheckEvidence),
    preflight: response('release-preflight', { profile_id: profileId, status: 'PREFLIGHT_READY_DATABASE_ALREADY_MIGRATED' }),
    activation: response('release-activate', { profile_id: profileId, status: 'ACTIVATED', automatic_rollback: false, postcheck }),
    steady_state_version: response('version', versionEvidence),
    steady_state_self_check: response('self-check', selfCheckEvidence),
    steady_state_audit: response('audit-status', { state: 'VALID', record_count: 25, last_digest: '7'.repeat(64) }),
    steady_state_database: response('database-status', databaseEvidence),
    gravity: response('docker-inspect', {
      image_id: seal.gravity_image_artifact.image_id,
      oci_labels: { 'org.opencontainers.image.revision': acceptedSource.commit },
      running: true, health: 'healthy', restart_count: 0, declared_user: 'app',
    }, 'crm.container.gravity_mvp'),
    telegram: response('docker-inspect', {
      image_id: postcheck.tg_bot_image_id, running: true, health: 'healthy', restart_count: 0,
    }, 'crm.container.telegram_bot'),
  }
  const production = {
    schema: 'yoko.crm.runtime-v10-production-acceptance.v1',
    status: 'ACCEPTED',
    captured_at: '2026-08-13T18:00:00Z',
    host: 'jvxthcorvm',
    accepted_source: acceptedSource,
    release: {
      seal_sha256: sha256(sealRaw),
      bootstrap_tar_sha256: seal.built_artifacts.bootstrap_tar.sha256,
      debian_package_sha256: seal.built_artifacts.deb.sha256,
      package_version: '2.0.0-10', runtime_abi: '2.0.0', profile_id: profileId,
    },
    observations,
    capture_transcript_sha256: sha256(canonicalBytes(observations)),
    secret_values_emitted: false,
    production_mutated_by_acceptance_capture: false,
    known_non_gate_observation: {
      route: '/api/calls/stats', result: 'HTTP_500_PREEXISTING_NON_GATE_PRODUCT_DEFECT',
      classification: 'OUTSIDE_MODULAR_ARCHITECTURE_DOD', introduced_by_release: false,
      blocks_architecture_closure: false,
    },
  }
  const evidenceDocuments = {
    accepted_source_record: acceptedRecord,
    local_clean_ci_execution: clean('LOCAL_CLEAN_CHECKOUT', '1'.repeat(64)),
    fresh_clean_ci_execution: clean('FRESH_CLEAN_CHECKOUT', '2'.repeat(64)),
    runtime_release_seal: seal,
    runtime_owner_bootstrap: owner,
    runtime_production_acceptance: production,
    internal_critic_review: review,
    internal_critic_verification: verification,
  }
  const evidenceRaw = Object.fromEntries(Object.entries(evidenceDocuments).map(([id, document]) => [id, fixtureRaw(document)]))
  const closure = {
    schema: 'yoko.crm.external-rereview-final-closure.v1',
    status: 'CLOSED_READY_FOR_INDEPENDENT_EXTERNAL_REREVIEW',
    closed_at: '2026-08-13T18:10:00Z',
    accepted_source: acceptedSource,
    evidence_commit: {
      accepted_source_is_parent: true,
      changed_paths: repository.changedPaths,
    },
    evidence_files: Object.fromEntries(Object.entries(EVIDENCE_PATHS).map(([id, evidencePath]) => [id, {
      path: evidencePath,
      sha256: sha256(evidenceRaw[id]),
    }])),
    review_separation: {
      executor_assertion: 'INTERNAL_EXECUTOR_SOURCE_REMEDIATION',
      reviewer_assertion: review.reviewer_assertion,
    },
    findings: Array.from({ length: 7 }, (_, index) => ({
      id: `EXTERNAL-REREVIEW-${String(index + 1).padStart(3, '0')}`,
      status: 'CLOSED',
      evidence_file_ids: Object.keys(EVIDENCE_PATHS),
    })),
    canonical_dod: Array.from({ length: 22 }, (_, index) => ({
      canonical_id: `ORIGINAL-DOD-${String(index + 1).padStart(3, '0')}`,
      status: 'CLOSED',
      evidence_file_ids: Object.keys(EVIDENCE_PATHS),
    })),
    known_non_gate_observation: {
      route: '/api/calls/stats', result: 'HTTP_500_PREEXISTING_NON_GATE_PRODUCT_DEFECT',
      classification: 'OUTSIDE_MODULAR_ARCHITECTURE_DOD', blocks_architecture_closure: false,
    },
    external_project_rereview_satisfied: false,
  }
  const closedMapping = clone(mapping)
  for (const requirement of closedMapping.requirements) {
    requirement.current_status = 'CLOSED'
    requirement.runtime_production_evidence = Object.values(EVIDENCE_PATHS)
  }
  Object.assign(closedMapping.summary, { closed: 22, implemented_not_accepted: 0 })
  const closedLedger = clone(ledger)
  for (const finding of closedLedger.findings) {
    finding.status = 'CLOSED'
    finding.current_reproduction_status = 'CLOSED_BY_EXACT_FINAL_CLOSURE_EVIDENCE_PENDING_NEW_EXTERNAL_REREVIEW'
  }
  Object.assign(closedLedger.summary, { closed: 7, implemented_not_accepted: 0 })
  return { closure, mapping: closedMapping, ledger: closedLedger, evidenceRaw, repository, evidenceDocuments }
}

function replaceClosureEvidence(fixture, id, document) {
  fixture.evidenceDocuments[id] = document
  fixture.evidenceRaw[id] = fixtureRaw(document)
  fixture.closure.evidence_files[id].sha256 = sha256(fixture.evidenceRaw[id])
}

const validClosure = buildFinalClosureFixture()
const validClosureVerification = verifyFinalClosureEvidence(validClosure)
assert.equal(validClosureVerification.status, 'PASS')
assert.equal(
  verifyOriginalDodCanonicalMapping(validClosure.mapping, validClosure.ledger, validClosureVerification).phase,
  'FINAL_EVIDENCE_CLOSED',
)

const widenedEvidenceDiff = buildFinalClosureFixture()
widenedEvidenceDiff.repository.changedPaths.push('gravity-mvp/src/app/api/forbidden-change.ts')
widenedEvidenceDiff.repository.changedPaths.sort()
assert.throws(() => verifyFinalClosureEvidence(widenedEvidenceDiff), /evidence-only diff widening/)

const selfReferentialEvidenceCommit = buildFinalClosureFixture()
selfReferentialEvidenceCommit.closure.evidence_commit.commit = selfReferentialEvidenceCommit.repository.evidenceHead.commit
assert.throws(() => verifyFinalClosureEvidence(selfReferentialEvidenceCommit), /evidence commit exact-key mismatch/)

const hostedSourceMismatch = buildFinalClosureFixture()
const mismatchedAccepted = clone(hostedSourceMismatch.evidenceDocuments.accepted_source_record)
mismatchedAccepted.authoritative_ci.source.commit = '9'.repeat(40)
replaceClosureEvidence(hostedSourceMismatch, 'accepted_source_record', mismatchedAccepted)
assert.throws(() => verifyFinalClosureEvidence(hostedSourceMismatch), /hosted CI source SHA mismatch/)

const workflowShaMismatch = buildFinalClosureFixture()
const wrongWorkflow = clone(workflowShaMismatch.evidenceDocuments.accepted_source_record)
wrongWorkflow.authoritative_ci.workflow.sha256 = '0'.repeat(64)
replaceClosureEvidence(workflowShaMismatch, 'accepted_source_record', wrongWorkflow)
assert.throws(() => verifyFinalClosureEvidence(workflowShaMismatch), /hosted workflow SHA mismatch/)

const fiftyOneControls = buildFinalClosureFixture()
const reducedControls = clone(fiftyOneControls.evidenceDocuments.accepted_source_record)
reducedControls.authoritative_ci.controls.count = 51
reducedControls.authoritative_ci.controls.catalog.pop()
replaceClosureEvidence(fiftyOneControls, 'accepted_source_record', reducedControls)
assert.throws(() => verifyFinalClosureEvidence(fiftyOneControls), /exact ordered 52-control catalog/)

const reorderedControls = buildFinalClosureFixture()
const wrongOrder = clone(reorderedControls.evidenceDocuments.accepted_source_record)
;[wrongOrder.authoritative_ci.controls.catalog[0], wrongOrder.authoritative_ci.controls.catalog[1]] = [
  wrongOrder.authoritative_ci.controls.catalog[1], wrongOrder.authoritative_ci.controls.catalog[0],
]
replaceClosureEvidence(reorderedControls, 'accepted_source_record', wrongOrder)
assert.throws(() => verifyFinalClosureEvidence(reorderedControls), /exact ordered 52-control catalog/)

const runtimeV9 = buildFinalClosureFixture()
const staleRuntime = clone(runtimeV9.evidenceDocuments.runtime_production_acceptance)
for (const key of ['installed_version', 'steady_state_version']) {
  staleRuntime.observations[key].response.evidence.package_version = '2.0.0-9'
  staleRuntime.observations[key].response_sha256 = sha256(canonicalBytes(staleRuntime.observations[key].response))
}
staleRuntime.capture_transcript_sha256 = sha256(canonicalBytes(staleRuntime.observations))
replaceClosureEvidence(runtimeV9, 'runtime_production_acceptance', staleRuntime)
assert.throws(() => verifyFinalClosureEvidence(runtimeV9), /Runtime v9\/stale production observation/)

const substitutedGravityArtifact = buildFinalClosureFixture()
const tamperedSeal = clone(substitutedGravityArtifact.evidenceDocuments.runtime_release_seal)
tamperedSeal.gravity_image_artifact.github_artifact = {
  ...tamperedSeal.gravity_image_artifact.github_artifact,
  id: tamperedSeal.gravity_image_artifact.github_artifact.id + 1,
}
replaceClosureEvidence(substitutedGravityArtifact, 'runtime_release_seal', tamperedSeal)
assert.throws(
  () => verifyFinalClosureEvidence(substitutedGravityArtifact),
  /sealed Gravity artifact differs from the exact hosted CI artifact/,
)

const staleProduction = buildFinalClosureFixture()
const oldProduction = clone(staleProduction.evidenceDocuments.runtime_production_acceptance)
oldProduction.captured_at = '2020-01-01T00:00:00Z'
for (const observation of Object.values(oldProduction.observations)) {
  observation.captured_at = oldProduction.captured_at
  observation.response.timestamp = oldProduction.captured_at
  observation.response_sha256 = sha256(canonicalBytes(observation.response))
}
oldProduction.capture_transcript_sha256 = sha256(canonicalBytes(oldProduction.observations))
replaceClosureEvidence(staleProduction, 'runtime_production_acceptance', oldProduction)
assert.throws(() => verifyFinalClosureEvidence(staleProduction), /production snapshot is stale|production evidence is stale/)

const relabeledOldRuntimeResponse = buildFinalClosureFixture()
const relabeledProduction = clone(relabeledOldRuntimeResponse.evidenceDocuments.runtime_production_acceptance)
relabeledProduction.observations.installed_version.response.timestamp = '2026-08-13T17:59:54Z'
relabeledProduction.observations.installed_version.response_sha256 = sha256(
  canonicalBytes(relabeledProduction.observations.installed_version.response),
)
relabeledProduction.capture_transcript_sha256 = sha256(canonicalBytes(relabeledProduction.observations))
replaceClosureEvidence(relabeledOldRuntimeResponse, 'runtime_production_acceptance', relabeledProduction)
assert.throws(() => verifyFinalClosureEvidence(relabeledOldRuntimeResponse), /capture time is not bound to the Runtime response/)

const staleToEvidenceCommit = buildFinalClosureFixture()
staleToEvidenceCommit.repository.evidenceCommitTime = '2026-08-15T18:10:00Z'
assert.throws(() => verifyFinalClosureEvidence(staleToEvidenceCommit), /closure time is not fresh to the evidence commit|production evidence is stale to the evidence commit/)

const chronologySubstitution = buildFinalClosureFixture()
const substitutedProduction = clone(chronologySubstitution.evidenceDocuments.runtime_production_acceptance)
const databaseResponse = substitutedProduction.observations.steady_state_database.response
databaseResponse.evidence.canonical_live_rows[0].migration_name = '20990101000000_substituted'
databaseResponse.evidence.canonical_live_rows_sha256 = fixtureDigestWithoutNewline(databaseResponse.evidence.canonical_live_rows)
substitutedProduction.observations.steady_state_database.response_sha256 = sha256(canonicalBytes(databaseResponse))
substitutedProduction.capture_transcript_sha256 = sha256(canonicalBytes(substitutedProduction.observations))
replaceClosureEvidence(chronologySubstitution, 'runtime_production_acceptance', substitutedProduction)
assert.throws(() => verifyFinalClosureEvidence(chronologySubstitution), /live production chronology does not match the source-bound seal authority/)

const partialCanonicalClosure = buildFinalClosureFixture()
partialCanonicalClosure.mapping.requirements[21].current_status = 'IMPLEMENTED_NOT_ACCEPTED'
assert.throws(() => verifyFinalClosureEvidence(partialCanonicalClosure), /7\/22 partial closure/)

const selfIssuedCritic = buildFinalClosureFixture()
selfIssuedCritic.closure.review_separation.executor_assertion = selfIssuedCritic.closure.review_separation.reviewer_assertion
assert.throws(() => verifyFinalClosureEvidence(selfIssuedCritic), /self-issued critic/)

const forgedValidator = buildFinalClosureFixture()
const forgedReview = clone(forgedValidator.evidenceDocuments.internal_critic_review)
forgedReview.validator.sha256 = '0'.repeat(64)
replaceClosureEvidence(forgedValidator, 'internal_critic_review', forgedReview)
assert.throws(() => verifyFinalClosureEvidence(forgedValidator), /accepted-source exact validator/)

process.stdout.write('original DoD canonical mapping: PASS (42 fail-closed negative properties; two-phase closure PENDING)\n')
