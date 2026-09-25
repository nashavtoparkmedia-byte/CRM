#!/usr/bin/env node

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const authority = 'architecture/recovery/control-plane/v2/hosted-artifacts/crm-c8ce34feae84-gravity-max-source-v1'
const commands = [
  [`${authority}/tests/test_stage_a_contract.py`],
  [`${authority}/tests/test_coordinated_artifact.py`],
  [`${authority}/tests/test_hosted_artifact_transport.py`],
  [`${authority}/tests/test_source_authority_tuple.py`],
]

for (const args of commands) {
  const result = spawnSync('python3', ['-I', '-B', ...args, '-v'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    stdio: 'inherit',
  })
  assert.equal(result.status, 0, `Stage A contract failed: ${args[0]}`)
}

const workflow = readFileSync('.github/workflows/coordinated-gravity-max-c8ce34fe.yml', 'utf8')
assert.match(workflow, /^name: Coordinated Gravity \+ MAX c8ce34fe$/mu)
assert.match(workflow, /^      - codex\/coordinated-gravity-max-c8ce34fe$/mu)
assert.doesNotMatch(workflow, /^\s*workflow_dispatch:/mu)
assert.doesNotMatch(workflow, /^\s*pull_request:/mu)
assert.doesNotMatch(workflow, /secrets\./u)
assert.equal((workflow.match(/docker\/setup-buildx-action@8d2750c68a42422c14e847fe6c8ac0403b4cbd6f/gu) ?? []).length, 1)
assert.equal((workflow.match(/docker buildx build/gu) ?? []).length, 2)
assert.equal((workflow.match(/--platform linux\/amd64/gu) ?? []).length, 2)
assert.equal((workflow.match(/--label org\.opencontainers\.image\.revision=c8ce34feae84e5674357df496be37d0cd8a457bb/gu) ?? []).length, 2)
assert.equal((workflow.match(/--label yoko\.activation\.profile=crm-c8ce34feae84-gravity-max-source-v1/gu) ?? []).length, 2)

process.stdout.write('hosted coordinated Gravity + MAX Stage A contract: PASS\n')
