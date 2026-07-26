import assert from 'node:assert/strict'
import test from 'node:test'
import { sanitizeRouteEvidence } from '../src/route/evidenceSanitizer.ts'

test('route evidence redacts authorization, cookie, bearer, signed URL, and does not mutate input', () => {
  const input = {
    Authorization: 'Bearer synthetic-authorization-secret',
    cookie: 'sid=synthetic-cookie-secret',
    url: 'https://example.invalid/path?safe=kept&signature=synthetic-signature-secret',
    nested: { accessToken: 'synthetic-access-secret' },
  }
  const original = structuredClone(input)
  const result = sanitizeRouteEvidence(input)
  const serialized = JSON.stringify(result.sanitizedEvidence)

  assert.deepEqual(input, original)
  for (const secret of [
    'synthetic-authorization-secret', 'synthetic-cookie-secret',
    'synthetic-signature-secret', 'synthetic-access-secret',
  ]) assert.equal(serialized.includes(secret), false)
  assert.equal(serialized.includes('safe=kept'), true)
  assert.ok(result.redactionMetadata.categories.includes('authorization'))
  assert.ok(result.redactionMetadata.categories.includes('cookie'))
  assert.ok(result.redactionMetadata.categories.includes('signed_url_query'))
})

test('oversized route evidence stores metadata-only quarantine and a later observation remains usable', () => {
  const oversizedSecret = `synthetic-oversized-secret-${'x'.repeat(2048)}`
  const oversized = sanitizeRouteEvidence({ Authorization: oversizedSecret, safe: 'y'.repeat(2048) }, 256)
  const serialized = JSON.stringify(oversized.sanitizedEvidence)

  assert.equal(oversized.evidenceQuarantined, true)
  assert.match(serialized, /sanitized_evidence_too_large/)
  assert.equal(serialized.includes(oversizedSecret), false)
  assert.equal(serialized.includes('y'.repeat(100)), false)
  assert.ok(oversized.redactionMetadata.categories.includes('oversized_route_evidence'))

  const next = sanitizeRouteEvidence({ safe: 'next-observation' }, 256)
  assert.equal(next.evidenceQuarantined, false)
  assert.equal(JSON.stringify(next.sanitizedEvidence), JSON.stringify({ safe: 'next-observation' }))
})
