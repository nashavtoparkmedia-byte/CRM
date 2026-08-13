#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'

import {
  EVIDENCE_PATHS as FINAL_CLOSURE_EVIDENCE_PATHS,
  CLOSURE_PATH as FINAL_CLOSURE_PATH,
  TEMPLATE_PATH as FINAL_CLOSURE_TEMPLATE_PATH,
  isVerifiedClosure,
  parseJsonRejectDuplicates,
  verifyClosureTemplate,
  verifyFinalClosureRepository,
} from './verify-final-rereview-closure.mjs'

const ORIGINAL_SOURCE_SHA256 = '0f06b9369c107f970e3ff702b4e59c78614f991fde7eaace4ffd4ae7548d1f03'
const CAPTURE_PATHS = new Map([
  ['ORIGINAL_EXECUTION_CONTRACT_20260809', 'architecture/recovery/whole-project-dod/v2/sources/ORIGINAL_EXECUTION_CONTRACT_20260809.txt.gz.b64'],
  ['WHOLE_PROJECT_RECOVERY_CONTRACT_20260810', 'architecture/recovery/whole-project-dod/v2/sources/WHOLE_PROJECT_RECOVERY_CONTRACT_20260810.txt.gz.b64'],
  ['ARCHITECTURE_DECISIONS_ADR_0067_0068', 'architecture/recovery/whole-project-dod/v2/sources/ARCHITECTURE_DECISIONS_ADR_0067_0068.md.gz.b64'],
  ['EXTERNAL_REVIEW_CONTRACT_20260812', 'architecture/recovery/whole-project-dod/v2/sources/EXTERNAL_REVIEW_CONTRACT_20260812.txt.gz.b64'],
  ['EXTERNAL_REREVIEW_REMEDIATION_CONTRACT_20260813', 'architecture/recovery/whole-project-dod/v2/sources/EXTERNAL_REREVIEW_REMEDIATION_CONTRACT_20260813.txt.gz.b64'],
])
const CANONICAL_TEXT_SHA256 = '0b8310685245c8ba68a43bca33078338425c84c32674fef67d5111bc6ed8ef5e'
const ALLOWED_STATUSES = new Set([
  'CONFIRMED',
  'DISPROVEN_WITH_CURRENT_EVIDENCE',
  'IMPLEMENTED_NOT_ACCEPTED',
  'CLOSED',
  'BLOCKED_EXTERNAL_AUTH',
  'BLOCKED_IRREVERSIBLE',
  'BLOCKED_BUSINESS',
])
const ORIGINAL_TEXT = [
  'Each major domain has explicit owner.',
  'Data ownership is formalized.',
  'Foreign writes are eliminated or isolated behind an approved compatibility layer with explicit retirement plan.',
  'Cross-module interactions use declared versioned contracts.',
  'Provider implementations are isolated.',
  'Arbitrary domain modules do not read provider credentials.',
  'Critical async flows use reliable event/outbox mechanisms where justified.',
  'Reporting/read models are separated from write ownership.',
  'Architecture boundaries are automatically enforced.',
  'Forbidden imports/writes fail CI.',
  'Each major module can be developed in an isolated worktree.',
  'Parallel Codex tasks do not require one shared mutable workspace.',
  'Build/test pipelines are sufficiently isolated.',
  'Messages remains functionally stable.',
  'AI Calls active development is preserved.',
  'Production remains operational through incremental migration.',
  'No Big Bang cutover occurred.',
  'New modules can follow a standard module template.',
  'A change to Module A has a provably bounded blast radius.',
  'Architecture exists in code/CI, not only documents.',
  'Permanent project operator supports routine project-scoped privileged work without Owner SSH.',
  'Production source/artifact authority remains traceable.',
]
const RECOVERY_TEXT = [
  'explicit major domain ownership;',
  'formal data ownership;',
  'no uncontrolled foreign writes;',
  'versioned cross-module contracts;',
  'provider isolation;',
  'credential isolation;',
  'justified reliable async flows;',
  'read models separated from write ownership;',
  'automatic architecture enforcement;',
  'forbidden imports/writes fail CI;',
  'safe isolated module development;',
  'parallel worktree viability;',
  'protected Messages stability;',
  'AI Calls preservation;',
  'incremental production migration;',
  'no Big Bang;',
  'standard module template;',
  'bounded blast radius;',
  'architecture enforced by code/CI;',
  'routine privileged operation without Owner SSH;',
  'traceable production source authority.',
]
const RECOVERY_CANONICAL_IDS = [
  ...Array.from({ length: 12 }, (_, index) => canonicalId(index + 1)),
  ...Array.from({ length: 9 }, (_, index) => canonicalId(index + 14)),
]
const LEGACY_IDS = [
  ...Array.from({ length: 12 }, (_, index) => `FINAL-DOD-${String(index + 1).padStart(3, '0')}`),
  'FINAL-DOD-012A',
  'FINAL-DOD-012B',
  ...Array.from({ length: 5 }, (_, index) => `FINAL-DOD-${String(index + 13).padStart(3, '0')}`),
]
const LEGACY_CROSSWALK_SHA256 = '153e8a1ea9a482ad5eab16d5ab0a6e0ef06ab2b7c09bea947cfb262ace34193f'
const SOURCE_CATALOG_SHA256 = '12c30b3354f09323b1580db44f6aa5d1599ba541940b51b64839c5dee7dec588'
const AUTHORITY_RESOLUTION_SHA256 = '0293eec019fff77884317fe9a296081c37b9079182999cae309383ace9522008'
const REQUIREMENT_EVIDENCE_STATUS_SHA256 = '7dd251ae0567153285595e8e2f4ff814acb39f54ce29492fe820d9a94bb37b39'
const REQUIREMENT_INVARIANT_SHA256 = '7f6f62a2e610986c66c8f9a7b2b08d44237bb44b0240e0ca7d6061947521cbc9'
// Updated only with the complete, reviewed remediation ledger projection.  It
// intentionally remains a hard pin so edits to prose, evidence, status, or
// closure criteria cannot silently change the acceptance denominator.
const FINDING_LEDGER_SEMANTIC_SHA256 = '7c18fa8d3818d620b14aa32c340e282a27b998f7023a3d82cee9aca3b31ce18d'
const FINDING_LEDGER_INVARIANT_SHA256 = '535b6c9b0f74d026776fc0077f2bf7ab7e3f997ba81a0b16af2b891b0b6a07fe'
const SELF_REFERENTIAL_AUTHORITY_PATHS = new Set([
  'architecture/recovery/whole-project-dod/v2/ORIGINAL_DOD_CANONICAL_MAPPING.json',
  'architecture/recovery/whole-project-dod/v2/EXTERNAL_REREVIEW_REMEDIATION_LEDGER.json',
])
const EVIDENCE_MARKER_PREFIXES = [
  'NOT_APPLICABLE_DIRECTLY:',
  'PENDING_EXTERNAL_ACCEPTANCE:',
]
const SOURCE_RULES = new Map([
  ['ORIGINAL_EXECUTION_CONTRACT_20260809', { authority: 'CONTROLLING', mapping_required: true, requirement_count: 22, sha256: ORIGINAL_SOURCE_SHA256, bytes: 42342 }],
  ['CRM_ARCH_007R_SOURCE_GATE_CHECKLIST', { authority: 'HISTORICAL_NARROWER_EVIDENCE', mapping_required: false, requirement_count: 23, sha256: '9b2cacc993f1bfdddfc24ff8b7814a22b922035bbe1e75c7e411f1ee9b7eff7f', bytes: 2080 }],
  ['ARCHITECTURE_DECISIONS_ADR_0067_0068', { authority: 'SUPERSEDING_SCOPE_DECISION', mapping_required: false, requirement_count: 0, sha256: 'ab44b9210a1478a3bc232f544b02fba7c345ca021cb2be3b7fcbe1b93206ec1e', bytes: 47557 }],
  ['WHOLE_PROJECT_RECOVERY_CONTRACT_20260810', { authority: 'SUPERSEDING_EXECUTION_CONTRACT_NOT_ACCEPTANCE_REPLACEMENT', mapping_required: true, requirement_count: 21, sha256: 'f2279bbaa7793b8625e98d64d6cca2953d2eff5b2f15aa28aeab5303d7c632cc', bytes: 25111 }],
  ['CURRENT_RECOVERY_HANDOFF_20260812', { authority: 'CURRENT_STATE_NOT_ACCEPTANCE_CONTRACT', mapping_required: false, requirement_count: 0, sha256: 'e12e89b4f9edea17319f7e8fc814128eb4bbb918866b97d22a39b2a81e1cdb7d' }],
  ['ORIGINAL_DOD_RECOMPUTE_20260812', { authority: 'HISTORICAL_RECOMPUTE_NOT_DENOMINATOR', mapping_required: false, requirement_count: 19, sha256: 'b2ddfeea6f645414e3fe59eaa4be45a19929be4f66d59b8c25a79354e633f22a' }],
  ['EXTERNAL_REVIEW_CONTRACT_20260812', { authority: 'EXTERNAL_DENOMINATOR_ASSERTION_NOT_ACCEPTANCE_CONTRACT', mapping_required: false, requirement_count: 0, sha256: '8cba1cd27c4c49d1654f37ac4053fb7f889e8f2130273e3e10810d97093d1773', bytes: 7873 }],
  ['EXTERNAL_REREVIEW_REMEDIATION_CONTRACT_20260813', { authority: 'REMEDIATION_GAP_ASSERTION_NOT_ACCEPTANCE_CONTRACT', mapping_required: false, requirement_count: 0, sha256: '768118d664aaaceb0a3702c8bc8471940c8da0aefd62466a29972730edb0ca68', bytes: 23904 }],
])

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function canonicalId(ordinal) {
  return `ORIGINAL-DOD-${String(ordinal).padStart(3, '0')}`
}

