import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const gatewayRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repositoryRoot = path.resolve(gatewayRoot, '..')
const repairSource = readFileSync(path.join(gatewayRoot, 'src/ops/repairUatFailure.ts'), 'utf8')
const productionScript = path.join(repositoryRoot, 'scripts/personal-max-uat-fix-production-v1.sh')
const productionSource = readFileSync(productionScript, 'utf8')

test('production repair runner is valid shell and checksum/source bound', () => {
  execFileSync('/bin/bash', ['-n', productionScript])
  assert.match(productionSource, /sha256sum "\$SCRIPT_PATH"/u)
  assert.match(productionSource, /rev-parse "origin\/\$EXPECTED_BRANCH"/u)
  assert.match(productionSource, /status --porcelain/u)
})

test('fresh backup and default-off precede every repair mutation', () => {
  const backup = productionSource.indexOf('production-before-repair.dump')
  const mutation = productionSource.indexOf('production_mutated=true')
  const repair = productionSource.indexOf('repairUatFailure.ts')
  assert.ok(backup > 0 && backup < mutation && mutation < repair)
  assert.match(productionSource, /if \[\[ \$status -ne 0 && \$production_mutated == true \]\]; then[\s\S]*default_off_now/u)
})

test('bounded canary contains the exact six outbound and four inbound texts', () => {
  for (const text of [
    'PMAX UAT FIX 1', 'Одинаковое сообщение', 'Сообщение 1', 'Сообщение 2', 'Сообщение 3',
    'Ответ из MAX', 'Входящее 1', 'Входящее 2', 'Входящее 3',
  ]) assert.ok(productionSource.includes(text), `missing exact canary text: ${text}`)
  assert.match(productionSource, /outbound_gate == '6\|6\|6\|6\|6'/u)
  assert.match(productionSource, /inbound_gate == '4\|4\|4\|0'/u)
})

test('ledger repair is exact-scope, evidence preserving, and provider-action free', () => {
  assert.match(repairSource, /2026-07-30T09:07:00\.000Z/u)
  assert.match(repairSource, /2026-07-30T09:13:00\.000Z/u)
  assert.match(repairSource, /COMMAND_COUNT_MISMATCH/u)
  assert.match(repairSource, /CONVERSATION_SCOPE_MISMATCH/u)
  assert.match(repairSource, /PROVIDER_EVIDENCE_COLLISION/u)
  assert.doesNotMatch(repairSource, /\.delete(?:Many)?\s*\(/u)
  assert.doesNotMatch(repairSource, /\bfetch\s*\(/u)
})

test('repair preserves exact provider confirmation and quarantines only the proven replay identity', () => {
  assert.match(repairSource, /recordExactProviderConfirmation/u)
  assert.match(repairSource, /sequence5ProviderId/u)
  assert.match(repairSource, /externalId: replayProviderId/u)
  assert.match(repairSource, /kind: 'history_replay'/u)
  assert.match(repairSource, /visibility: 'quarantined'/u)
  assert.match(repairSource, /evidencePreserved: true/u)
})
