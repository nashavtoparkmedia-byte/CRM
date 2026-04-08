/**
 * E2E тест Contact Search API + Start Conversation API
 * Запуск: node scripts/test-contact-api.js
 */

const BASE = 'http://localhost:3002'

async function test(name, fn) {
  try {
    const result = await fn()
    console.log(`  [PASS] ${name}`)
    return result
  } catch (err) {
    console.error(`  [FAIL] ${name}: ${err.message}`)
    return null
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg)
}

async function main() {
  console.log('\n=== Contact Model MVP — E2E API Tests ===\n')

  // 1. Search API
  console.log('--- Contact Search API ---')

  await test('Short query returns empty', async () => {
    const res = await fetch(`${BASE}/api/contacts/search?q=a`)
    const data = await res.json()
    assert(res.ok, `HTTP ${res.status}`)
    assert(data.contacts.length === 0, `Expected 0, got ${data.contacts.length}`)
  })

  await test('Phone search (digits)', async () => {
    const res = await fetch(`${BASE}/api/contacts/search?q=79`)
    const data = await res.json()
    assert(res.ok, `HTTP ${res.status}`)
    assert(Array.isArray(data.contacts), 'contacts is not array')
    console.log(`    Found ${data.contacts.length} contacts by phone "79"`)
    if (data.contacts.length > 0) {
      const c = data.contacts[0]
      assert(c.id, 'missing id')
      assert(Array.isArray(c.phones), 'missing phones')
      assert(Array.isArray(c.identities), 'missing identities')
      assert(Array.isArray(c.channels), 'missing channels')
      assert(typeof c.hasChat === 'object', 'missing hasChat')
      console.log(`    First: "${c.displayName}", phones: ${c.phones.length}, channels: [${c.channels.join(',')}]`)
    }
  })

  let searchResults = null
  await test('Name search', async () => {
    const res = await fetch(`${BASE}/api/contacts/search?q=Иван&limit=5`)
    const data = await res.json()
    assert(res.ok, `HTTP ${res.status}`)
    console.log(`    Found ${data.contacts.length} contacts by name "Иван"`)
    searchResults = data.contacts
  })

  await test('Limit param works', async () => {
    const res = await fetch(`${BASE}/api/contacts/search?q=79&limit=2`)
    const data = await res.json()
    assert(res.ok, `HTTP ${res.status}`)
    assert(data.contacts.length <= 2, `Expected <=2, got ${data.contacts.length}`)
  })

  // 2. Contact GET
  console.log('\n--- Contact GET API ---')

  if (searchResults && searchResults.length > 0) {
    const contactId = searchResults[0].id
    await test(`GET /api/contacts/${contactId.slice(0,8)}...`, async () => {
      const res = await fetch(`${BASE}/api/contacts/${contactId}`)
      const data = await res.json()
      assert(res.ok, `HTTP ${res.status}`)
      assert(data.id === contactId, 'id mismatch')
      assert(Array.isArray(data.phones), 'missing phones')
      assert(Array.isArray(data.identities), 'missing identities')
      assert(Array.isArray(data.chats), 'missing chats')
      console.log(`    displayName: "${data.displayName}", masterSource: ${data.masterSource}`)
      console.log(`    phones: ${data.phones.length}, identities: ${data.identities.length}, chats: ${data.chats.length}`)
      if (data.driver) {
        console.log(`    driver: "${data.driver.fullName}", segment: ${data.driver.segment}`)
      }
    })
  }

  // 3. Start Conversation API
  console.log('\n--- Start Conversation API ---')

  await test('Missing fields returns 400', async () => {
    const res = await fetch(`${BASE}/api/contacts/start-conversation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    assert(res.status === 400, `Expected 400, got ${res.status}`)
  })

  await test('Yandex Pro returns CHANNEL_READONLY', async () => {
    const res = await fetch(`${BASE}/api/contacts/start-conversation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: '+79221234567', channel: 'yandex_pro' }),
    })
    assert(res.status === 400, `Expected 400, got ${res.status}`)
    const data = await res.json()
    assert(data.error === 'CHANNEL_READONLY', `Expected CHANNEL_READONLY, got ${data.error}`)
  })

  await test('Invalid phone returns INVALID_PHONE', async () => {
    const res = await fetch(`${BASE}/api/contacts/start-conversation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: 'abc', channel: 'telegram' }),
    })
    assert(res.status === 400, `Expected 400, got ${res.status}`)
    const data = await res.json()
    assert(data.error === 'INVALID_PHONE', `Expected INVALID_PHONE, got ${data.error}`)
  })

  // 4. Contacts/:id/chats API
  console.log('\n--- Contacts/:id/chats API ---')

  if (searchResults && searchResults.length > 0) {
    const contactId = searchResults[0].id
    await test('CHANNEL_READONLY for yandex_pro', async () => {
      const res = await fetch(`${BASE}/api/contacts/${contactId}/chats`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel: 'yandex_pro' }),
      })
      assert(res.status === 400, `Expected 400, got ${res.status}`)
    })

    await test('Missing channel returns 400', async () => {
      const res = await fetch(`${BASE}/api/contacts/${contactId}/chats`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      assert(res.status === 400, `Expected 400, got ${res.status}`)
    })
  }

  console.log('\n=== Tests Complete ===\n')
}

main().catch(err => {
  console.error('Fatal:', err.message)
  process.exit(1)
})