export function verifyCapturedSourceBytes(mapping, sourceId, encodedCapture) {
  const source = (mapping.sources ?? []).find((candidate) => candidate.id === sourceId)
  assert(source, `captured source metadata is missing: ${sourceId}`)
  assert.equal(source.repository_byte_capture, CAPTURE_PATHS.get(sourceId), `repository byte capture path missing or drifted: ${sourceId}`)
  assert.equal(source.repository_byte_capture_encoding, 'base64(gzip-n(original-bytes))', `repository byte capture encoding drift: ${sourceId}`)
  assert.equal(Number.isInteger(source.bytes) && source.bytes > 0, true, `repository byte capture size metadata missing: ${sourceId}`)
  let bytes
  try {
    bytes = gunzipSync(Buffer.from(encodedCapture.replace(/\s/gu, ''), 'base64'))
  } catch (error) {
    throw new Error(`repository byte capture cannot be decoded: ${sourceId}`, { cause: error })
  }
  assert.equal(bytes.length, source.bytes, `repository byte capture size drift: ${sourceId}`)
  assert.equal(sha256(bytes), source.sha256, `repository byte capture hash drift: ${sourceId}`)
  return bytes
}

export function verifyCapturedControllingSource(mapping, encodedCapture) {
  const controlling = (mapping.sources ?? []).find((source) => source.id === 'ORIGINAL_EXECUTION_CONTRACT_20260809')
  assert(controlling, 'controlling source metadata is missing')
  const bytes = verifyCapturedSourceBytes(mapping, controlling.id, encodedCapture)
  assert.equal(controlling.sha256, ORIGINAL_SOURCE_SHA256, 'controlling source repository byte capture is not the pinned original')
  const normalized = bytes.toString('utf8').replaceAll('\r\n', '\n')
  const start = normalized.indexOf('# 60. DEFINITION OF DONE — WHOLE PROJECT')
  const end = normalized.indexOf('# 61. FINAL PROJECT ACCEPTANCE PACKAGE', start)
  assert(start >= 0 && end > start, 'controlling source Definition of Done section is missing')
  const extracted = [...normalized.slice(start, end).matchAll(/^([0-9]+)\. (.+)$/gmu)]
  assert.deepEqual(extracted.map((match) => Number(match[1])), Array.from({ length: 22 }, (_, index) => index + 1), 'controlling source Definition of Done ordinal denominator drift')
  assert.deepEqual(extracted.map((match) => match[2]), ORIGINAL_TEXT, 'controlling source Definition of Done text differs from canonical mapping')
  return { bytes: bytes.length, sha256: sha256(bytes), requirements: extracted.length }
}

