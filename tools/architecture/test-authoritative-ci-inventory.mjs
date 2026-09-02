#!/usr/bin/env node

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  AUTHORITATIVE_BLAST_BASE,
  AUTHORITATIVE_NODE_VERSION,
  assertAuthoritativeRuntimeContract,
  assertCleanWorktree,
  assertExecutionProofIdentity,
  assertExecutionProofOutputAbsent,
  buildExecutionProof,
  captureExecutionProofIdentity,
  controlIdCatalogSha256,
  executeControlSequence,
  fullScanControls,
  normalizedControlCatalog,
  orderedControlsFor,
  semanticControlCatalogSha256,
  targetedControls,
} from './run-authoritative-ci.mjs'
import {
  assertNoInheritedGeneratedProducts,
  cleanCheckoutEnvironmentIdSha256,
} from './run-local-clean-acceptance.mjs'

function git(directory, args) {
  const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr || result.error?.message || `git ${args.join(' ')} failed`)
}

const cleanFixture = mkdtempSync(path.join(os.tmpdir(), 'yoko-authoritative-ci-cleanliness-'))
try {
  git(cleanFixture, ['init', '--quiet'])
  git(cleanFixture, ['config', 'user.email', 'authoritative-ci@example.invalid'])
  git(cleanFixture, ['config', 'user.name', 'Authoritative CI'])
  writeFileSync(path.join(cleanFixture, 'tracked.txt'), 'clean\n')
  mkdirSync(path.join(cleanFixture, '.github/workflows'), { recursive: true })
  mkdirSync(path.join(cleanFixture, 'tools/architecture'), { recursive: true })
  writeFileSync(path.join(cleanFixture, '.github/workflows/architecture-enforcement.yml'), 'workflow\n')
  writeFileSync(path.join(cleanFixture, 'tools/architecture/run-authoritative-ci.mjs'), 'runner\n')
  git(cleanFixture, ['add', 'tracked.txt', '.github/workflows/architecture-enforcement.yml', 'tools/architecture/run-authoritative-ci.mjs'])
  git(cleanFixture, ['commit', '--quiet', '-m', 'fixture'])
  writeFileSync(path.join(cleanFixture, 'baseline.txt'), 'parent for HEAD^\n')
  git(cleanFixture, ['add', 'baseline.txt'])
  git(cleanFixture, ['commit', '--quiet', '-m', 'fixture head'])
  assert.doesNotThrow(() => assertCleanWorktree(cleanFixture, 'fixture baseline'))
  const capturedIdentity = captureExecutionProofIdentity(cleanFixture)

  writeFileSync(path.join(cleanFixture, 'tracked.txt'), 'dirty\n')
  assert.throws(() => assertCleanWorktree(cleanFixture, 'dirty tracked fixture'), /clean worktree.*tracked\.txt/su)
  git(cleanFixture, ['checkout', '--', 'tracked.txt'])

  writeFileSync(path.join(cleanFixture, 'untracked.txt'), 'dirty\n')
  assert.throws(() => assertCleanWorktree(cleanFixture, 'dirty untracked fixture'), /clean worktree.*untracked\.txt/su)
  rmSync(path.join(cleanFixture, 'untracked.txt'))

  writeFileSync(path.join(cleanFixture, 'tracked.txt'), 'post-control drift\n')
  assert.throws(() => assertCleanWorktree(cleanFixture, 'immediately before execution proof'), /immediately before execution proof.*tracked\.txt/su)
  git(cleanFixture, ['add', 'tracked.txt'])
  git(cleanFixture, ['commit', '--quiet', '-m', 'head transition'])
  assert.throws(
    () => assertExecutionProofIdentity(capturedIdentity, cleanFixture, 'after fixture head transition'),
    /source identity drift .*: (?:commit|tree|parent)/u,
  )
} finally {
  rmSync(cleanFixture, { recursive: true, force: true })
}

