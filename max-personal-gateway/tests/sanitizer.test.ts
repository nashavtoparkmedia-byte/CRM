import assert from 'node:assert/strict'
import test from 'node:test'
import { RAW_EVENT_SANITIZER_VERSION, sanitizeRawObservationPayload } from '../src/journal/sanitizer.ts'

test('sanitizer recursively redacts credential categories, bearer values, and signed URL queries', () => {
  const input = {
    Authorization: 'Bearer synthetic-auth-value',
    cookie: 'synthetic-cookie-value',
    nested: {
      Password: 'synthetic-password',
      accessToken: 'synthetic-access',
      REFRESH_TOKEN: 'synthetic-refresh',
      sessionSecret: 'synthetic-session',
      privateKey: 'synthetic-private-key',
      values: [
        { clientSecret: 'synthetic-client-secret' },
        'Bearer synthetic-array-token',
        'https://example.invalid/file?signature=synthetic-signature&expires=999&safe=kept',
      ],
    },
  }
  const original = structuredClone(input)
  const first = sanitizeRawObservationPayload(input)
  const second = sanitizeRawObservationPayload(input)
  const serialized = JSON.stringify(first.sanitizedPayload)

  assert.deepEqual(input, original)
  assert.deepEqual(first, second)
  for (const secret of ['synthetic-auth-value', 'synthetic-cookie-value', 'synthetic-password', 'synthetic-access',
    'synthetic-refresh', 'synthetic-session', 'synthetic-private-key', 'synthetic-client-secret',
    'synthetic-array-token', 'synthetic-signature']) {
    assert.equal(serialized.includes(secret), false)
  }
  assert.equal(serialized.includes('safe=kept'), true)
  assert.equal(first.sanitizerVersion, RAW_EVENT_SANITIZER_VERSION)
  assert.ok(first.redactionMetadata.categories.includes('authorization'))
  assert.ok(first.redactionMetadata.categories.includes('cookie'))
  assert.ok(first.redactionMetadata.categories.includes('password'))
  assert.ok(first.redactionMetadata.categories.includes('signed_url_query'))
  assert.ok(first.redactionMetadata.paths.length >= 10)
})

test('mixed-case keys, arrays, malformed values, cycles, and private-key text fail closed without input mutation', () => {
  const cyclic: { TOKEN: string; self?: unknown; array: unknown[] } = {
    TOKEN: 'synthetic-token',
    array: [undefined, Number.NaN, () => 'synthetic-function-secret', '-----BEGIN PRIVATE KEY-----\nsynthetic'],
  }
  cyclic.self = cyclic
  const result = sanitizeRawObservationPayload(cyclic)
  const serialized = JSON.stringify(result.sanitizedPayload)

  assert.equal(cyclic.TOKEN, 'synthetic-token')
  assert.equal(cyclic.self, cyclic)
  assert.equal(serialized.includes('synthetic-token'), false)
  assert.equal(serialized.includes('synthetic-function-secret'), false)
  assert.equal(serialized.includes('BEGIN PRIVATE KEY'), false)
  assert.ok(result.redactionMetadata.categories.includes('unsupported_value'))
  assert.ok(result.redactionMetadata.categories.includes('private_key'))
})

test('canonical hashing is deterministic across object key order and changes with safe content', () => {
  const first = sanitizeRawObservationPayload({ b: 2, a: 1 })
  const reordered = sanitizeRawObservationPayload({ a: 1, b: 2 })
  const changed = sanitizeRawObservationPayload({ a: 1, b: 3 })
  assert.equal(first.payloadSha256, reordered.payloadSha256)
  assert.notEqual(first.payloadSha256, changed.payloadSha256)
})

test('PostgreSQL-incompatible NUL is deterministically replaced before durable JSON', () => {
  const result = sanitizeRawObservationPayload({ key: 'before\u0000after', '\u0000key': 'safe' })
  const serialized = JSON.stringify(result.sanitizedPayload)
  assert.equal(serialized.includes('\\u0000'), false)
  assert.match(serialized, /before�after/)
  assert.ok(result.redactionMetadata.categories.includes('postgres_nul_replacement'))
  assert.ok(result.redactionMetadata.paths.includes('$.key'))
})

