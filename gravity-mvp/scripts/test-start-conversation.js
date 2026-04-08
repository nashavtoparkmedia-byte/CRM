/**
 * Automated tests for start-conversation flow.
 * Tests 4 scenarios against the API endpoints.
 */

const BASE = 'http://localhost:3002'
const COOKIE = 'crm_user_id=remezov'

let passed = 0
let failed = 0
const results = []

async function api(method, path, body) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: COOKIE },
  }
  if (body) opts.body = JSON.stringify(body)
  const res = await fetch(`${BASE}${path}`, opts)
  const data = await res.json().catch(() => null)
  return { status: res.status, data }
}

function assert(name, condition, detail) {
  if (condition) {
    passed++
    results.push({ name, status: 'OK', detail })
  } else {
    failed++
    results.push({ name, status: 'BUG', detail })
  }
}

// ============================================================
// Test 1: Create chat for existing contact (no chat in channel)
// ============================================================
async function test1() {
  console.log('\n=== Test 1: Existing contact, new channel ===')

  // Find a contact with yandex_pro identity but no telegram chat
  const search = await api('GET', '/api/contacts/search?q=%D0%91%D0%B0%D0%B4%D1%8C%D0%B8%D0%BD') // Бадьин
  const contact = search.data?.contacts?.[0]
  if (!contact) {
    assert('T1: find contact', false, 'Contact not found in search')
    return
  }
  console.log(`  Contact: ${contact.displayName} (${contact.id})`)
  console.log(`  Existing channels: ${JSON.stringify(contact.channels)}`)
  console.log(`  Existing hasChat: ${JSON.stringify(contact.hasChat)}`)

  // Try to create a telegram chat
  const targetChannel = 'telegram'
  const alreadyHasChat = !!contact.hasChat[targetChannel]

  const res = await api('POST', `/api/contacts/${contact.id}/chats`, { channel: targetChannel })
  console.log(`  POST /api/contacts/${contact.id}/chats → ${res.status}`)
  console.log(`  Response: ${JSON.stringify(res.data)}`)

  assert('T1: POST returns 200', res.status === 200, `HTTP ${res.status}`)
  assert('T1: chat.id exists', !!res.data?.chat?.id, res.data?.chat?.id || 'missing')
  assert('T1: isNew correct', res.data?.chat?.isNew === !alreadyHasChat,
    `isNew=${res.data?.chat?.isNew}, expected=${!alreadyHasChat}`)
  assert('T1: channel matches', res.data?.chat?.channel === targetChannel,
    `channel=${res.data?.chat?.channel}`)

  return res.data?.chat?.id
}

// ============================================================
// Test 2: Create chat for new phone number
// ============================================================
async function test2() {
  console.log('\n=== Test 2: New phone number ===')

  // Use a unique phone to avoid collisions
  const testPhone = '+79001112233'
  const targetChannel = 'whatsapp'

  const res = await api('POST', '/api/contacts/start-conversation', {
    phone: testPhone,
    channel: targetChannel,
  })
  console.log(`  POST /api/contacts/start-conversation → ${res.status}`)
  console.log(`  Response: ${JSON.stringify(res.data)}`)

  assert('T2: POST returns 200', res.status === 200, `HTTP ${res.status}`)
  assert('T2: contact created', !!res.data?.contact?.id, res.data?.contact?.id || 'missing')
  assert('T2: chat created', !!res.data?.chat?.id, res.data?.chat?.id || 'missing')
  assert('T2: chat channel matches', res.data?.chat?.channel === targetChannel,
    `channel=${res.data?.chat?.channel}`)

  // Verify contact has identity
  if (res.data?.contact?.id) {
    const contactDetail = await api('GET', `/api/contacts/${res.data.contact.id}`)
    const hasIdentity = contactDetail.data?.identities?.some(i => i.channel === targetChannel)
    assert('T2: identity created', hasIdentity, `identities=${JSON.stringify(contactDetail.data?.identities?.map(i => i.channel))}`)
  }

  return res.data?.chat?.id
}