assert.doesNotThrow(() => assertAuthoritativeRuntimeContract({ YOKO_BLAST_BASE: 'HEAD^' }, '20.20.2'))
assert.throws(
  () => assertAuthoritativeRuntimeContract({ YOKO_BLAST_BASE: 'HEAD^' }, '20.20.1'),
  /requires Node\.js 20\.20\.2/u,
)
assert.throws(
  () => assertAuthoritativeRuntimeContract({ YOKO_BLAST_BASE: 'HEAD^^' }, '20.20.2'),
  /requires YOKO_BLAST_BASE=HEAD\^/u,
)
assert.equal(AUTHORITATIVE_NODE_VERSION, '20.20.2')
assert.equal(AUTHORITATIVE_BLAST_BASE, 'HEAD^')
const proofOutputFixture = path.join(os.tmpdir(), `yoko-authoritative-ci-proof-${process.pid}.json`)
try {
  assert.doesNotThrow(() => assertExecutionProofOutputAbsent(proofOutputFixture))
  writeFileSync(proofOutputFixture, '{}\n')
  assert.throws(() => assertExecutionProofOutputAbsent(proofOutputFixture), /must not exist before authoritative CI/u)
  rmSync(proofOutputFixture)
  writeFileSync(`${proofOutputFixture}.new`, '{}\n')
  assert.throws(() => assertExecutionProofOutputAbsent(proofOutputFixture), /must not exist before authoritative CI/u)
} finally {
  rmSync(proofOutputFixture, { force: true })
  rmSync(`${proofOutputFixture}.new`, { force: true })
}

const generatedFixture = mkdtempSync(path.join(os.tmpdir(), 'yoko-local-clean-products-'))
try {
  git(generatedFixture, ['init', '--quiet'])
  mkdirSync(path.join(generatedFixture, 'node_modules'), { recursive: true })
  assert.throws(
    () => assertNoInheritedGeneratedProducts(generatedFixture),
    /no inherited node_modules or build products.*node_modules/su,
  )
  rmSync(path.join(generatedFixture, 'node_modules'), { recursive: true, force: true })
  mkdirSync(path.join(generatedFixture, 'arbitrary/inherited/node_modules'), { recursive: true })
  assert.throws(
    () => assertNoInheritedGeneratedProducts(generatedFixture),
    /no inherited node_modules or build products.*arbitrary\/inherited\/node_modules/su,
  )
  rmSync(path.join(generatedFixture, 'arbitrary'), { recursive: true, force: true })
  mkdirSync(path.join(generatedFixture, 'arbitrary/inherited/.next'), { recursive: true })
  assert.throws(
    () => assertNoInheritedGeneratedProducts(generatedFixture),
    /no inherited node_modules or build products.*arbitrary\/inherited\/\.next/su,
  )
  rmSync(path.join(generatedFixture, 'arbitrary'), { recursive: true, force: true })
  const inheritedTarget = mkdtempSync(path.join(os.tmpdir(), 'yoko-inherited-products-target-'))
  symlinkSync(inheritedTarget, path.join(generatedFixture, 'node_modules'), 'dir')
  assert.throws(
    () => assertNoInheritedGeneratedProducts(generatedFixture),
    /no inherited node_modules or build products.*node_modules/su,
  )
  rmSync(path.join(generatedFixture, 'node_modules'))
  symlinkSync(inheritedTarget, path.join(generatedFixture, '.next'), 'dir')
  assert.throws(
    () => assertNoInheritedGeneratedProducts(generatedFixture),
    /no inherited node_modules or build products.*\.next/su,
  )
  rmSync(path.join(generatedFixture, '.next'))
  rmSync(inheritedTarget, { recursive: true, force: true })
  const firstEnvironmentId = cleanCheckoutEnvironmentIdSha256(generatedFixture)
  const secondEnvironmentId = cleanCheckoutEnvironmentIdSha256(generatedFixture)
  assert.equal(
    firstEnvironmentId,
    secondEnvironmentId,
    'kind or replay-schema labels must not manufacture a distinct checkout environment identity',
  )
  assert.doesNotThrow(() => assertNoInheritedGeneratedProducts(generatedFixture))
} finally {
  rmSync(generatedFixture, { recursive: true, force: true })
}

function catalogDigest(controls) {
  return createHash('sha256').update(`${JSON.stringify({
    schema: 'yoko.crm.authoritative-ci-control-catalog.v1',
    controls,
  })}\n`).digest('hex')
}

function workflowStepRun(source, jobId, stepName) {
  const lines = source.split(/\r?\n/u)
  const jobStart = lines.findIndex((line) => line === `  ${jobId}:`)
  assert(jobStart >= 0, `workflow job missing: ${jobId}`)
  let inRequestedStep = false
  for (let index = jobStart + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (/^  [A-Za-z0-9_-]+:\s*$/u.test(line)) break
    const step = /^      - name: (.+)$/u.exec(line)
    if (step) {
      inRequestedStep = step[1] === stepName
      continue
    }
    if (!inRequestedStep) continue
    const run = /^        run: (.*)$/u.exec(line)
    if (run) return run[1]
  }
  throw new assert.AssertionError({ message: `workflow step run scalar missing: ${jobId}/${stepName}` })
}