export function verifyCapturedRecoverySource(mapping, encodedCapture) {
  const bytes = verifyCapturedSourceBytes(mapping, 'WHOLE_PROJECT_RECOVERY_CONTRACT_20260810', encodedCapture)
  const normalized = bytes.toString('utf8').replaceAll('\r\n', '\n')
  const start = normalized.indexOf('# 45. DEFINITION OF DONE REMAINS ORIGINAL')
  const end = normalized.indexOf('\n---', start)
  assert(start >= 0 && end > start, 'retained recovery Definition of Done section is missing')
  const extracted = [...normalized.slice(start, end).matchAll(/^\* (.+)$/gmu)].map((match) => match[1])
  assert.deepEqual(extracted, RECOVERY_TEXT, 'retained recovery Definition of Done text drift')
  return { bytes: bytes.length, sha256: sha256(bytes), requirements: extracted.length }
}

export function verifyCapturedAssertionSources(mapping, reviewCapture, remediationCapture) {
  const review = verifyCapturedSourceBytes(mapping, 'EXTERNAL_REVIEW_CONTRACT_20260812', reviewCapture).toString('utf8')
  const remediation = verifyCapturedSourceBytes(mapping, 'EXTERNAL_REREVIEW_REMEDIATION_CONTRACT_20260813', remediationCapture).toString('utf8')
  assert(review.includes('historical handoff listed 23 whole-project DoD requirements.'), 'external review 23-item assertion is missing')
  assert(remediation.includes('Current project Master Handoff separately contains a 23-item section titled:'), 'remediation Master Handoff assertion is missing')
  assert(remediation.includes('ORIGINAL WHOLE-PROJECT DEFINITION OF DONE'), 'remediation alleged 23-item title is missing')
  return { review_assertion: true, remediation_assertion: true }
}

export function verifyLegacyRecomputeCrosswalk(mapping, recompute) {
  assert.equal(recompute?.schema, 'yoko.crm.original-dod-recompute.v1', 'legacy recompute identity mismatch')
  assert.equal(recompute?.summary?.total, 19, 'legacy recompute source denominator drift')
  assert.deepEqual((recompute.findings ?? []).map((finding) => finding.id), LEGACY_IDS, 'legacy recompute source IDs/order drift')
  const crosswalk = mapping.legacy_19_row_recompute_crosswalk ?? []
  assert.deepEqual(crosswalk.map((row) => row.legacy_id), LEGACY_IDS, 'legacy crosswalk IDs/order differ from pinned recompute')
  assert.equal(sha256(JSON.stringify(crosswalk)), LEGACY_CROSSWALK_SHA256, 'legacy recompute crosswalk semantic drift')
  return { rows: 19, source_bound: true }
}

function exactSummary(records, statuses) {
  return Object.fromEntries(statuses.map(([key, status]) => [
    key,
    records.filter((record) => record.current_status === status).length,
  ]))
}

function isEvidenceMarker(evidence) {
  return EVIDENCE_MARKER_PREFIXES.some((prefix) => evidence.startsWith(prefix))
}

