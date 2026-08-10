#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { extractPrismaWrites, scanArchitecture } from './enforce-architecture.mjs'

const root = process.cwd()
const read = (relative) => readFileSync(path.join(root, relative), 'utf8')
const readJson = (relative) => JSON.parse(read(relative))
const failures = []
const checks = []

function stable(value) {
  if (Array.isArray(value)) return value.map(stable)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]))
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex')
}

function sha256(relative) {
  return createHash('sha256').update(read(relative)).digest('hex')
}

function equalMembers(left, right) {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort())
}

function check(name, condition, detail) {
  if (condition) checks.push(name)
  else failures.push({ check: name, detail })
}

const actionsPath = 'gravity-mvp/src/app/settings/ai/actions.ts'
const adapterPath =
  'gravity-mvp/src/modules/ai-knowledge/public/v1/legacy-prisma-knowledge-governance-adapter.ts'
const amendmentPath =
  'architecture/isolation/ai-knowledge/governance-v1/module-manifest-amendments.json'
const expectedDigest = '75ecd722872a5613d31c1f7ab831db364d6954a585b12ccf565e5366c22052d4'
const expectedCounts = {
  direct_foreign_prisma_write: 53,
  direct_provider_transport_access: 38,
  internal_module_import: 374,
  non_public_cross_context_import: 530,
  undeclared_dependency: 353,
}
const retiredFingerprints = [
  'arch_0252c770de7d64ed509a7cb7',
  'arch_a4ac437ee63612be542c41f1',
  'arch_f37918ffece45c8c2fac640a',
  'arch_a8885d8a8444133b24aa4790',
  'arch_40e29e1dc58883bbea5c2312',
  'arch_017d9d9a4052bc6ff85426d3',
  'arch_6e704450d240b6f310703d33',
  'arch_329f8e630093dcd104500072',
  'arch_6b9f9aba5e753e8235faef55',
  'arch_8340aef56bce44a43296b0c5',
  'arch_983191f225c8517cf1f6e47f',
  'arch_75fa299364aff057fff8879d',
  'arch_6e29944bcf94cdb964274720',
]
const governanceCommands = [
  ['EDIT_GOVERNANCE_KNOWLEDGE_ITEM_COMMAND_V1', 'editGovernanceKnowledgeItemV1'],
  ['ARCHIVE_GOVERNANCE_KNOWLEDGE_ITEM_COMMAND_V1', 'archiveGovernanceKnowledgeItemV1'],
  ['RESTORE_GOVERNANCE_KNOWLEDGE_ITEM_COMMAND_V1', 'restoreGovernanceKnowledgeItemV1'],
  ['VERIFY_GOVERNANCE_KNOWLEDGE_ITEM_COMMAND_V1', 'verifyGovernanceKnowledgeItemV1'],
  ['UNVERIFY_GOVERNANCE_KNOWLEDGE_ITEM_COMMAND_V1', 'unverifyGovernanceKnowledgeItemV1'],
  ['SUPERSEDE_GOVERNANCE_KNOWLEDGE_ITEM_COMMAND_V1', 'supersedeGovernanceKnowledgeItemV1'],
  ['ARCHIVE_KNOWLEDGE_CONFLICT_MEMBER_COMMAND_V1', 'archiveKnowledgeConflictMemberV1'],
  ['CLEAR_KNOWLEDGE_CONFLICT_WINNER_COMMAND_V1', 'clearKnowledgeConflictWinnerV1'],
  ['CLEAR_KNOWLEDGE_CONFLICT_GROUP_COMMAND_V1', 'clearKnowledgeConflictGroupV1'],
  ['CREATE_MANUAL_GOVERNANCE_KNOWLEDGE_ITEM_COMMAND_V1', 'createManualGovernanceKnowledgeItemV1'],
  ['MARK_KNOWLEDGE_ITEM_SOURCES_DISABLED_COMMAND_V1', 'markKnowledgeItemSourcesDisabledV1'],
  ['ARCHIVE_KNOWLEDGE_ITEM_AFTER_SOURCE_DISABLE_COMMAND_V1', 'archiveKnowledgeItemAfterSourceDisableV1'],
  ['ARCHIVE_KNOWLEDGE_ITEM_FOR_CORE_RESET_COMMAND_V1', 'archiveKnowledgeItemForCoreResetV1'],
]

const scan = await scanArchitecture(root)
const findingDigest = digest(scan.findings)
const byRule = Object.fromEntries(
  [...new Set(scan.findings.map((finding) => finding.rule))].sort().map((rule) => [
    rule,
    scan.findings.filter((finding) => finding.rule === rule).length,
  ]),
)