function workflowJobStepNames(source, jobId) {
  const lines = source.split(/\r?\n/u)
  const jobStart = lines.findIndex((line) => line === `  ${jobId}:`)
  assert(jobStart >= 0, `workflow job missing: ${jobId}`)
  const names = []
  for (let index = jobStart + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (/^  [A-Za-z0-9_-]+:\s*$/u.test(line)) break
    if (!/^      - /u.test(line)) continue
    const step = /^      - name: (.+)$/u.exec(line)
    assert(step, `${jobId} contains an unnamed or structurally ambiguous step`)
    names.push(step[1])
  }
  return names
}

const ids = new Set([...targetedControls, ...fullScanControls].map(([id]) => id))
for (const required of [
  'authoritative-ci-inventory',
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
  'hosted-coordinated-gravity-max-stage-a',
  'production-migration-committed-runtime-inventory',
  'production-migration-canonical-replay',
  'production-migration-predecessor-recovery-replay',
  'architecture-policy',
  'architecture-negatives',
  'write-analyzer-negatives',
  'write-runner-negatives',
  'write-gate-negatives',
  'whole-repository-write-scan',
  'fresh-write-verification',
  'fresh-migration-write-site-authorizations',
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
  'whole-repository-credential-inventory',
  'fresh-credential-verification',
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
]) assert(ids.has(required), `missing authoritative CI control: ${required}`)