function findingLedgerSemanticProjection(remediationLedger) {
  return (remediationLedger.findings ?? []).map((finding) => ({
    id: finding.id,
    title: finding.title,
    severity: finding.severity,
    violated_original_dod_items: finding.violated_original_dod_items,
    exact_reviewer_evidence: finding.exact_reviewer_evidence,
    current_reproduction_status: finding.current_reproduction_status,
    remediation: finding.remediation,
    tests: finding.tests,
    production_relevance: finding.production_relevance,
    closure_criterion: finding.closure_criterion,
    status: finding.status,
  }))
}

function requirementInvariantProjection(mapping) {
  return (mapping.requirements ?? []).map((requirement) => ({
    canonical_id: requirement.canonical_id,
    source_mappings: requirement.source_mappings,
    exact_original_text: requirement.exact_original_text,
    source_sha256: requirement.source_sha256,
    legacy_review_finding_ids: requirement.legacy_review_finding_ids,
    external_rereview_finding_ids: requirement.external_rereview_finding_ids,
    code_evidence: requirement.code_evidence,
    ci_evidence: requirement.ci_evidence,
  }))
}

function findingLedgerInvariantProjection(remediationLedger) {
  return (remediationLedger.findings ?? []).map((finding) => ({
    id: finding.id,
    title: finding.title,
    severity: finding.severity,
    violated_original_dod_items: finding.violated_original_dod_items,
    exact_reviewer_evidence: finding.exact_reviewer_evidence,
    remediation: finding.remediation,
    tests: finding.tests,
    production_relevance: finding.production_relevance,
    closure_criterion: finding.closure_criterion,
  }))
}

