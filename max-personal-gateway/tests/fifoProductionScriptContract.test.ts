import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const gatewayRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repositoryRoot = path.resolve(gatewayRoot, '..')
const productionScript = path.join(repositoryRoot, 'scripts/personal-max-fifo-final-production-v1.sh')
const source = readFileSync(productionScript, 'utf8')

test('FIFO production runner is valid shell and immutable-source bound', () => {
  execFileSync('/bin/bash', ['-n', productionScript])
  assert.match(source, /sha256sum "\$SCRIPT_PATH"/u)
  assert.match(source, /rev-parse "origin\/\$EXPECTED_BRANCH"/u)
  assert.match(source, /status --porcelain/u)
  assert.match(source, /BASE_COMPOSE_SHA=[0-9a-f]{64}/u)
  assert.match(source, /OPERATIONAL_COMPOSE_SHA=[0-9a-f]{64}/u)
  assert.match(source, /DEFAULT_OFF_COMPOSE_SHA=[0-9a-f]{64}/u)
  assert.match(source, /image_revision "\$image"/u)
})

test('fresh backup and automatic default-off precede any production rollout', () => {
  const backup = source.indexOf('production-before-fifo-rollout.dump')
  const mutation = source.indexOf('production_mutated=true')
  const operational = source.indexOf('"${compose_operational[@]}" up', mutation)
  assert.ok(backup > 0 && backup < mutation && mutation < operational)
  assert.match(source, /if \[\[ \$status -ne 0 && \$production_mutated == true \]\]; then default_off_now/u)
  assert.match(source, /restore-list/u)
})

test('ten allowed FIFO canaries use only the CRM durable API path', () => {
  assert.match(source, /PMAX FIFO FINAL /u)
  assert.match(source, /range\(\$start;11\)/u)
  assert.match(source, /pmax-fifo-\$\{SHORT_SHA\}-/u)
  assert.match(source, /http:\/\/127\.0\.0\.1:3002\/api\/messages/u)
  assert.doesNotMatch(source, /3005\/v1\/personal-max\/send\/text/u)
  assert.match(source, /fifo_gate == '10\|10\|1\|10\|10\|10\|10\|10\|10\|9'/u)
  assert.match(source, /\.status=="delivered"[\s\S]*\.metadata\.maxDelivery\.status=="provider_confirmed"/u)
  assert.match(source, /\.metadata\.maxDelivery\.deliveryConfirmed==true/u)
})

test('rapid client registration preserves order and partial reruns never blindly retry', () => {
  assert.match(source, /const registered=requests\.map/u)
  assert.match(source, /const current=tail\.then/u)
  assert.match(source, /tail=current\.then/u)
  assert.match(source, /await Promise\.all\(registered\)/u)
  assert.match(source, /confirmedPrefix/u)
  assert.match(source, /resumeSafe:true,blindRetry:false/u)
  assert.match(source, /existing_count -ge 0 && \$existing_count -le 10/u)
})

test('runner proves restart, default-off, roll-forward, queue zero and immutable production tree', () => {
  assert.match(source, /--force-recreate[\s\S]*max-personal-gateway max-web-scraper/u)
  assert.match(source, /canary_hash_before_restart/u)
  assert.match(source, /canary_hash_default_off/u)
  assert.match(source, /canary_hash_rollforward/u)
  assert.match(source, /final_queue_gate == '0\|0'/u)
  assert.match(source, /PROD_TREE_HASH_BEFORE/u)
  assert.match(source, /PROD_TREE_HASH_AFTER/u)
  assert.match(source, /PERSONAL MAX FIFO FINAL USER CHECK READY/u)
})
