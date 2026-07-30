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
  assert.doesNotMatch(productionSource, /--project-directory "\$PROD_DIR"/u)
  assert.match(productionSource, /seal_evidence "\$EVIDENCE_DIR"/u)
  assert.match(productionSource, /printf 'MISSING  %s\\n'/u)
  assert.match(productionSource, /MIN_DOCKER_FREE_BYTES=15000000000/u)
  assert.match(productionSource, /docker info --format '\{\{\.DockerRootDir\}\}'/u)
  assert.match(productionSource, /docker builder prune --all --force/u)
})

test('fresh backup and default-off precede every repair mutation', () => {
  const backup = productionSource.indexOf('production-before-repair.dump')
  const mutation = productionSource.indexOf('production_mutated=true')
  const repair = productionSource.indexOf('repairUatFailure.ts')
  assert.ok(backup > 0 && backup < mutation && mutation < repair)
  assert.match(productionSource, /if \[\[ \$status -ne 0 && \$production_mutated == true \]\]; then[\s\S]*default_off_now/u)
})

test('bounded canary contains the exact outbound and historical inbound evidence texts', () => {
  for (const text of [
    'PMAX UAT FIX 1', 'Одинаковое сообщение', 'Сообщение 1', 'Сообщение 2', 'Сообщение 3',
    'Ответ из MAX', 'Входящее 1', 'Входящее 2', 'Входящее 3',
  ]) assert.ok(productionSource.includes(text), `missing exact canary text: ${text}`)
  assert.match(productionSource, /outbound_gate == '6\|6\|6\|6\|6'/u)
  assert.match(productionSource, /incident_inbound_gate == '4\|4\|4\|3\|1\|1'/u)
  assert.match(productionSource, /new_inbound_before_restart == 0/u)
  assert.match(productionSource, /new_inbound_after_restart == 0/u)
  assert.doesNotMatch(productionSource, /INBOUND_WAIT_SECONDS/u)
})

test('production runner proves restart, rollback and no-send roll-forward identity stability', () => {
  assert.match(productionSource, /max-personal-gateway max-web-scraper/u)
  assert.match(productionSource, /contact_projection_hash_before/u)
  assert.match(productionSource, /contact_projection_hash_after/u)
  assert.match(productionSource, /actual_default_off_gate/u)
  assert.match(productionSource, /actual_operational_gate/u)
  assert.match(productionSource, /rollback_identity_hash_before/u)
  assert.match(productionSource, /rollforward_identity_hash_after/u)
  assert.match(productionSource, /final_queue_gate_after_rollforward == '0\|0'/u)
})

test('fresh run refuses orphaned canary operations before any new provider action', () => {
  assert.match(productionSource, /PREVIOUS_RUN_DID_NOT_CROSS_PREFLIGHT/u)
  assert.match(productionSource, /\.commands == 0 and \.dispatches == 0 and \.attempts == 0/u)
  assert.match(productionSource, /\.providerConfirmed == 0 and \.providerActions == 0/u)
  assert.match(productionSource, /safeToStartFresh:true/u)
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