export function verifyOriginalDodCanonicalMapping(mapping, remediationLedger, finalClosureVerification = null) {
  assert.equal(mapping.schema, 'yoko.crm.original-dod-canonical-mapping.v1')
  assert.equal(mapping.mapping_policy, 'CONSERVATIVE_UNION_OF_DEMONSTRATED_AUTHORITATIVE_OR_SUPERSEDING_REQUIREMENTS')
  assert.equal(mapping.authority_resolution?.status, 'RESOLVED_TO_HASH_PINNED_ORIGINAL_22')
  assert.equal(mapping.authority_resolution?.controlling_source_id, 'ORIGINAL_EXECUTION_CONTRACT_20260809')
  assert.equal(mapping.canonical_denominator, 22, 'original DoD denominator drift')
  assert.equal(mapping.requirements?.length, 22, 'canonical requirement denominator drift')

  assert.deepEqual((mapping.sources ?? []).map((source) => source.id), [...SOURCE_RULES.keys()], 'DoD source catalog missing, reordered, or expanded without review')
  assert.equal(sha256(JSON.stringify(mapping.sources)), SOURCE_CATALOG_SHA256, 'DoD source path/chronology/scope/supersession catalog drift')
  assert.equal(sha256(JSON.stringify(mapping.authority_resolution)), AUTHORITY_RESOLUTION_SHA256, 'DoD authority-resolution decision drift')
  for (const source of mapping.sources ?? []) {
    const expected = SOURCE_RULES.get(source.id)
    assert(expected, `unreviewed DoD authority source: ${source.id}`)
    for (const [field, value] of Object.entries(expected)) assert.equal(source[field], value, `${source.id} ${field} drift`)
    if (CAPTURE_PATHS.has(source.id)) {
      assert.equal(source.repository_byte_capture, CAPTURE_PATHS.get(source.id), `${source.id} repository capture drift`)
      assert.equal(source.repository_byte_capture_encoding, 'base64(gzip-n(original-bytes))', `${source.id} capture encoding drift`)
    }
  }
  assert.deepEqual(mapping.authority_resolution?.alleged_master_handoff_23_item_source, {
    status: 'NOT_RECOVERED_AS_A_SEPARATE_ARTIFACT',
    assertion_source_ids: ['EXTERNAL_REVIEW_CONTRACT_20260812', 'EXTERNAL_REREVIEW_REMEDIATION_CONTRACT_20260813'],
    search_scope: 'current repository, all reachable Git history, local attachments, and Codex sessions',
    fail_closed_disposition: 'No exact requirement text can be invented. The assertion remains recorded; the only recovered 23-entry candidate is classified below and contributes no new whole-project requirement.',
  }, 'alleged Master Handoff 23-item disposition drift')

  const controllingSources = (mapping.sources ?? []).filter((source) => source.authority === 'CONTROLLING')
  assert.equal(controllingSources.length, 1, 'exactly one controlling DoD source is required')
  const controlling = controllingSources[0]
  assert.equal(controlling.id, 'ORIGINAL_EXECUTION_CONTRACT_20260809')
  assert.equal(controlling.sha256, ORIGINAL_SOURCE_SHA256, 'original execution contract hash drift')
  assert.equal(controlling.requirement_count, 22, 'controlling source denominator drift')
  assert.equal(controlling.mapping_required, true)

  const recoverySource = (mapping.sources ?? []).find((source) => source.id === 'WHOLE_PROJECT_RECOVERY_CONTRACT_20260810')
  assert(recoverySource, 'retained recovery contract source is missing')
  assert.equal(recoverySource.sha256, 'f2279bbaa7793b8625e98d64d6cca2953d2eff5b2f15aa28aeab5303d7c632cc')
  assert.equal(recoverySource.requirement_count, 21, 'retained recovery paraphrase denominator drift')
  assert.equal(recoverySource.mapping_required, true)

  const canonicalIds = mapping.requirements.map((requirement) => requirement.canonical_id)
  assert.equal(new Set(canonicalIds).size, 22, 'duplicate canonical requirement id')
  const sourceOrdinals = []
  const requirementStatuses = mapping.requirements.map((requirement) => requirement.current_status)
  const findingStatuses = (remediationLedger.findings ?? []).map((finding) => finding.status)
  const initialPhase = requirementStatuses.filter((status) => status === 'CLOSED').length === 5
    && requirementStatuses.filter((status) => status === 'IMPLEMENTED_NOT_ACCEPTED').length === 17
    && findingStatuses.every((status) => status === 'IMPLEMENTED_NOT_ACCEPTED')
  const closedPhase = requirementStatuses.length === 22
    && requirementStatuses.every((status) => status === 'CLOSED')
    && findingStatuses.length === 7
    && findingStatuses.every((status) => status === 'CLOSED')
  assert.equal(initialPhase || closedPhase, true, 'partial 7/22 closure transition is forbidden')
  if (closedPhase) assert.equal(isVerifiedClosure(finalClosureVerification), true, 'CLOSED status requires verified final closure evidence')
  else assert.equal(finalClosureVerification, null, 'PENDING source phase cannot carry final closure authorization')

  for (let index = 0; index < ORIGINAL_TEXT.length; index += 1) {
    const ordinal = index + 1
    const requirement = mapping.requirements[index]
    assert.equal(requirement.canonical_id, canonicalId(ordinal), `canonical id/order drift at original ordinal ${ordinal}`)
    assert.equal(requirement.exact_original_text, ORIGINAL_TEXT[index], `exact original text drift at ordinal ${ordinal}`)
    assert.equal(requirement.source_sha256, ORIGINAL_SOURCE_SHA256, `source hash drift at ordinal ${ordinal}`)
    assert.equal(requirement.source_mappings?.length, 1, `original ordinal ${ordinal} must map to exactly one canonical requirement`)
    const sourceMapping = requirement.source_mappings[0]
    assert.equal(sourceMapping.source_id, controlling.id, `wrong source mapping at ordinal ${ordinal}`)
    assert.equal(sourceMapping.ordinal, ordinal, `missing or moved original ordinal ${ordinal}`)
    assert.equal(sourceMapping.relation, 'EXACT', `non-exact original mapping at ordinal ${ordinal}`)
    sourceOrdinals.push(sourceMapping.ordinal)
    assert(ALLOWED_STATUSES.has(requirement.current_status), `${requirement.canonical_id} has invalid status`)
    for (const evidenceField of ['code_evidence', 'ci_evidence', 'runtime_production_evidence']) {
      assert.equal(Array.isArray(requirement[evidenceField]), true, `${requirement.canonical_id} lacks ${evidenceField}`)
      assert.equal(requirement[evidenceField].length > 0, true, `${requirement.canonical_id} has no ${evidenceField}`)
      assert.equal(requirement[evidenceField].every((entry) => typeof entry === 'string' && entry.length > 0), true, `${requirement.canonical_id} has invalid ${evidenceField}`)
      for (const evidence of requirement[evidenceField]) {
        assert.equal(
          SELF_REFERENTIAL_AUTHORITY_PATHS.has(evidence),
          false,
          `${requirement.canonical_id} has self-referential authority evidence in ${evidenceField}`,
        )
        if (isEvidenceMarker(evidence)) {
          assert.equal(
            evidenceField,
            'runtime_production_evidence',
            `${requirement.canonical_id} evidence marker is only valid for runtime/production evidence`,
          )
          assert.equal(
            requirement.current_status,
            'IMPLEMENTED_NOT_ACCEPTED',
            `${requirement.canonical_id} ${requirement.current_status} status cannot use an acceptance evidence marker`,
          )
        }
      }
    }
  }
  assert.deepEqual(sourceOrdinals, Array.from({ length: 22 }, (_, index) => index + 1), 'authoritative source ordinal mapping is incomplete or multiple')

  const productionAuthorityRequirement = mapping.requirements.find((requirement) => requirement.canonical_id === 'ORIGINAL-DOD-022')
  const runtimeTemplate = 'architecture/recovery/control-plane/v2/owner-bootstrap/crm-external-rereview-source-only-v10/templates/crm-activation-profile.py.in'
  const generatedRuntime = 'architecture/recovery/control-plane/v2/owner-bootstrap/crm-external-rereview-source-only-v10/src/crm-activation-profile.py'
  assert.equal(
    productionAuthorityRequirement?.code_evidence?.includes(runtimeTemplate),
    true,
    'ORIGINAL-DOD-022 must bind the canonical Runtime v10 template',
  )
  assert.equal(
    productionAuthorityRequirement?.code_evidence?.includes(generatedRuntime),
    false,
    'ORIGINAL-DOD-022 generated Runtime v10 artifact cannot replace its canonical template authority',
  )

  const requirementEvidenceStatus = mapping.requirements.map((requirement) => ({
    canonical_id: requirement.canonical_id,
    source_mappings: requirement.source_mappings,
    exact_original_text: requirement.exact_original_text,
    source_sha256: requirement.source_sha256,
    legacy_review_finding_ids: requirement.legacy_review_finding_ids,
    external_rereview_finding_ids: requirement.external_rereview_finding_ids,
    code_evidence: requirement.code_evidence,
    ci_evidence: requirement.ci_evidence,
    runtime_production_evidence: requirement.runtime_production_evidence,
    current_status: requirement.current_status,
  }))
  assert.equal(
    sha256(JSON.stringify(requirementInvariantProjection(mapping))),
    REQUIREMENT_INVARIANT_SHA256,
    'canonical requirement invariant semantic mapping drift',
  )
  if (initialPhase) {
    assert.equal(
      sha256(JSON.stringify(requirementEvidenceStatus)),
      REQUIREMENT_EVIDENCE_STATUS_SHA256,
      'canonical requirement evidence/status semantic mapping drift',
    )
  } else {
    const finalEvidencePaths = Object.values(FINAL_CLOSURE_EVIDENCE_PATHS)
    for (const requirement of mapping.requirements) {
      assert.deepEqual(
        requirement.runtime_production_evidence,
        finalEvidencePaths,
        `${requirement.canonical_id} CLOSED runtime/production evidence is not the exact final evidence set`,
      )
    }
  }

  const canonicalText = mapping.requirements
    .map((requirement) => `${requirement.canonical_id}\0${requirement.exact_original_text}`)
    .join('\n')
  assert.equal(sha256(canonicalText), CANONICAL_TEXT_SHA256, 'canonical DoD text digest drift')
  assert.equal(mapping.canonical_text_sha256, CANONICAL_TEXT_SHA256, 'recorded canonical text digest drift')

  const recoveryCrosswalk = mapping.retained_recovery_contract_21_item_crosswalk ?? []
  assert.equal(recoveryCrosswalk.length, 21, 'retained recovery crosswalk denominator drift')
  assert.deepEqual(
    recoveryCrosswalk.map((record) => record.source_ordinal),
    Array.from({ length: 21 }, (_, index) => index + 1),
    'retained recovery source ordinal mapping is incomplete or multiple',
  )
  assert.equal(new Set(recoveryCrosswalk.map((record) => record.source_ordinal)).size, 21, 'duplicate retained recovery source ordinal')
  for (let index = 0; index < recoveryCrosswalk.length; index += 1) {
    const record = recoveryCrosswalk[index]
    assert.equal(record.exact_source_text, RECOVERY_TEXT[index], `retained recovery ordinal ${record.source_ordinal} exact text drift`)
    assert.equal(record.canonical_id, RECOVERY_CANONICAL_IDS[index], `retained recovery ordinal ${record.source_ordinal} canonical mapping drift`)
    assert.equal(record.relation, 'PARAPHRASE', `retained recovery ordinal ${record.source_ordinal} relation drift`)
  }
  assert.equal(
    recoveryCrosswalk.some((record) => record.canonical_id === 'ORIGINAL-DOD-013'),
    false,
    'retained recovery paraphrase must not pretend to contain omitted original item 13',
  )
  assert.equal(mapping.conservative_union_analysis?.unique_requirements_added_beyond_original_22, 0)
  assert.equal(mapping.conservative_union_analysis?.original_requirement_missing_from_recovery_paraphrase, 'ORIGINAL-DOD-013')

  const legacyRows = mapping.legacy_19_row_recompute_crosswalk ?? []
  assert.equal(legacyRows.length, 19, 'legacy 19-row recompute crosswalk denominator drift')
  assert.equal(new Set(legacyRows.map((row) => row.legacy_id)).size, 19, 'duplicate legacy recompute row')
  for (const row of legacyRows) {
    assert.equal(Array.isArray(row.canonical_ids), true, `${row.legacy_id} lacks canonical_ids`)
    assert.equal(new Set(row.canonical_ids).size, row.canonical_ids.length, `${row.legacy_id} contains duplicate canonical mappings`)
    for (const id of row.canonical_ids) assert(canonicalIds.includes(id), `${row.legacy_id} maps to unknown canonical id ${id}`)
  }
  assert.deepEqual(legacyRows.map((row) => row.legacy_id), LEGACY_IDS, 'legacy recompute crosswalk IDs/order drift')
  assert.equal(sha256(JSON.stringify(legacyRows)), LEGACY_CROSSWALK_SHA256, 'legacy recompute crosswalk semantic drift')

  const requirementSummary = exactSummary(mapping.requirements, [
    ['closed', 'CLOSED'],
    ['implemented_not_accepted', 'IMPLEMENTED_NOT_ACCEPTED'],
    ['confirmed_open_gap', 'CONFIRMED'],
    ['disproven_with_current_evidence', 'DISPROVEN_WITH_CURRENT_EVIDENCE'],
    ['blocked_external_auth', 'BLOCKED_EXTERNAL_AUTH'],
    ['blocked_irreversible', 'BLOCKED_IRREVERSIBLE'],
    ['blocked_business', 'BLOCKED_BUSINESS'],
  ])
  assert.equal(mapping.summary?.canonical_total, 22, 'canonical summary denominator drift')
  assert.deepEqual(requirementSummary, Object.fromEntries(Object.keys(requirementSummary).map((key) => [key, mapping.summary?.[key]])), 'canonical all-status summary drift')
  assert.equal(Object.values(requirementSummary).reduce((total, count) => total + count, 0), mapping.canonical_denominator, 'canonical all-status summary does not cover the denominator')
  assert.equal(mapping.summary?.missing_authoritative_source_ordinals, 0)
  assert.equal(mapping.summary?.multiply_mapped_authoritative_source_ordinals, 0)
  assert.equal(mapping.summary?.canonical_rows_without_evidence, 0)

  assert.equal(remediationLedger.schema, 'yoko.crm.external-rereview-remediation-ledger.v1')
  assert.equal(remediationLedger.findings?.length, 7, 'external re-review finding denominator drift')
  const expectedFindingIds = Array.from({ length: 7 }, (_, index) => `EXTERNAL-REREVIEW-${String(index + 1).padStart(3, '0')}`)
  assert.deepEqual(remediationLedger.findings.map((finding) => finding.id), expectedFindingIds, 'missing, reordered, or duplicate external finding')
  for (const finding of remediationLedger.findings) {
    assert(ALLOWED_STATUSES.has(finding.status), `${finding.id} has invalid status`)
    for (const field of ['violated_original_dod_items', 'exact_reviewer_evidence', 'remediation', 'tests']) {
      assert.equal(Array.isArray(finding[field]), true, `${finding.id} lacks ${field}`)
      assert.equal(finding[field].length > 0, true, `${finding.id} has empty ${field}`)
    }
    assert.equal(
      new Set(finding.violated_original_dod_items).size,
      finding.violated_original_dod_items.length,
      `${finding.id} contains a duplicate original DoD reference`,
    )
    for (const id of finding.violated_original_dod_items) assert(canonicalIds.includes(id), `${finding.id} refers to unknown original DoD id ${id}`)
    for (const field of ['current_reproduction_status', 'production_relevance', 'closure_criterion']) {
      assert.equal(typeof finding[field], 'string', `${finding.id} lacks ${field}`)
      assert(finding[field].length > 0, `${finding.id} has empty ${field}`)
    }
    assert.equal(
      finding.tests.some((entry) => SELF_REFERENTIAL_AUTHORITY_PATHS.has(entry)),
      false,
      `${finding.id} has self-referential authority evidence in tests`,
    )
  }
  const ledgerFindingIdsByRequirement = new Map(canonicalIds.map((id) => [id, []]))
  for (const finding of remediationLedger.findings) {
    for (const id of finding.violated_original_dod_items) {
      ledgerFindingIdsByRequirement.get(id).push(finding.id)
    }
  }
  for (const requirement of mapping.requirements) {
    assert.deepEqual(
      requirement.external_rereview_finding_ids,
      ledgerFindingIdsByRequirement.get(requirement.canonical_id),
      `${requirement.canonical_id} bidirectional external finding crosswalk drift`,
    )
  }
  assert.equal(
    sha256(JSON.stringify(findingLedgerInvariantProjection(remediationLedger))),
    FINDING_LEDGER_INVARIANT_SHA256,
    'external finding ledger invariant semantic drift',
  )
  if (initialPhase) {
    assert.equal(
      sha256(JSON.stringify(findingLedgerSemanticProjection(remediationLedger))),
      FINDING_LEDGER_SEMANTIC_SHA256,
      'external finding ledger semantic drift',
    )
  } else {
    for (const finding of remediationLedger.findings) {
      assert.equal(
        finding.current_reproduction_status,
        'CLOSED_BY_EXACT_FINAL_CLOSURE_EVIDENCE_PENDING_NEW_EXTERNAL_REREVIEW',
        `${finding.id} closure transition statement drift`,
      )
    }
  }
  assert.deepEqual(
    remediationLedger.findings[0].violated_original_dod_items,
    canonicalIds,
    'Finding 1 must cover the entire original DoD denominator',
  )
  const ledgerCounts = Object.fromEntries([...ALLOWED_STATUSES].map((status) => [
    status.toLowerCase(),
    remediationLedger.findings.filter((finding) => finding.status === status).length,
  ]))
  assert.equal(remediationLedger.summary?.total, 7, 'external finding summary denominator drift')
  for (const [key, count] of Object.entries(ledgerCounts)) {
    assert.equal(remediationLedger.summary?.[key], count, `external finding status summary drift for ${key}`)
  }

  return {
    status: 'PASS',
    phase: closedPhase ? 'FINAL_EVIDENCE_CLOSED' : 'IMPLEMENTED_NOT_ACCEPTED',
    canonical_denominator: 22,
    authoritative_source_ordinals_mapped_exactly_once: 22,
    canonical_rows_with_code_ci_runtime_evidence: 22,
    legacy_recompute_rows_crosswalked: 19,
    external_findings_initialized: 7,
    external_finding_requirement_edges: [...ledgerFindingIdsByRequirement.values()]
      .reduce((count, findingIds) => count + findingIds.length, 0),
  }
}

