import assert from 'node:assert/strict'
import test from 'node:test'
import { loadTextSenderRuntimeConfig } from '../src/sender/config.ts'

const secret = 'sender-runtime-test-secret-0000000000000000'

function active() {
  return {
    MAX_PERSONAL_TEXT_SENDER_ENABLED: 'true',
    MAX_PERSONAL_TEXT_SENDER_PHYSICAL_ENABLED: 'true',
    MAX_PERSONAL_TEXT_SENDER_EMERGENCY_STOP_CLEAR: 'true',
    MAX_PERSONAL_TEXT_SENDER_ACCOUNT_ID: 'account-a',
    MAX_PERSONAL_TEXT_SENDER_CONVERSATIONS_JSON: JSON.stringify(['conversation-a']),
    MAX_PERSONAL_TEXT_SENDER_HMAC_KEYS_JSON: JSON.stringify({ current: secret }),
    MAX_PERSONAL_TEXT_SENDER_HMAC_KEY_ID: 'current',
    MAX_PERSONAL_TEXT_COMMAND_HMAC_SECRET: secret,
    MAX_PERSONAL_TEXT_SENDER_SCRAPER_URL: 'http://max-web-scraper:3005/v1/personal-max/send/text',
    MAX_PERSONAL_TEXT_SENDER_OWNER_ID: 'scraper-owner',
    MAX_PERSONAL_TEXT_ACTOR_OWNER_ID: 'gateway-actor',
  }
}

test('text sender remains default-off with no bindings', () => {
  const config = loadTextSenderRuntimeConfig({})
  assert.equal(config.enabled, false)
  assert.equal(config.hmacKeys.size, 0)
})

test('active text sender requires an exact private scraper and one conversation', () => {
  const config = loadTextSenderRuntimeConfig(active())
  assert.equal(config.enabled, true)
  assert.equal(config.physicalEnabled, true)
  assert.equal(config.conversationScopes.size, 1)
  assert.throws(() => loadTextSenderRuntimeConfig({ ...active(), MAX_PERSONAL_TEXT_SENDER_SCRAPER_URL: 'https://external.invalid/v1/personal-max/send/text' }))
  assert.throws(() => loadTextSenderRuntimeConfig({ ...active(), MAX_PERSONAL_TEXT_SENDER_CONVERSATIONS_JSON: JSON.stringify(['a', 'b']) }))
})