test('binary inputs use deterministic metadata-only quarantine without retaining bytes', () => {
  const bytes = Uint8Array.from([0, 1, 2, 250, 255])
  const buffer = Buffer.from(bytes)
  const uint8 = new Uint8Array(bytes)
  const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  const first = sanitizeRawObservationPayload(buffer)
  const repeated = sanitizeRawObservationPayload(Buffer.from(bytes))
  const nested = sanitizeRawObservationPayload({ decoded: { bytes: uint8 }, other: arrayBuffer })

  assert.deepEqual(first, repeated)
  assert.equal(first.replayAvailability, 'quarantined')
  assert.equal(first.quarantineReason, 'binary_payload_not_persisted')
  assert.equal(JSON.stringify(first.sanitizedPayload).includes(buffer.toString('base64')), false)
  assert.match(JSON.stringify(first.sanitizedPayload), /"byteLength":5/)
  assert.match(JSON.stringify(first.sanitizedPayload), /"bytesStored":false/)
  assert.equal(nested.replayAvailability, 'quarantined')
  assert.ok(nested.redactionMetadata.categories.includes('binary_payload'))
})

test('header tuples, header strings, query strings, and nested URLs redact common value locations', () => {
  const result = sanitizeRawObservationPayload({
    headerLines: [
      'Authorization: Bearer synthetic-header-secret',
      'Cookie: sid=synthetic-cookie-secret',
    ],
    headerTuples: [
      ['Authorization', 'Bearer synthetic-tuple-secret'],
      ['Set-Cookie', 'sid=synthetic-set-cookie-secret'],
    ],
    query: 'safe=kept&access_token=synthetic-query-secret',
    nestedUrl: 'https://example.invalid/path?safe=kept&signature=synthetic-url-secret',
    credentialUrl: 'https://synthetic-user:synthetic-password@example.invalid/path',
  })
  const serialized = JSON.stringify(result.sanitizedPayload)

  for (const secret of [
    'synthetic-header-secret',
    'synthetic-cookie-secret',
    'synthetic-tuple-secret',
    'synthetic-set-cookie-secret',
    'synthetic-query-secret',
    'synthetic-url-secret',
    'synthetic-user',
    'synthetic-password',
  ]) assert.equal(serialized.includes(secret), false)
  assert.ok(result.redactionMetadata.categories.includes('authorization'))
  assert.ok(result.redactionMetadata.categories.includes('cookie'))
  assert.ok(result.redactionMetadata.categories.includes('signed_url_query'))
  assert.ok(result.redactionMetadata.categories.includes('url_credentials'))
})

test('Error, accessor, and unexpected class inputs fail closed without exposing values', () => {
  class UnexpectedPayload {
    readonly secret = 'synthetic-class-secret'
  }
  const accessor: Record<string, unknown> = {}
  Object.defineProperty(accessor, 'value', {
    enumerable: true,
    get: () => { throw new Error('synthetic-accessor-secret') },
  })
  const result = sanitizeRawObservationPayload({
    error: new Error('synthetic-error-secret'),
    accessor,
    instance: new UnexpectedPayload(),
  })
  const serialized = JSON.stringify(result.sanitizedPayload)

  assert.equal(result.replayAvailability, 'quarantined')
  assert.equal(result.quarantineReason, 'unsupported_payload')
  assert.equal(serialized.includes('synthetic-error-secret'), false)
  assert.equal(serialized.includes('synthetic-accessor-secret'), false)
  assert.equal(serialized.includes('synthetic-class-secret'), false)
  assert.ok(result.redactionMetadata.categories.includes('unsupported_value'))
})

test('uninspectable proxy fails closed without throwing or reading secret traps', () => {
  const proxy = new Proxy({}, {
    getPrototypeOf: () => { throw new Error('synthetic-proxy-secret') },
  })
  const result = sanitizeRawObservationPayload(proxy)
  const serialized = JSON.stringify(result.sanitizedPayload)

  assert.equal(result.replayAvailability, 'quarantined')
  assert.equal(result.quarantineReason, 'unsupported_payload')
  assert.equal(serialized.includes('synthetic-proxy-secret'), false)
})