// ============================================================
// Test 3: Duplicate protection
// ============================================================
async function test3(chatIdFromTest1) {
  console.log('\n=== Test 3: Duplicate protection ===')

  // Search for the same contact as Test 1
  const search = await api('GET', '/api/contacts/search?q=%D0%91%D0%B0%D0%B4%D1%8C%D0%B8%D0%BD')
  const contact = search.data?.contacts?.[0]
  if (!contact) {
    assert('T3: find contact', false, 'Contact not found')
    return
  }

  // Try to create telegram chat again (should return existing)
  const res1 = await api('POST', `/api/contacts/${contact.id}/chats`, { channel: 'telegram' })
  const res2 = await api('POST', `/api/contacts/${contact.id}/chats`, { channel: 'telegram' })

  console.log(`  First call → isNew=${res1.data?.chat?.isNew}, id=${res1.data?.chat?.id}`)
  console.log(`  Second call → isNew=${res2.data?.chat?.isNew}, id=${res2.data?.chat?.id}`)

  assert('T3: both return 200', res1.status === 200 && res2.status === 200,
    `${res1.status}, ${res2.status}`)
  assert('T3: same chatId', res1.data?.chat?.id === res2.data?.chat?.id,
    `${res1.data?.chat?.id} vs ${res2.data?.chat?.id}`)
  assert('T3: second call isNew=false', res2.data?.chat?.isNew === false,
    `isNew=${res2.data?.chat?.isNew}`)

  // Also test start-conversation duplicate protection
  const phone = contact.phones?.[0]?.phone
  if (phone) {
    const res3 = await api('POST', '/api/contacts/start-conversation', {
      phone,
      channel: 'telegram',
    })
    console.log(`  start-conversation with same phone → isNew=${res3.data?.chat?.isNew}`)
    assert('T3: start-conversation no duplicate', res3.data?.chat?.isNew === false,
      `isNew=${res3.data?.chat?.isNew}`)
  }
}

// ============================================================
// Test 4: Loading state validation (API response timing)
// ============================================================
async function test4() {
  console.log('\n=== Test 4: Loading state (API response timing) ===')

  // Verify that API responds quickly (no hang)
  const start = Date.now()
  const res = await api('POST', '/api/contacts/start-conversation', {
    phone: '+79009998877',
    channel: 'telegram',
  })
  const elapsed = Date.now() - start

  console.log(`  API response time: ${elapsed}ms`)
  console.log(`  Status: ${res.status}`)

  assert('T4: API responds in < 5000ms', elapsed < 5000, `${elapsed}ms`)
  assert('T4: API returns valid response', res.status === 200, `HTTP ${res.status}`)
  assert('T4: no hang (< 3000ms)', elapsed < 3000, `${elapsed}ms`)
}

// ============================================================
// Run all tests
// ============================================================
async function main() {
  console.log('Starting start-conversation tests...\n')

  try {
    const chatId1 = await test1()
    await test2()
    await test3(chatId1)
    await test4()
  } catch (err) {
    console.error('FATAL ERROR:', err.message)
    failed++
    results.push({ name: 'FATAL', status: 'BUG', detail: err.message })
  }

  console.log('\n' + '='.repeat(60))
  console.log('RESULTS:')
  console.log('='.repeat(60))
  for (const r of results) {
    const icon = r.status === 'OK' ? '✅' : '❌'
    console.log(`  ${icon} ${r.name}: ${r.status} — ${r.detail}`)
  }
  console.log('='.repeat(60))
  console.log(`  Passed: ${passed}`)
  console.log(`  Failed: ${failed}`)
  console.log(`  Total: ${passed + failed}`)
  console.log('='.repeat(60))

  if (failed > 0) {
    console.log('\n⚠️  SOME TESTS FAILED')
    process.exit(1)
  } else {
    console.log('\n✅ ALL TESTS PASSED')
    process.exit(0)
  }
}

main()