assert.equal(ids.size, targetedControls.length + fullScanControls.length, 'duplicate CI control id')
assert.equal(ids.size, 53, 'authoritative CI control catalog changed without an explicit inventory review')
const normalizedCatalog = normalizedControlCatalog()
assert.equal(normalizedCatalog.length, 53, 'normalized authoritative catalog must cover every control')
assert.equal(
  catalogDigest(normalizedCatalog),
  '57f6843147042cd851fe18ead45bda7c4b1e243d7f0a2c0e1d66ed2f2d410a8c',
  'authoritative CI command/order/argument/cwd catalog changed without an explicit full-catalog review',
)
assert.equal(semanticControlCatalogSha256(), '57f6843147042cd851fe18ead45bda7c4b1e243d7f0a2c0e1d66ed2f2d410a8c')
assert.equal(controlIdCatalogSha256(), 'f6271d9cba771e818913ad769be982420880dafe353e2ec9ff59682ebc281dc0')
const passingExecutions = normalizedCatalog.map(({ id }) => ({ id, status: 'PASS' }))
const proof = buildExecutionProof(passingExecutions, {
  commit: 'a'.repeat(40),
  tree: 'b'.repeat(40),
  parent: 'e'.repeat(40),
  workflow_sha256: 'c'.repeat(64),
  runner_sha256: 'd'.repeat(64),
})
assert.equal(proof.outcome, 'PASS')
assert.deepEqual(proof.runtime, { node: '20.20.2', blast_base: 'HEAD^', blast_base_commit: 'e'.repeat(40) })
assert.equal(proof.controls.count, 53)
assert.equal(proof.controls.catalog_sha256, 'f6271d9cba771e818913ad769be982420880dafe353e2ec9ff59682ebc281dc0')
assert.equal(proof.controls.semantic_catalog_sha256, '57f6843147042cd851fe18ead45bda7c4b1e243d7f0a2c0e1d66ed2f2d410a8c')
for (const invalidExecutions of [
  passingExecutions.slice(1),
  [passingExecutions[1], passingExecutions[0], ...passingExecutions.slice(2)],
  passingExecutions.map((execution, index) => index === 20 ? { ...execution, status: 'FAIL' } : execution),
]) assert.throws(() => buildExecutionProof(invalidExecutions, proof.source), /all 53 ordered PASS controls/u)
const catalogMutations = [
  normalizedCatalog.slice(1),
  [normalizedCatalog[1], normalizedCatalog[0], ...normalizedCatalog.slice(2)],
  normalizedCatalog.map(control => control.id === 'architecture-policy' ? { ...control, command: 'true', args: [] } : control),
  normalizedCatalog.map(control => control.id === 'whole-repository-write-scan' ? { ...control, args: control.args.filter(argument => argument !== '--strict') } : control),
  normalizedCatalog.map(control => control.id === 'tg-bot-security' ? { ...control, cwd: '.' } : control),
]
for (const mutation of catalogMutations) {
  assert.notEqual(
    catalogDigest(mutation),
    '57f6843147042cd851fe18ead45bda7c4b1e243d7f0a2c0e1d66ed2f2d410a8c',
    'removed, reordered, replaced, argument-weakened, or cwd-mutated controls must invalidate the reviewed catalog',
  )
}
assert.deepEqual(
  targetedControls[0],
  ['authoritative-ci-inventory', 'node', ['tools/architecture/test-authoritative-ci-inventory.mjs']],
  'the inventory must execute as the first non-recursive authoritative control',
)
assert.deepEqual(
  normalizedCatalog.slice(0, 6).map(({ id }) => id),
  [
    'authoritative-ci-inventory',
    'whole-repository-credential-inventory',
    'fresh-credential-verification',
    'whole-repository-write-scan',
    'fresh-write-verification',
    'fresh-migration-write-site-authorizations',
  ],
  'fresh source-bound evidence must be verified before expensive authoritative consumers',
)
for (const expensive of ['production-migration-canonical-replay', 'all-current-boundaries', 'independent-source-critic']) {
  assert(
    normalizedCatalog.findIndex(({ id }) => id === 'fresh-migration-write-site-authorizations')
      < normalizedCatalog.findIndex(({ id }) => id === expensive),
    `fresh source-bound evidence must precede ${expensive}`,
  )
}
const orderedRawControls = orderedControlsFor('/tmp/yoko-authoritative-ci-ordering-test')
for (const failingControl of ['fresh-credential-verification', 'fresh-write-verification']) {
  const visited = []
  assert.throws(
    () => executeControlSequence(orderedRawControls, null, ([id]) => {
      visited.push(id)
      if (id === failingControl) throw new Error(`stale current evidence: ${id}`)
    }),
    /stale current evidence/,
    `stale ${failingControl} evidence must fail the ordered runner`,
  )
  assert.equal(visited.at(-1), failingControl)
  assert.equal(visited.includes('production-migration-canonical-replay'), false)
  assert.equal(visited.includes('all-current-boundaries'), false)
  assert.equal(visited.includes('independent-source-critic'), false)
}
const workflow = readFileSync('.github/workflows/architecture-enforcement.yml', 'utf8')
const localCleanHarness = readFileSync('tools/architecture/run-local-clean-acceptance.mjs', 'utf8')
assert.match(localCleanHarness, /assertNoInheritedGeneratedProducts\(\)/u)
assert.match(localCleanHarness, /git', \['ls-files', '-z', '--', 'package\.json', ':\(glob\)\*\*\/package\.json'\]/u)
assert.match(localCleanHarness, /function nestedDependencyProducts/u)
assert.match(localCleanHarness, /entry\.name === 'node_modules' \|\| entry\.name === '\.next'/u)
assert.match(localCleanHarness, /'node_modules', '\.next', 'out', 'dist', 'build', '\.turbo'/u)
assert.match(localCleanHarness, /postgresClientIdentity\(process\.env\)/u)
assert.match(localCleanHarness, /run\('npm', \['run', '--prefix', 'gravity-mvp', 'build'\]/u)
assert.match(localCleanHarness, /YOKO_CI_ATTESTATION_OUTPUT: proofPath/u)
assert.match(localCleanHarness, /evidence directory must be outside the repository/u)
assert.match(workflow, /node tools\/architecture\/run-authoritative-ci\.mjs/u)
assert.equal(
  workflowStepRun(workflow, 'architecture', 'Run authoritative architecture controls'),
  'node tools/architecture/run-authoritative-ci.mjs',
  'the architecture job must execute the runner as one exact scalar command',
)
const workflowCommentBypass = workflow.replace(
  '        run: node tools/architecture/run-authoritative-ci.mjs',
  '        run: true # node tools/architecture/run-authoritative-ci.mjs',
)
assert.equal(
  workflowStepRun(workflowCommentBypass, 'architecture', 'Run authoritative architecture controls'),
  'true # node tools/architecture/run-authoritative-ci.mjs',
)
assert.notEqual(
  workflowStepRun(workflowCommentBypass, 'architecture', 'Run authoritative architecture controls'),
  'node tools/architecture/run-authoritative-ci.mjs',
  'commented runner text must not satisfy the exact workflow execution contract',
)
assert.deepEqual(workflowJobStepNames(workflow, 'architecture'), [
  'Check out exact revision',
  'Fetch exact Stage A authorities',
  'Run targeted Runtime TG base-reference contract',
  'Fetch exact Runtime v10 predecessor',
  'Set up exact Node.js',
  'Verify exact Node.js',
  'Install locked test toolchain without lifecycle scripts',
  'Generate checked Prisma clients',
  'Verify pinned PostgreSQL replay client',
  'Run authoritative architecture controls',
  'Upload exact authoritative CI execution proof',
], 'the architecture job step inventory must remain exact and ordered')
const tgReferenceStepStart = workflow.indexOf('      - name: Run targeted Runtime TG base-reference contract')
const tgReferenceStepEnd = workflow.indexOf('\n      - name:', tgReferenceStepStart + 1)
const tgReferenceStep = workflow.slice(tgReferenceStepStart, tgReferenceStepEnd)
assert.ok(tgReferenceStepStart > 0, 'the real-Docker TG base-reference gate must exist')
assert.match(tgReferenceStep, /^          YOKO_RUNTIME_REAL_DOCKER: '1'$/mu)
assert.match(tgReferenceStep, /^          YOKO_TG_REFERENCE_TEST_BASE: 'postgres@sha256:7a396fd264a2067788b6551122b50f162bf6136312c7fc9d74381cb92c648382'$/mu)
assert.match(tgReferenceStep, /test_builder_contract\.py" RealDockerTgBaseReferenceTests/u)
assert.doesNotMatch(tgReferenceStep, /^        (?:if|continue-on-error):/mu, 'the real-Docker TG gate cannot be skipped or tolerated')
assert.deepEqual(workflowJobStepNames(workflow, 'gravity-artifact'), [
  'Check out exact revision',
  'Set up exact Buildx',
  'Download exact authoritative CI execution proof',
  'Build exact Gravity image and machine attestation',
  'Upload exact Gravity artifact',
  'Record hosted artifact identity',
], 'the hosted artifact job step inventory must remain exact and ordered')
const runnerStepStart = workflow.indexOf('      - name: Run authoritative architecture controls')
const runnerStepEnd = workflow.indexOf('\n      - name:', runnerStepStart + 1)
const runnerStep = workflow.slice(runnerStepStart, runnerStepEnd)
assert.doesNotMatch(runnerStep, /^        (?:if|continue-on-error):/mu, 'the authoritative runner step cannot be skipped or tolerated')
assert.match(runnerStep, /^          YOKO_CI_ATTESTATION_OUTPUT: authoritative-ci-execution\.json$/mu)
assert.match(
  workflow,
  /jobs:\n  architecture:\n    runs-on: ubuntu-24\.04\n    timeout-minutes: 240\n/u,
  'the architecture job needs bounded 240-minute headroom for 112 boundary controls and the full repository scans',
)
assert.match(
  workflow,
  /  gravity-artifact:\n    needs: architecture\n    runs-on: ubuntu-24\.04\n    timeout-minutes: 60\n/u,
  'the dependent immutable artifact build must retain its bounded 60-minute timeout',
)
assert.match(
  workflow,
  /buildx_inspect=\$\(docker buildx inspect --bootstrap\)[\s\S]*awk '\$1 == "Driver:" \{ print \$2 \}'\)" = 'docker-container'[\s\S]*awk '\$1 == "BuildKit" && \$2 == "version:" \{ print \$3 \}'\)" = 'v0\.25\.2'/u,
  'the hosted artifact job must verify the pinned Buildx driver and exact v0.30.1 BuildKit version label',
)
assert.doesNotMatch(
  workflow,
  /docker buildx inspect[^\n]*--format/u,
  'Buildx v0.30.1 inspect does not support --format',
)
assert.match(workflow, /image: postgres:16\.14-alpine/u)
assert.match(workflow, /ports:\s*\n\s*- 5432:5432/u, 'PostgreSQL must be published to the host runner used by Prisma')
assert.doesNotMatch(workflow, /fetch-depth:\s*0/u, 'hosted controls must not require an unbounded full-history checkout')
assert.match(workflow, /ref: \$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/u, 'hosted PR CI must test the exact accepted source commit rather than a synthetic merge commit')
assert.match(workflow, /fetch-depth: 2/u, 'hosted blast-radius analysis needs the accepted source parent without full-history dependence')
assert.match(
  workflow,
  /STAGE_A_APPLICATION_COMMIT: 6e3f094bf4b42c1400c705843ab107dacd6d1cf8[\s\S]*git fetch --no-tags --depth=1 origin \\\n+\s+"\$STAGE_A_APPLICATION_COMMIT:refs\/heads\/stage-a-accepted-application"[\s\S]*git rev-parse 'refs\/heads\/stage-a-accepted-application\^\{commit\}'/u,
  'hosted Stage A contract must fetch the exact accepted application authority into a clone-visible ref and verify its commit identity',
)
for (const stageAApplicationFetchMutation of [
  workflow.replace('6e3f094bf4b42c1400c705843ab107dacd6d1cf8', '0'.repeat(40)),
  workflow.replace(':refs/heads/stage-a-accepted-application', ''),
  workflow.replace("git rev-parse 'refs/heads/stage-a-accepted-application^{commit}'", 'true'),
]) {
  assert.doesNotMatch(
    stageAApplicationFetchMutation,
    /STAGE_A_APPLICATION_COMMIT: 6e3f094bf4b42c1400c705843ab107dacd6d1cf8[\s\S]*git fetch --no-tags --depth=1 origin \\\n+\s+"\$STAGE_A_APPLICATION_COMMIT:refs\/heads\/stage-a-accepted-application"[\s\S]*git rev-parse 'refs\/heads\/stage-a-accepted-application\^\{commit\}'/u,
    'wrong, unreachable, or unverified Stage A application fetch must fail the workflow contract',
  )
}
assert.match(
  workflow,
  /STAGE_A_SCOPE_BASE_COMMIT: ba94bb493cef9938b07f187faf86bc81724cc9c0[\s\S]*"\$STAGE_A_SCOPE_BASE_COMMIT:refs\/heads\/stage-a-scope-base"[\s\S]*git rev-parse 'refs\/heads\/stage-a-scope-base\^\{commit\}'/u,
  'hosted Stage A scope must fetch the frozen historical base into a clone-visible ref and verify its identity',
)
for (const stageAScopeBaseFetchMutation of [
  workflow.replace('ba94bb493cef9938b07f187faf86bc81724cc9c0', '0'.repeat(40)),
  workflow.replace(':refs/heads/stage-a-scope-base', ''),
  workflow.replace("git rev-parse 'refs/heads/stage-a-scope-base^{commit}'", 'true'),
]) {
  assert.doesNotMatch(
    stageAScopeBaseFetchMutation,
    /STAGE_A_SCOPE_BASE_COMMIT: ba94bb493cef9938b07f187faf86bc81724cc9c0[\s\S]*"\$STAGE_A_SCOPE_BASE_COMMIT:refs\/heads\/stage-a-scope-base"[\s\S]*git rev-parse 'refs\/heads\/stage-a-scope-base\^\{commit\}'/u,
    'wrong, unreachable, or unverified Stage A historical scope-base fetch must fail the workflow contract',
  )
}
assert.match(
  workflow,
  /STAGE_A_ACCEPTED_CHANGE_COMMIT: e8ea2ab5cbd88b5dccf993eb2da5f1947afc7b65[\s\S]*"\$STAGE_A_ACCEPTED_CHANGE_COMMIT:refs\/heads\/stage-a-accepted-change"[\s\S]*git rev-parse 'refs\/heads\/stage-a-accepted-change\^\{commit\}'/u,
  'hosted Stage A scope must fetch the frozen accepted merge into a clone-visible ref and verify its identity',
)
for (const stageAAcceptedChangeFetchMutation of [
  workflow.replace('e8ea2ab5cbd88b5dccf993eb2da5f1947afc7b65', '0'.repeat(40)),
  workflow.replace(':refs/heads/stage-a-accepted-change', ''),
  workflow.replace("git rev-parse 'refs/heads/stage-a-accepted-change^{commit}'", 'true'),
]) {
  assert.doesNotMatch(
    stageAAcceptedChangeFetchMutation,
    /STAGE_A_ACCEPTED_CHANGE_COMMIT: e8ea2ab5cbd88b5dccf993eb2da5f1947afc7b65[\s\S]*"\$STAGE_A_ACCEPTED_CHANGE_COMMIT:refs\/heads\/stage-a-accepted-change"[\s\S]*git rev-parse 'refs\/heads\/stage-a-accepted-change\^\{commit\}'/u,
    'wrong, unreachable, or unverified Stage A accepted-change fetch must fail the workflow contract',
  )
}
assert.match(
  workflow,
  /RUNTIME_V10_PREDECESSOR_COMMIT: 7aea2823efe50e13a156540993d424594025e403[\s\S]*git fetch --no-tags --depth=1 origin \\\n\s+"\$RUNTIME_V10_PREDECESSOR_COMMIT:refs\/heads\/yoko-runtime-v10-predecessor"[\s\S]*git rev-parse 'refs\/heads\/yoko-runtime-v10-predecessor\^\{commit\}'/u,
  'hosted Runtime v10 contract must fetch the exact predecessor into a clone-visible ref and verify its commit identity',
)
for (const predecessorFetchMutation of [
  workflow.replace('7aea2823efe50e13a156540993d424594025e403', '0'.repeat(40)),
  workflow.replace(':refs/heads/yoko-runtime-v10-predecessor', ''),
  workflow.replace("git rev-parse 'refs/heads/yoko-runtime-v10-predecessor^{commit}'", 'true'),
]) {
  assert.doesNotMatch(
    predecessorFetchMutation,
    /RUNTIME_V10_PREDECESSOR_COMMIT: 7aea2823efe50e13a156540993d424594025e403[\s\S]*git fetch --no-tags --depth=1 origin \\\n\s+"\$RUNTIME_V10_PREDECESSOR_COMMIT:refs\/heads\/yoko-runtime-v10-predecessor"[\s\S]*git rev-parse 'refs\/heads\/yoko-runtime-v10-predecessor\^\{commit\}'/u,
    'wrong, unreachable, or unverified Runtime v10 predecessor fetch must fail the workflow contract',
  )
}
assert.match(
  workflow,
  /uses: actions\/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020/u,
  'hosted CI must pin the reviewed setup-node v4.4.0 commit rather than a mutable tag',
)
assert.match(workflow, /node-version: 20\.20\.2/u, 'hosted CI must install the exact locally reviewed Node.js release')
assert.match(workflow, /process\.versions\.node !== '20\.20\.2'/u, 'hosted CI must fail closed if the exact Node.js release was not activated')
assert.match(workflow, /YOKO_BLAST_BASE: HEAD\^/u, 'hosted blast-radius analysis must use the exact accepted commit parent available in the shallow checkout')
const stageARunnerScopeContract = /YOKO_STAGE_A_SCOPE_BASE: refs\/heads\/stage-a-scope-base\n\s+YOKO_STAGE_A_SCOPE_BASE_COMMIT: ba94bb493cef9938b07f187faf86bc81724cc9c0\n\s+YOKO_STAGE_A_ACCEPTED_CHANGE: refs\/heads\/stage-a-accepted-change\n\s+YOKO_STAGE_A_ACCEPTED_CHANGE_COMMIT: e8ea2ab5cbd88b5dccf993eb2da5f1947afc7b65/u
assert.match(
  workflow,
  stageARunnerScopeContract,
  'hosted Stage A scope checks must use the separately fetched frozen historical range bound to exact commit identities',
)
for (const stageARunnerScopeMutation of [
  workflow.replace('YOKO_STAGE_A_SCOPE_BASE: refs/heads/stage-a-scope-base', 'YOKO_STAGE_A_SCOPE_BASE: HEAD'),
  workflow.replace('YOKO_STAGE_A_SCOPE_BASE_COMMIT: ba94bb493cef9938b07f187faf86bc81724cc9c0', 'YOKO_STAGE_A_SCOPE_BASE_COMMIT: ${{ github.sha }}'),
  workflow.replace('YOKO_STAGE_A_ACCEPTED_CHANGE: refs/heads/stage-a-accepted-change', 'YOKO_STAGE_A_ACCEPTED_CHANGE: HEAD'),
  workflow.replace('YOKO_STAGE_A_ACCEPTED_CHANGE_COMMIT: e8ea2ab5cbd88b5dccf993eb2da5f1947afc7b65', 'YOKO_STAGE_A_ACCEPTED_CHANGE_COMMIT: ${{ github.sha }}'),
]) {
  assert.doesNotMatch(
    stageARunnerScopeMutation,
    stageARunnerScopeContract,
    'self or identity-unbound Stage A historical range must fail the workflow contract',
  )
}
assert.doesNotMatch(workflow, /YOKO_BLAST_BASE:.*pull_request\.base\.sha/u, 'hosted CI must not select an unfetched PR base as its change-set authority')
assert.doesNotMatch(workflow, /STAGE_A_(?:SCOPE_BASE|ACCEPTED_CHANGE)_COMMIT: \$\{\{/u, 'Stage A historical scope must not drift with later workflow events')
assert.match(workflow, /DATABASE_URL: postgresql:\/\/postgres:postgres@localhost:5432\/postgres\?schema=yoko_migration_authority_replay_ci/u)
assert.match(workflow, /YOKO_POSTGRES_CLIENT_CONTAINER: \$\{\{ job\.services\.postgres\.id \}\}/u)
assert.match(workflow, /docker exec "\$YOKO_POSTGRES_CLIENT_CONTAINER" psql --version \| grep -F '16\.14'/u)
assert.match(workflow, /docker exec "\$YOKO_POSTGRES_CLIENT_CONTAINER" pg_dump --version \| grep -F '16\.14'/u)
assert.doesNotMatch(workflow, /--skip-full-scans/u)
assert.match(workflow, /YOKO_CI_ATTESTATION_OUTPUT: authoritative-ci-execution\.json/u)
assert.match(workflow, /name: authoritative-ci-proof-\$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/u)
assert.match(workflow, /path: authoritative-ci-execution\.json/u)
assert.match(
  workflow,
  /uses: actions\/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093/u,
  'the CI execution proof downloader must be pinned to the reviewed commit',
)
assert.match(
  workflow,
  /path: \|\s*\n\s*gravity-image\.docker\.tar\s*\n\s*gravity-image-attestation\.json\s*\n\s*authoritative-ci-execution\.json/u,
  'the final hosted Gravity artifact must transitively bind the runner-emitted CI proof',
)
for (const prefix of ['gravity-mvp', 'tg-bot']) {
  const install = workflow.indexOf(`npm ci --prefix ${prefix}`)
  const generate = workflow.indexOf(`npm run --prefix ${prefix} gen`)
  const controls = workflow.indexOf('node tools/architecture/run-authoritative-ci.mjs')
  assert(install >= 0, `${prefix} locked install is missing`)
  assert(generate > install, `${prefix} Prisma client must be generated after the locked install`)
  assert(controls > generate, `${prefix} Prisma client must be generated before authoritative controls`)
  const packageJson = JSON.parse(readFileSync(`${prefix}/package.json`, 'utf8'))
  assert.equal(packageJson.scripts?.gen, 'prisma generate', `${prefix} generation must resolve the lockfile-owned Prisma CLI`)
  assert(packageJson.dependencies?.prisma, `${prefix} must lock Prisma as a project dependency`)
}
assert.doesNotMatch(workflow, /npm exec --prefix .*prisma generate/u, 'workflow must not let npm exec fetch an unpinned Prisma CLI')
assert.match(workflow, /gravity-artifact:\s*\n\s*needs: architecture/u, 'the deployable Gravity artifact must be gated by the complete authoritative control job')
assert.match(
  workflow,
  /uses: docker\/setup-buildx-action@8d2750c68a42422c14e847fe6c8ac0403b4cbd6f/u,
  'the hosted image builder action must be pinned to the reviewed commit',
)
assert.match(workflow, /version: v0\.30\.1/u, 'the hosted image builder release must be exact')
assert.match(workflow, /image=moby\/buildkit:v0\.25\.2@sha256:72bda77240181301a0d5ee57d39fa58e4aabd7eff26f81bbf108088caf810f05/u)
assert.match(
  workflow,
  /uses: actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02/u,
  'the hosted artifact uploader action must be pinned to the reviewed commit',
)
assert.match(
  workflow,
  /printf '%s\\n' "\$ARTIFACT_DIGEST" \| grep -Eq '\^\[0-9a-f\]\{64\}\$'/u,
  'upload-artifact exposes a raw 64-hex digest; expecting a sha256: prefix would make every hosted artifact job fail',
)

const writeCommand = fullScanControls.find(([id]) => id === 'whole-repository-write-scan')
assert(writeCommand[2].includes('--strict'))
assert(writeCommand[2].includes('--progress-jsonl'))
assert(writeCommand[2].includes('--output'))
const registryFlag = writeCommand[2].indexOf('--surface-registry')
assert(registryFlag >= 0, 'fresh write scan must load the accepted lifecycle registry')
assert.equal(
  writeCommand[2][registryFlag + 1],
  'architecture/recovery/whole-project-dod/v2/LIFECYCLE_SURFACE_CLASSIFICATION_REGISTRY.json',
)
const migrationAuthorizationCommand = fullScanControls.find(([id]) => id === 'fresh-migration-write-site-authorizations')
assert(migrationAuthorizationCommand, 'fresh migration write authorization control is missing')
assert.equal(migrationAuthorizationCommand[2][0], 'tools/architecture/v2/test-migration-write-site-authorizations.mjs')
assert.equal(migrationAuthorizationCommand[2][1], writeCommand[2][writeCommand[2].indexOf('--output') + 1], 'migration authorization must consume the exact fresh write denominator')
const credentialCommand = fullScanControls.find(([id]) => id === 'whole-repository-credential-inventory')
const credentialRegistryFlag = credentialCommand[2].indexOf('--surface-registry')
assert(credentialRegistryFlag >= 0, 'fresh credential scan must load the accepted lifecycle registry')
assert.equal(
  credentialCommand[2][credentialRegistryFlag + 1],
  'architecture/recovery/whole-project-dod/v2/LIFECYCLE_SURFACE_CLASSIFICATION_REGISTRY.json',
)

process.stdout.write(`authoritative CI inventory: PASS (${ids.size} controls; semantic catalog sha256=57f6843147042cd851fe18ead45bda7c4b1e243d7f0a2c0e1d66ed2f2d410a8c; fail-fast fresh credential and write scans enabled)\n`)
