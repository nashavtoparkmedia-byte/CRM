'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const http = require('node:http')

const endpoint = new URL('http://max-personal-gateway:8080/v1/capture')
const secret = process.env.MAX_PERSONAL_CAPTURE_HMAC_SECRET
const keyId = process.env.MAX_PERSONAL_CAPTURE_HMAC_KEY_ID
assert.ok(typeof secret === 'string' && Buffer.byteLength(secret) >= 32)
assert.ok(typeof keyId === 'string' && keyId.length > 0)

function signature(body, timestamp, selectedSecret = secret) {
  const bodyHash = crypto.createHash('sha256').update(body).digest('hex')
  const input = `max-capture-hmac-v1\nPOST\n/v1/capture\n${timestamp}\n${bodyHash}`
  return crypto.createHmac('sha256', selectedSecret).update(input).digest('hex')
}

function request(body, headers = {}) {
  return new Promise((resolve, reject) => {
    const operation = http.request({
      hostname: endpoint.hostname, port: endpoint.port, method: 'POST', path: endpoint.pathname,
      headers: { 'content-type': 'application/json', 'content-length': body.length, ...headers },
      timeout: 10000,
    }, response => {
      const chunks = []
      response.on('data', chunk => chunks.push(Buffer.from(chunk)))
      response.on('end', () => {
        let parsed = null
        try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch {}
        resolve({ status: response.statusCode, body: parsed })
      })
    })
    operation.once('timeout', () => operation.destroy(new Error('timeout')))
    operation.once('error', reject)
    operation.end(body)
  })
}

function envelope(accountId, id = crypto.randomUUID()) {
  const now = new Date().toISOString()
  return {
    captureEnvelopeId: id, captureEnvelopeVersion: 1, accountId, observedAt: now,
    sourceTransport: 'max_websocket', sourceOrigin: 'unknown', socketGeneration: 'synthetic',
    sessionGeneration: 'synthetic', frameId: null, providerEventId: null, transportSequence: null,
    opcode: null, eventType: 'stage8b1i-idempotency', payloadEncoding: 'json',
    sanitizedPayload: { kind: 'message', direction: 'inbound', providerMessageId: 'stage8b1i-idempotency', text: 'synthetic' },
    payloadSha256: crypto.createHash('sha256').update('stage8b1i-idempotency').digest('hex'),
    payloadSizeBytes: 24, replayAvailability: 'available', quarantineReason: null,
    redactionMetadata: { sanitizerVersion: 'max-live-capture-sanitizer-v1', categories: [], paths: [] },
    sanitizerVersion: 'max-live-capture-sanitizer-v1', captureAdapterVersion: 'max-live-capture-adapter-v1',
    capturedAt: now, retryCount: 0, safeMetadata: { boundary: 'stage8b1i-synthetic' },
  }
}

function bodyFor(accountId, id) {
  return Buffer.from(JSON.stringify({
    envelope: envelope(accountId, id),
    producerHealth: { adapterState: 'healthy', spoolPendingCount: 1, spoolPendingBytes: 1024,
      oldestPendingAgeMs: 0, lostBeforeSpoolCount: 0, captureEnvelopeIdCollisionCount: 0 },
  }))
}

function signedHeaders(body, selectedSecret = secret) {
  const timestamp = String(Date.now())
  return {
    'x-max-capture-key-id': keyId,
    'x-max-capture-timestamp': timestamp,
    'x-max-capture-signature': signature(body, timestamp, selectedSecret),
  }
}

async function main() {
  const accountA = process.env.STAGE8B1I_ACCOUNT_A
  assert.ok(accountA)
  const missingBody = bodyFor(accountA)
  assert.equal((await request(missingBody)).status, 401)
  assert.equal((await request(missingBody, signedHeaders(missingBody, `${secret}invalid`))).status, 401)

  const wrongBody = bodyFor('stage8b1i-wrong-account')
  assert.equal((await request(wrongBody, signedHeaders(wrongBody))).status, 403)

  const oversized = Buffer.from(JSON.stringify({ padding: 'x'.repeat(1_210_000) }))
  let requestSizeLimited = false
  try { requestSizeLimited = (await request(oversized, signedHeaders(oversized))).status === 413 }
  catch (error) { requestSizeLimited = error?.code === 'ECONNRESET' }
  assert.equal(requestSizeLimited, true)

  const retryId = `stage8b1i-retry-${crypto.randomUUID()}`
  const retryBody = bodyFor(accountA, retryId)
  const first = await request(retryBody, signedHeaders(retryBody))
  const second = await request(retryBody, signedHeaders(retryBody))
  assert.equal(first.status, 201)
  assert.equal(second.status, 200)
  assert.equal(first.body.captureEnvelopeId, retryId)
  assert.equal(second.body.captureEnvelopeId, retryId)
  assert.equal(first.body.observationId, second.body.observationId)
  process.stdout.write(`${JSON.stringify({
    missingAuthDenied: true, invalidAuthDenied: true, wrongAccountDenied: true,
    requestSizeLimit: true, authenticatedIngress: true, idempotentRetry: true,
  })}\n`)
}

main().catch(error => {
  process.stderr.write(`${JSON.stringify({ code: 'GATEWAY_CLIENT_HARNESS_FAILED', name: error?.name || 'Error' })}\n`)
  process.exit(1)
})