check(
  'candidate architecture scan is the exact reviewed successor state',
  scan.findings.length === 1348
    && scan.scanned_files === 1011
    && scan.contexts === 16
    && JSON.stringify(byRule) === JSON.stringify(expectedCounts)
    && findingDigest === expectedDigest,
  { findings: scan.findings.length, scanned_files: scan.scanned_files, contexts: scan.contexts, by_rule: byRule, finding_digest: findingDigest },
)
check(
  'candidate scan has no unexceptionable dependency cycle or integrity finding',
  !scan.findings.some((finding) => scan.policy.unexceptionable_rules.includes(finding.rule)),
  scan.findings.filter((finding) => scan.policy.unexceptionable_rules.includes(finding.rule)),
)

const registry = readJson(scan.policy.exception_registry)
const currentIds = new Set(scan.findings.map((finding) => finding.fingerprint))
const registryIds = new Set(registry.exceptions.map((exception) => exception.fingerprint))
const additions = [...currentIds].filter((fingerprint) => !registryIds.has(fingerprint)).sort()
const stale = [...registryIds].filter((fingerprint) => !currentIds.has(fingerprint)).sort()
const normalized = stale.length === 0
const acceptedStaleState = normalized || equalMembers(stale, retiredFingerprints)

check(
  'exception registry identity remains bound to the enforcement policy',
  registry.schema === 'yoko.crm.architecture-exception-registry.v1'
    && registry.version === 1
    && registry.milestone === scan.policy.registry_milestone
    && registry.base_commit === scan.policy.registry_base_commit
    && registry.policy?.exact_fingerprint_only === true
    && registry.policy?.stale_exceptions_fail === true
    && registry.policy?.expired_exceptions_fail === true
    && registry.policy?.uncovered_violations_fail === true
    && registry.policy?.deadline === scan.policy.exception_review_deadline,
  { registry, policy: scan.policy },
)
check('candidate introduces no architecture exception', additions.length === 0, additions)
check(
  'registry is either the exact frozen 13-retirement predecessor or its normalized successor',
  acceptedStaleState
    && registry.exceptions.length === scan.findings.length + stale.length
    && (!normalized || registry.finding_digest === expectedDigest),
  { stale, exceptions: registry.exceptions.length, finding_digest: registry.finding_digest },
)

const retiredRecords = registry.exceptions.filter((exception) => (
  retiredFingerprints.includes(exception.fingerprint)
))
check(
  'only the exact 13 reviewed Configuration writes are retirement candidates',
  retiredFingerprints.every((fingerprint) => !currentIds.has(fingerprint))
    && (normalized || retiredRecords.length === 13)
    && retiredRecords.every((exception) => (
      exception.rule === 'direct_foreign_prisma_write'
      && exception.file === actionsPath
      && exception.owner_context === 'configuration'
      && exception.target_context == null
    )),
  { stale, retired_records: retiredRecords },
)

const expectedRegistrySummary = { ...expectedCounts }
expectedRegistrySummary.direct_foreign_prisma_write += stale.length
check(
  'registry summary differs from the reviewed successor only by the frozen retirements',
  Object.entries(expectedRegistrySummary).every(([rule, count]) => registry.summary?.[rule] === count)
    && Object.keys(registry.summary ?? {}).length === Object.keys(expectedRegistrySummary).length,
  { expected: expectedRegistrySummary, actual: registry.summary },
)

const actions = read(actionsPath)
const actionWrites = extractPrismaWrites(actions)
const aiKnowledgeWrites = actionWrites.filter((write) => (
  write.model === 'aiKnowledgeItem' || write.tables?.includes('AiKnowledgeItem')
))
check(
  'Configuration caller invokes all 13 exact versioned owner commands',
  governanceCommands.length === 13
    && governanceCommands.every(([constant, runtime]) => (
      actions.includes(constant) && actions.includes(`${runtime}({`)
    )),
  governanceCommands.filter(([constant, runtime]) => (
    !actions.includes(constant) || !actions.includes(`${runtime}({`)
  )),
)
check(
  'Configuration caller contains no direct AiKnowledgeItem persistence write',
  aiKnowledgeWrites.length === 0,
  aiKnowledgeWrites,
)
check(
  'the 13 retired findings have no successor finding in the migrated caller',
  !scan.findings.some((finding) => (
    finding.file === actionsPath
    && finding.rule === 'direct_foreign_prisma_write'
    && (
      finding.details?.model === 'AiKnowledgeItem'
      || finding.details?.tables?.includes('AiKnowledgeItem')
    )
  )),
  scan.findings.filter((finding) => (
    finding.file === actionsPath
    && finding.rule === 'direct_foreign_prisma_write'
    && (
      finding.details?.model === 'AiKnowledgeItem'
      || finding.details?.tables?.includes('AiKnowledgeItem')
    )
  )),
)

