import assert from 'node:assert/strict'
import test from 'node:test'
import { authenticateCaptureRequest, signCaptureRequest } from '../src/runtime/auth.ts'

const secret = 'synthetic-stage8b1-hmac-secret-0000000000000000'
const body = Buffer.from('{"synthetic":true}')

test('HMAC authentication denies missing, invalid, expired and unknown credentials', () => {
  const timestamp = String(Date.now())
  const signed = signCaptureRequest(secret, 'current', 'POST', '/v1/capture', timestamp, body)
  assert.deepEqual(authenticateCaptureRequest({
    keys: new Map([['current', secret]]), method: 'POST', path: '/v1/capture', body,
    keyId: undefined, timestamp: undefined, signature: undefined, maximumClockSkewMs: 30_000,
  }), { authenticated: false, code: 'AUTH_MISSING' })
  assert.equal(authenticateCaptureRequest({
    keys: new Map([['current', secret]]), method: 'POST', path: '/v1/capture', body,
    ...signed, signature: `${signed.signature.slice(0, -1)}0`, maximumClockSkewMs: 30_000,
  }).authenticated, false)
  assert.equal(authenticateCaptureRequest({
    keys: new Map([['other', secret]]), method: 'POST', path: '/v1/capture', body,
    ...signed, maximumClockSkewMs: 30_000,
  }).authenticated, false)
  assert.deepEqual(authenticateCaptureRequest({
    keys: new Map([['current', secret]]), method: 'POST', path: '/v1/capture', body,
    ...signCaptureRequest(secret, 'current', 'POST', '/v1/capture', '1000000000000', body),
    now: 1_000_000_100_000, maximumClockSkewMs: 30_000,
  }), { authenticated: false, code: 'AUTH_EXPIRED' })
})

test('HMAC authentication accepts current and rotation keys using exact method/path/body', () => {
  const timestamp = String(Date.now())
  for (const [keyId, value] of [['current', secret], ['next', `${secret}-rotation`]]) {
    const signed = signCaptureRequest(value, keyId, 'POST', '/v1/capture', timestamp, body)
    assert.deepEqual(authenticateCaptureRequest({
      keys: new Map([['current', secret], ['next', `${secret}-rotation`]]),
      method: 'POST', path: '/v1/capture', body, ...signed, maximumClockSkewMs: 30_000,
    }), { authenticated: true, keyId })
  }
})