async function verifyPinnedRepositorySources(root, mapping) {
  for (const source of mapping.sources ?? []) {
    if (path.isAbsolute(source.path)) continue
    const bytes = await readFile(path.join(root, source.path))
    assert.equal(sha256(bytes), source.sha256, `pinned source hash drift: ${source.path}`)
    if (source.bytes !== undefined) assert.equal(bytes.length, source.bytes, `pinned source byte-count drift: ${source.path}`)
  }
}

async function verifyExactRepositoryFile(root, repositoryPath, label) {
  assert.equal(path.isAbsolute(repositoryPath), false, `${label} must be repository-relative: ${repositoryPath}`)
  const resolvedRoot = path.resolve(root)
  const resolvedPath = path.resolve(resolvedRoot, repositoryPath)
  assert(
    resolvedPath.startsWith(`${resolvedRoot}${path.sep}`),
    `${label} escapes the repository: ${repositoryPath}`,
  )
  const metadata = await stat(resolvedPath).catch((error) => {
    throw new Error(`${label} does not exist: ${repositoryPath}`, { cause: error })
  })
  assert.equal(metadata.isFile(), true, `${label} must be an exact repository file: ${repositoryPath}`)
}

export async function verifyRepositoryEvidenceExists(root, mapping) {
  for (const requirement of mapping.requirements ?? []) {
    for (const evidenceField of ['code_evidence', 'ci_evidence', 'runtime_production_evidence']) {
      for (const evidence of requirement[evidenceField] ?? []) {
        if (isEvidenceMarker(evidence)) continue
        await verifyExactRepositoryFile(root, evidence, `${requirement.canonical_id} ${evidenceField} evidence`)
      }
    }
  }
}