const adapterWrites = extractPrismaWrites(read(adapterPath))
check(
  'all migrated persistence is static and isolated in the AI Knowledge owner adapter',
  adapterWrites.length === 27
    && adapterWrites.every((write) => (
      write.kind === 'raw'
      && write.method === '$executeRawUnsafe'
      && write.dynamic === false
      && JSON.stringify(write.tables) === JSON.stringify(['AiKnowledgeItem'])
    )),
  adapterWrites,
)

const policy = readJson('architecture/enforcement/v1/policy.json')
const amendmentDocument = readJson(amendmentPath)
const amendment = amendmentDocument.amendments?.[0]
const configuration = readJson('architecture/contexts/v1/manifests/configuration.json')
const expectedManifestCommands = governanceCommands.map(([constant]) => (
  `${constant.replace(/_COMMAND_V1$/, '').toLowerCase().split('_').map((part) => (
    part[0].toUpperCase() + part.slice(1)
  )).join('')}Command.v1`
))
check(
  'manifest amendment declares only the exact 13 governance commands',
  policy.manifest_amendments.includes(amendmentPath)
    && amendmentDocument.amendments.length === 1
    && amendment?.context === 'ai_knowledge'
    && equalMembers(amendment?.add_commands ?? [], expectedManifestCommands)
    && equalMembers(Object.keys(amendment ?? {}), ['context', 'add_commands', 'reason']),
  { amendment, expected_commands: expectedManifestCommands },
)
check(
  'existing Configuration to AI Knowledge public dependency is reused without expansion',
  configuration.allowed_dependencies.some((dependency) => (
    dependency.context === 'ai_knowledge' && dependency.surface === 'ai_knowledge.public'
  ))
    && !Object.keys(amendment ?? {}).some((key) => key.toLowerCase().includes('dependenc')),
  { allowed_dependencies: configuration.allowed_dependencies, amendment },
)

const trainerPath = 'gravity-mvp/src/app/messages/proposed-reply-actions.ts'
const trainer = read(trainerPath)
check(
  'protected UI and trainer lifecycle surfaces retain their reviewed identities',
  sha256('gravity-mvp/src/app/settings/ai/AiControlCenterClient.tsx')
      === '84c310bf76ac7538a10a5c3daedeae54a7a5576123835a094c88b6ae56734e94'
    && sha256(trainerPath)
      === '7a1acd91faf8140364321c8b0480fae7deec686abab3570646861ced9720ae59'
    && sha256('gravity-mvp/src/contracts/ai-knowledge/v1/knowledge-item-review-commands.ts')
      === '9d3b40f4f5d625330fd3ecb7aadfa64314c193a9e0c03b814e8df5845a1d581b'
    && sha256('gravity-mvp/src/modules/ai-knowledge/public/v1/knowledge-item-review-handler.ts')
      === 'd0fbb7c68365664d9744c5ec5c848461657b458cf613b15118d782546ea08bc6'
    && sha256('gravity-mvp/src/modules/ai-knowledge/public/v1/legacy-prisma-knowledge-item-review-adapter.ts')
      === '9e2a948d58df057a500f5bdf085fbd15bc090cc1ee153a238ad755b29a6c7d06'
    && trainer.includes('verifyKnowledgeItemV1({ contract: VERIFY_KNOWLEDGE_ITEM_COMMAND_V1')
    && !/VerifyGovernanceKnowledgeItem|verifyGovernanceKnowledgeItemV1/.test(trainer),
  'protected hash or trainer command drifted',
)

const result = {
  status: failures.length === 0 ? 'PASS' : 'FAIL',
  passed: checks.length,
  checks,
  failures,
  architecture: {
    findings: scan.findings.length,
    scanned_files: scan.scanned_files,
    contexts: scan.contexts,
    by_rule: byRule,
    finding_digest: findingDigest,
    registry_state: normalized ? 'normalized-successor' : 'frozen-pre-normalization',
    additions: additions.length,
    stale: stale.length,
  },
}

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
if (failures.length > 0) process.exitCode = 1
