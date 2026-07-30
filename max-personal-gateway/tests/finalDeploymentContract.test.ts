import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

const root = resolve(import.meta.dirname, '../..')
const source = (path: string) => readFileSync(resolve(root, path), 'utf8')

test('final deployment overlay is immutable-image bound and keeps every physical sender gate off', () => {
  const compose = source('deploy/docker-compose.personal-max-final-default-off.yml')
  for (const binding of ['PERSONAL_MAX_GRAVITY_IMAGE', 'PERSONAL_MAX_GATEWAY_IMAGE', 'PERSONAL_MAX_SCRAPER_IMAGE']) {
    assert.match(compose, new RegExp(`\\$\\{${binding}:\\?`))
  }
  assert.equal((compose.match(/MAX_PERSONAL_TEXT_SENDER_ENABLED: "false"/g) ?? []).length, 2)
  assert.equal((compose.match(/MAX_PERSONAL_TEXT_SENDER_PHYSICAL_ENABLED: "false"/g) ?? []).length, 2)
  assert.equal((compose.match(/MAX_PERSONAL_TEXT_SENDER_EMERGENCY_STOP_CLEAR: "false"/g) ?? []).length, 2)
  assert.match(compose, /MAX_PERSONAL_DURABLE_TEXT_ENABLED: "false"/)
  assert.match(compose, /\/var\/lib\/crm\/max-personal-sender:\/var\/lib\/max-personal-sender/)
  assert.doesNotMatch(compose, /ports:/)
})

test('all three final runtime images carry exact source revision labels', () => {
  for (const dockerfile of ['gravity-mvp/Dockerfile', 'max-personal-gateway/Dockerfile', 'max-web-scraper/Dockerfile']) {
    const value = source(dockerfile)
    assert.match(value, /ARG SOURCE_COMMIT=uncommitted/)
    assert.match(value, /org\.opencontainers\.image\.revision="\$\{SOURCE_COMMIT\}"/)
    assert.match(value, /org\.opencontainers\.image\.stage="8B2"/)
  }
})

test('operational overlay enables only the account-scoped durable fenced text route', () => {
  const compose = source('deploy/docker-compose.personal-max-text-operational.yml')
  assert.match(compose, /MAX_PERSONAL_DURABLE_TEXT_ENABLED: "true"/)
  assert.equal((compose.match(/MAX_PERSONAL_TEXT_SENDER_ENABLED: "true"/g) ?? []).length, 2)
  assert.equal((compose.match(/MAX_PERSONAL_TEXT_SENDER_PHYSICAL_ENABLED: "true"/g) ?? []).length, 2)
  assert.equal((compose.match(/MAX_PERSONAL_TEXT_SENDER_EMERGENCY_STOP_CLEAR: "true"/g) ?? []).length, 2)
  assert.equal((compose.match(/MAX_PERSONAL_TEXT_SENDER_OPERATIONAL_MODE: "true"/g) ?? []).length, 2)
  assert.equal((compose.match(/MAX_PERSONAL_LEGACY_TEXT_SENDER_DISABLED: "true"/g) ?? []).length, 1)
  assert.match(compose, /MAX_PERSONAL_TEXT_SENDER_GATEWAY_CONVERSATIONS_JSON:\?empty operational conversation list required/)
  assert.match(compose, /MAX_PERSONAL_TEXT_SENDER_SCRAPER_CONVERSATIONS_JSON:\?empty operational conversation list required/)
  assert.match(compose, /http:\/\/max-personal-gateway:8080\/v1\/personal-max\/sender\/authorize/)
  assert.doesNotMatch(compose, /canary/i)
  assert.doesNotMatch(compose, /DOM|ports:/i)
})

test('scraper image and production overlay share the accepted numeric runtime identity', () => {
  const dockerfile = source('max-web-scraper/Dockerfile')
  const compose = source('deploy/docker-compose.personal-max-final-default-off.yml')
  const finalStage = dockerfile.slice(dockerfile.lastIndexOf('FROM scratch'))
  assert.match(finalStage, /HOME=\/home\/pwuser/)
  assert.match(finalStage, /RUN \/usr\/bin\/chown -R 1000:1000 \/app \/home\/pwuser/)
  assert.match(finalStage, /USER 1000:1000/)
  assert.match(compose, /max-web-scraper:[\s\S]*?user: "1000:1000"/)
})