export async function verifyRepositoryLedgerTestsExist(root, remediationLedger) {
  for (const finding of remediationLedger.findings ?? []) {
    for (const testPath of finding.tests ?? []) {
      await verifyExactRepositoryFile(root, testPath, `${finding.id} test path`)
    }
  }
}

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
  const mappingPath = path.resolve(process.argv[2] ?? path.join(
    root,
    'architecture/recovery/whole-project-dod/v2/ORIGINAL_DOD_CANONICAL_MAPPING.json',
  ))
  const ledgerPath = path.resolve(process.argv[3] ?? path.join(
    root,
    'architecture/recovery/whole-project-dod/v2/EXTERNAL_REREVIEW_REMEDIATION_LEDGER.json',
  ))
  const [mappingRaw, ledgerRaw, templateRaw] = await Promise.all([
    readFile(mappingPath),
    readFile(ledgerPath),
    readFile(path.join(root, FINAL_CLOSURE_TEMPLATE_PATH)),
  ])
  const mapping = parseJsonRejectDuplicates(mappingRaw, 'canonical DoD mapping')
  const ledger = parseJsonRejectDuplicates(ledgerRaw, 'external re-review remediation ledger')
  verifyClosureTemplate(parseJsonRejectDuplicates(templateRaw, 'final closure template'))
  const controlling = mapping.sources?.find((source) => source.id === 'ORIGINAL_EXECUTION_CONTRACT_20260809')
  assert(controlling?.repository_byte_capture, 'controlling source repository byte capture is missing')
  const captures = new Map()
  for (const source of mapping.sources?.filter((candidate) => candidate.repository_byte_capture) ?? []) {
    assert(source.repository_byte_capture, `mapping-required source repository byte capture is missing: ${source.id}`)
    const encodedCapture = await readFile(path.join(root, source.repository_byte_capture), 'utf8')
    captures.set(source.id, encodedCapture)
    if (source.id === controlling.id) verifyCapturedControllingSource(mapping, encodedCapture)
    else verifyCapturedSourceBytes(mapping, source.id, encodedCapture)
  }
  verifyCapturedRecoverySource(mapping, captures.get('WHOLE_PROJECT_RECOVERY_CONTRACT_20260810'))
  verifyCapturedAssertionSources(
    mapping,
    captures.get('EXTERNAL_REVIEW_CONTRACT_20260812'),
    captures.get('EXTERNAL_REREVIEW_REMEDIATION_CONTRACT_20260813'),
  )
  await verifyPinnedRepositorySources(root, mapping)
  const recompute = JSON.parse(await readFile(path.join(root, 'architecture/recovery/whole-project-dod/v2/ORIGINAL_DOD_RECOMPUTE_20260812.json'), 'utf8'))
  verifyLegacyRecomputeCrosswalk(mapping, recompute)
  await Promise.all([
    verifyRepositoryEvidenceExists(root, mapping),
    verifyRepositoryLedgerTestsExist(root, ledger),
  ])
  const closureRaw = await readFile(path.join(root, FINAL_CLOSURE_PATH)).catch((error) => {
    if (error?.code === 'ENOENT') return null
    throw error
  })
  const finalClosureVerification = closureRaw === null
    ? null
    : await verifyFinalClosureRepository(root, mapping, ledger, closureRaw)
  process.stdout.write(`${JSON.stringify(verifyOriginalDodCanonicalMapping(mapping, ledger, finalClosureVerification), null, 2)}\n`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`)
    process.exitCode = 1
  })
}
