'use strict'

const { createHash, createHmac, timingSafeEqual } = require('node:crypto')

const AUTH_NAMESPACE = 'personal-max-sender-v1'

class SenderAuthenticationError extends Error {
  constructor(code) {
    super('Sender authentication refused')
    this.name = 'SenderAuthenticationError'
    this.code = code
  }
}

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

class InMemorySenderReplayStore {
  constructor() { this.entries = new Map() }

  consume(key, expiresAt, now) {
    for (const [entry, expiry] of this.entries) if (expiry <= now) this.entries.delete(entry)
    if (this.entries.has(key)) return false
    this.entries.set(key, expiresAt)
    return true
  }
}

class SenderAuthenticator {
  constructor({ keyResolver, replayStore, clock = () => new Date(), replayWindowMilliseconds = 60_000 }) {
    if (typeof keyResolver !== 'function' || !replayStore || typeof replayStore.consume !== 'function') throw new Error('Sender authenticator dependencies are invalid')
    this.keyResolver = keyResolver
    this.replayStore = replayStore
    this.clock = clock
    this.replayWindowMilliseconds = replayWindowMilliseconds
  }

  authenticate(request, auth) {
    if (!auth || typeof auth !== 'object') throw new SenderAuthenticationError('AUTH_MISSING')
    if (auth.namespace !== AUTH_NAMESPACE) throw new SenderAuthenticationError('AUTH_NAMESPACE_INVALID')
    for (const field of ['keyId', 'timestamp', 'nonce', 'bodySha256', 'signature']) {
      if (typeof auth[field] !== 'string' || auth[field].length === 0) throw new SenderAuthenticationError('AUTH_INVALID')
    }
    const now = this.clock()
    const timestamp = new Date(auth.timestamp)
    if (!Number.isFinite(now.valueOf()) || !Number.isFinite(timestamp.valueOf()) || Math.abs(now.valueOf() - timestamp.valueOf()) >= this.replayWindowMilliseconds) {
      throw new SenderAuthenticationError('AUTH_TIMESTAMP_INVALID')
    }
    const secret = this.keyResolver(auth.keyId)
    if (!Buffer.isBuffer(secret) || secret.byteLength < 32) throw new SenderAuthenticationError('AUTH_KEY_UNKNOWN')
    const bodySha256 = sha256(canonical(request))
    if (auth.bodySha256 !== bodySha256) throw new SenderAuthenticationError('AUTH_BODY_DIGEST_INVALID')
    const signingInput = `${AUTH_NAMESPACE}\n${auth.keyId}\n${auth.timestamp}\n${auth.nonce}\n${bodySha256}`
    const expected = createHmac('sha256', secret).update(signingInput).digest()
    if (!/^[0-9a-f]{64}$/.test(auth.signature)) throw new SenderAuthenticationError('AUTH_SIGNATURE_INVALID')
    const supplied = Buffer.from(auth.signature, 'hex')
    if (supplied.byteLength !== expected.byteLength || !timingSafeEqual(supplied, expected)) throw new SenderAuthenticationError('AUTH_SIGNATURE_INVALID')
    const replayKey = `${AUTH_NAMESPACE}\0${auth.keyId}\0${auth.nonce}`
    if (!this.replayStore.consume(replayKey, timestamp.valueOf() + this.replayWindowMilliseconds, now.valueOf())) {
      throw new SenderAuthenticationError('AUTH_REPLAY')
    }
    return Object.freeze({ keyId: auth.keyId, nonce: auth.nonce, bodySha256, authenticatedAt: new Date(now) })
  }
}

function signForSyntheticTest(request, { keyId, secret, timestamp, nonce }) {
  const bodySha256 = sha256(canonical(request))
  const timestampText = timestamp.toISOString()
  const signature = createHmac('sha256', secret).update(`${AUTH_NAMESPACE}\n${keyId}\n${timestampText}\n${nonce}\n${bodySha256}`).digest('hex')
  return Object.freeze({ namespace: AUTH_NAMESPACE, keyId, timestamp: timestampText, nonce, bodySha256, signature })
}

module.exports = { AUTH_NAMESPACE, InMemorySenderReplayStore, SenderAuthenticationError, SenderAuthenticator, canonical, signForSyntheticTest }
