import assert from 'node:assert/strict'
import test from 'node:test'
import { GatewayConfigError, loadGatewayConfig, parseExactAccountAllowlist } from '../src/runtime/config.ts'

const secret = 'synthetic-stage8b1-hmac-secret-0000000000000000'

test('all Stage 8B1 features default false and dormant config requires no DB or auth', () => {
  const config = loadGatewayConfig({})
  assert.equal(config.mode, 'dormant')
  assert.equal(config.enabledAccounts.size, 0)
  assert.equal(config.databaseUrl, null)
  assert.equal(config.hmacKeys.size, 0)
  assert.equal(config.bindHost, '127.0.0.1')
})

test('allowlists reject wildcard, booleans, whitespace, malformed and global enablement', () => {
  for (const value of ['*', 'true', 'false', '1', 'all', ' account-a', 'account-a ', 'account-a,', 'account-a,!']) {
    assert.throws(() => parseExactAccountAllowlist(value), GatewayConfigError)
  }
  assert.deepEqual([...parseExactAccountAllowlist('account-a,account-b')], ['account-a', 'account-b'])
})

test('active account flags require safe dependency ordering, explicit DB URL and HMAC keys', () => {
  assert.throws(() => loadGatewayConfig({ MAX_PERSONAL_LIVE_CAPTURE_ENABLED: 'account-a' }), /upstream account/)
  assert.throws(() => loadGatewayConfig({ MAX_PROVIDER_CONFIRMATION_MATCHER_ENABLED: 'account-a' }), /upstream account/)
  assert.throws(() => loadGatewayConfig({ MAX_RAW_JOURNAL_ENABLED: 'account-a' }), /PostgreSQL URL/)
  assert.throws(() => loadGatewayConfig({
    MAX_RAW_JOURNAL_ENABLED: 'account-a',
    MAX_PERSONAL_GATEWAY_DATABASE_URL: 'postgresql://synthetic.invalid/db',
  }), /HMAC keys/)
  const config = loadGatewayConfig({
    MAX_RAW_JOURNAL_ENABLED: 'account-a',
    MAX_INBOUND_NORMALIZER_ENABLED: 'account-a',
    MAX_PROVIDER_CONFIRMATION_MATCHER_ENABLED: 'account-a',
    MAX_SHADOW_COMPARISON_ENABLED: 'account-a',
    MAX_PERSONAL_LIVE_CAPTURE_ENABLED: 'account-a',
    MAX_PERSONAL_GATEWAY_DATABASE_URL: 'postgresql://synthetic.invalid/db',
    MAX_PERSONAL_CAPTURE_HMAC_KEYS_JSON: JSON.stringify({ current: secret }),
  })
  assert.equal(config.mode, 'active')
  assert.equal(config.features.providerConfirmation.has('account-a'), true)
  assert.deepEqual([...config.enabledAccounts], ['account-a'])
})

test('gateway rejects browser ownership and non-private wildcard binding', () => {
  assert.throws(() => loadGatewayConfig({ MAX_PERSONAL_GATEWAY_BROWSER_OWNER: 'requested' }), /Browser ownership/)
  assert.throws(() => loadGatewayConfig({ MAX_PERSONAL_GATEWAY_CHROMIUM_PROFILE_PATH: '/profile' }), /Browser ownership/)
  assert.throws(() => loadGatewayConfig({ MAX_PERSONAL_GATEWAY_BIND_HOST: '0.0.0.0' }), /private container network/)
  const config = loadGatewayConfig({
    MAX_PERSONAL_GATEWAY_BIND_HOST: '0.0.0.0',
    MAX_PERSONAL_GATEWAY_PRIVATE_NETWORK: 'required',
  })
  assert.equal(config.mode, 'dormant')
})

test('generic DATABASE_URL never activates or configures gateway DB access', () => {
  const config = loadGatewayConfig({ DATABASE_URL: 'postgresql://must-not-be-used.invalid/db' })
  assert.equal(config.mode, 'dormant')
  assert.equal(config.databaseUrl, null)
})
