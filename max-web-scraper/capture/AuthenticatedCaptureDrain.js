'use strict'

const crypto = require('crypto')
const http = require('http')

const AUTH_VERSION = 'max-capture-hmac-v1'

function bodyHash(body) {
  return crypto.createHash('sha256').update(body).digest('hex')
}

function signCaptureRequest(secret, keyId, method, pathname, timestamp, body) {
  const input = `${AUTH_VERSION}\n${method.toUpperCase()}\n${pathname}\n${timestamp}\n${bodyHash(body)}`
  return {
    keyId,
    timestamp,
    signature: crypto.createHmac('sha256', secret).update(input).digest('hex'),
  }
}

function privateIngressUrl(value) {
  let parsed
  try { parsed = new URL(value) } catch { throw Object.assign(new Error('invalid ingress URL'), { code: 'INGRESS_CONFIG_INVALID' }) }
  const allowedHost = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost'
    || parsed.hostname === '::1' || parsed.hostname === 'max-personal-gateway'
  if (parsed.protocol !== 'http:' || !allowedHost || parsed.pathname !== '/v1/capture'
    || parsed.search || parsed.hash || parsed.username || parsed.password) {
    throw Object.assign(new Error('ingress URL must be exact and private'), { code: 'INGRESS_CONFIG_INVALID' })
  }
  return parsed
}

class AuthenticatedCaptureDrain {
  constructor({ spool, endpoint, keyId, secret, healthSnapshot, intervalMs = 1000, requestTimeoutMs = 5000, batchSize = 100 }) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(String(keyId || ''))
      || Buffer.byteLength(String(secret || '')) < 32) {
      throw Object.assign(new Error('capture authentication config invalid'), { code: 'INGRESS_CONFIG_INVALID' })
    }
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 100 || intervalMs > 60000
      || !Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 100 || requestTimeoutMs > 30000
      || !Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 1000) {
      throw Object.assign(new Error('capture drain bounds invalid'), { code: 'INGRESS_CONFIG_INVALID' })
    }
    this.spool = spool
    this.endpoint = privateIngressUrl(endpoint)
    this.keyId = keyId
    this.secret = secret
    this.healthSnapshot = healthSnapshot
    this.intervalMs = intervalMs
    this.requestTimeoutMs = requestTimeoutMs
    this.batchSize = batchSize
    this.timer = null
    this.running = null
    this.stopped = true
    this.retryCount = 0
    this.rejectedCount = 0
    this.acknowledgedCount = 0
    this.lastSuccessfulJournalAck = null
    this.lastErrorCode = null
  }

  start() {
    if (!this.stopped) return
    this.stopped = false
    this._schedule(0)
  }

  async drainOnce() {
    if (this.running) return this.running
    this.running = this._drainBatch()
    try { return await this.running } finally { this.running = null }
  }

  async _drainBatch() {
    const pending = this.spool.readPending(this.batchSize)
    let acknowledged = 0
    for (const record of pending) {
      try {
        const response = await this._post(record.envelope)
        if (response.captureEnvelopeId !== record.envelope.captureEnvelopeId
          || typeof response.observationId !== 'string' || response.observationId.length === 0) {
          throw Object.assign(new Error('invalid ingress acknowledgement'), { code: 'INGRESS_ACK_INVALID' })
        }
        this.spool.markAcknowledged(record.sequence)
        acknowledged += 1
        this.acknowledgedCount += 1
        this.lastSuccessfulJournalAck = new Date().toISOString()
        this.lastErrorCode = null
      } catch (error) {
        this.retryCount += 1
        this.lastErrorCode = error && error.code ? error.code : 'INGRESS_UNAVAILABLE'
        this.spool.noteRetry(this.lastErrorCode)
        break
      }
    }
    if (acknowledged > 0) this.spool.compactAcknowledged()
    return { attempted: pending.length, acknowledged, retained: pending.length - acknowledged }
  }

  async _post(envelope) {
    const body = Buffer.from(JSON.stringify({ envelope, producerHealth: this.healthSnapshot() }))
    const timestamp = String(Date.now())
    const signed = signCaptureRequest(this.secret, this.keyId, 'POST', this.endpoint.pathname, timestamp, body)
    return new Promise((resolve, reject) => {
      const request = http.request({
        protocol: this.endpoint.protocol,
        hostname: this.endpoint.hostname,
        port: this.endpoint.port || 80,
        method: 'POST',
        path: this.endpoint.pathname,
        headers: {
          'content-type': 'application/json',
          'content-length': body.length,
          'x-max-capture-key-id': signed.keyId,
          'x-max-capture-timestamp': signed.timestamp,
          'x-max-capture-signature': signed.signature,
        },
        timeout: this.requestTimeoutMs,
        agent: false,
      }, response => {
        const chunks = []
        let bytes = 0
        response.on('data', chunk => {
          bytes += chunk.length
          if (bytes > 64 * 1024) response.destroy(Object.assign(new Error('ack too large'), { code: 'INGRESS_ACK_INVALID' }))
          else chunks.push(Buffer.from(chunk))
        })
        response.on('end', () => {
          if (response.statusCode !== 200 && response.statusCode !== 201) {
            this.rejectedCount += 1
            reject(Object.assign(new Error('ingress rejected'), { code: `INGRESS_HTTP_${response.statusCode || 0}` }))
            return
          }
          try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
          catch { reject(Object.assign(new Error('invalid ack'), { code: 'INGRESS_ACK_INVALID' })) }
        })
      })
      request.once('timeout', () => request.destroy(Object.assign(new Error('ingress timeout'), { code: 'INGRESS_TIMEOUT' })))
      request.once('error', reject)
      request.end(body)
    })
  }

  async stopAndFlush(timeoutMs = 2000) {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    const operation = this.running || this.drainOnce()
    return Promise.race([
      operation,
      new Promise(resolve => setTimeout(() => resolve(null), timeoutMs)),
    ])
  }

  close() {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  _schedule(delay) {
    if (this.stopped) return
    this.timer = setTimeout(async () => {
      this.timer = null
      let retained = 1
      try {
        const result = await this.drainOnce()
        retained = result.retained
      } catch (error) {
        this.retryCount += 1
        this.lastErrorCode = error && error.code ? error.code : 'SPOOL_READ_FAILURE'
        try { this.spool.noteRetry(this.lastErrorCode) } catch {}
      }
      this._schedule(retained > 0 ? Math.min(30000, this.intervalMs * 2) : this.intervalMs)
    }, delay)
    this.timer.unref?.()
  }
}

module.exports = { AUTH_VERSION, AuthenticatedCaptureDrain, privateIngressUrl, signCaptureRequest }
