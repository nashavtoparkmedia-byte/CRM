'use strict'

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const CAPTURE_ENVELOPE_VERSION = 1
const CAPTURE_ADAPTER_VERSION = 'max-live-capture-adapter-v1'
const SANITIZER_VERSION = 'max-raw-sanitizer-v1'
const MAX_RECORD_BYTES = 1024 * 1024
const SEGMENT_BYTES = 4 * 1024 * 1024

const validAccount = value => /^(?!true$|false$)[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/i.test(String(value || ''))

function isLiveCaptureEnabled(raw, accountId) {
  if (!validAccount(accountId)) return false
  const values = String(raw || '').split(',').map(value => value.trim()).filter(Boolean)
  return values.length > 0 && values.every(validAccount) && new Set(values).has(accountId)
}

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
}

const SENSITIVE_KEY = /^(authorization|proxy-authorization|cookie|set-cookie|cookies|password|passwd|passphrase|access[_-]?token|refresh[_-]?token|session(?:[_-]?(?:secret|token|id))?|private[_-]?key|client[_-]?secret|(?:x[_-]?)?api[_-]?key|x[_-]?auth[_-]?token|secret|credential|token|bearer[_-]?token)$/i
const SENSITIVE_QUERY = /^(access_token|auth|authorization|code|credential|expires|key|password|refresh_token|session|sig|signature|token)$/i

function sanitizeString(value, evidence, location) {
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i.test(value)
    || /(?:^|\s)Bearer\s+\S+/i.test(value)
    || /^\s*(?:authorization|proxy-authorization|cookie|set-cookie)\s*:/i.test(value)) {
    evidence.push(location)
    return '[REDACTED:credential]'
  }
  try {
    const url = new URL(value)
    let changed = false
    if (url.username || url.password) {
      url.username = '[REDACTED]'
      url.password = '[REDACTED]'
      changed = true
    }
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_QUERY.test(key)) {
        url.searchParams.set(key, '[REDACTED]')
        evidence.push(`${location}.query.${key}`)
        changed = true
      }
    }
    if (changed) return url.toString()
  } catch {}
  return value
}

function sanitizeValue(value, evidence, location = '$', seen = new WeakSet(), depth = 0) {
  if (depth > 40) return { $quarantine: { reason: 'unsupported_payload', kind: 'max_depth' } }
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'string') return sanitizeString(value, evidence, location)
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'object') return { $quarantine: { reason: 'unsupported_payload', kind: typeof value } }
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) {
    const bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength)
    return { $quarantine: { reason: 'binary_payload_not_persisted', byteLength: bytes.length, sha256: hash(bytes), bytesStored: false } }
  }
  if (seen.has(value)) return { $quarantine: { reason: 'unsupported_payload', kind: 'circular_reference' } }
  seen.add(value)
  try {
    if (Array.isArray(value)) return value.slice(0, 10000).map((item, index) => sanitizeValue(item, evidence, `${location}[${index}]`, seen, depth + 1))
    const output = {}
    for (const key of Object.keys(value).sort().slice(0, 10000)) {
      const child = `${location}.${key}`
      if (SENSITIVE_KEY.test(key)) {
        output[key] = '[REDACTED:credential]'
        evidence.push(child)
      } else {
        output[key] = sanitizeValue(value[key], evidence, child, seen, depth + 1)
      }
    }
    return output
  } finally {
    seen.delete(value)
  }
}

function sanitizedPhysicalPayload(raw) {
  if (raw.startsWith('b64:')) {
    const bytes = Buffer.from(raw.slice(4), 'base64')
    const sanitizedPayload = {
      $quarantine: {
        reason: 'binary_payload_not_persisted',
        sourceType: 'MAXWebSocketBinary',
        byteLength: bytes.length,
        sha256: hash(bytes),
        bytesStored: false,
      },
    }
    const value = canonical(sanitizedPayload)
    return {
      sanitizedPayload,
      payloadSha256: hash(value),
      payloadSizeBytes: Buffer.byteLength(value),
      replayAvailability: 'quarantined',
      quarantineReason: 'binary_payload_not_persisted',
      redactionMetadata: { sanitizerVersion: SANITIZER_VERSION, categories: ['binary_payload'], paths: ['$'] },
      payloadEncoding: 'msgpack_sanitized_json',
    }
  }
  let parsed
  try { parsed = JSON.parse(raw) } catch { parsed = raw }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    && Object.prototype.hasOwnProperty.call(parsed, 'opcode')
    && Object.prototype.hasOwnProperty.call(parsed, 'payload')) {
    parsed = parsed.payload
  }
  const evidence = []
  const sanitizedPayload = sanitizeValue(parsed, evidence)
  const value = canonical(sanitizedPayload)
  return {
    sanitizedPayload,
    payloadSha256: hash(value),
    payloadSizeBytes: Buffer.byteLength(value),
    replayAvailability: typeof parsed === 'string' ? 'quarantined' : 'available',
    quarantineReason: typeof parsed === 'string' ? 'unsupported_payload' : null,
    redactionMetadata: {
      sanitizerVersion: SANITIZER_VERSION,
      categories: evidence.length > 0 ? ['credential'] : [],
      paths: [...new Set(evidence)].sort(),
    },
    payloadEncoding: typeof parsed === 'string' ? 'text_sanitized' : 'json',
  }
}

class RuntimeCaptureSpool {
  constructor(directory, maxTotalBytes) {
    if (!path.isAbsolute(directory)) throw new Error('capture spool path must be absolute')
    this.directory = directory
    this.maxTotalBytes = maxTotalBytes
    this.records = 0
    this.bytes = 0
    this.oldestCapturedAt = null
    this.quarantinedCount = 0
    this.critical = false
    this.lastErrorCode = null
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
    fs.chmodSync(directory, 0o700)
    fs.mkdirSync(path.join(directory, 'quarantine'), { recursive: true, mode: 0o700 })
    fs.chmodSync(path.join(directory, 'quarantine'), 0o700)
    this.nextSequence = this._recoverNextSequence()
  }

  append(envelope) {
    const sequence = this.nextSequence
    const recordBody = JSON.stringify({ spoolVersion: 1, sequence, envelope })
    const line = `${JSON.stringify({ ...JSON.parse(recordBody), checksum: hash(recordBody) })}\n`
    const size = Buffer.byteLength(line)
    if (size > MAX_RECORD_BYTES) throw Object.assign(new Error('capture record too large'), { code: 'SPOOL_RECORD_TOO_LARGE' })
    if (this._diskBytes() + size > this.maxTotalBytes) throw Object.assign(new Error('capture spool full'), { code: 'SPOOL_FULL' })
    const file = this._activeSegment(sequence, size)
    const descriptor = fs.openSync(file, 'a', 0o600)
    try {
      fs.writeSync(descriptor, line, null, 'utf8')
      fs.fsyncSync(descriptor)
      fs.chmodSync(file, 0o600)
    } finally {
      fs.closeSync(descriptor)
    }
    const directoryDescriptor = fs.openSync(this.directory, 'r')
    try { fs.fsyncSync(directoryDescriptor) } finally { fs.closeSync(directoryDescriptor) }
    this.nextSequence += 1
    this.records += 1
    this.bytes += size
    const capturedAt = Date.parse(envelope.capturedAt)
    if (Number.isFinite(capturedAt)) this.oldestCapturedAt = Math.min(this.oldestCapturedAt ?? capturedAt, capturedAt)
    return { sequence, bytes: size }
  }

  _segments() {
    return fs.readdirSync(this.directory).filter(name => /^segment-\d{20}(?:-[a-z0-9-]+)?\.jsonl$/.test(name)).sort()
  }

  _recoverNextSequence() {
    let maximum = 0
    const sequences = new Set()
    for (const name of this._segments()) {
      const file = path.join(this.directory, name)
      const raw = fs.readFileSync(file, 'utf8')
      const valid = []
      let corrupt = raw.length > 0 && !raw.endsWith('\n')
      for (const line of raw.split('\n').filter(Boolean)) {
        try {
          const parsed = JSON.parse(line)
          const recordBody = JSON.stringify({ spoolVersion: parsed.spoolVersion, sequence: parsed.sequence, envelope: parsed.envelope })
          if (parsed.spoolVersion !== 1 || !Number.isSafeInteger(parsed.sequence) || parsed.sequence < 1
            || parsed.checksum !== hash(recordBody) || sequences.has(parsed.sequence)) throw new Error('record')
          sequences.add(parsed.sequence)
          maximum = Math.max(maximum, parsed.sequence)
          valid.push(`${line}\n`)
          const capturedAt = Date.parse(parsed.envelope && parsed.envelope.capturedAt)
          if (Number.isFinite(capturedAt)) this.oldestCapturedAt = Math.min(this.oldestCapturedAt ?? capturedAt, capturedAt)
        } catch {
          corrupt = true
        }
      }
      if (corrupt) {
        this.critical = true
        this.lastErrorCode = 'SPOOL_CORRUPT'
        this.quarantinedCount += 1
        const quarantine = path.join(this.directory, 'quarantine', `${path.basename(name, '.jsonl')}-${crypto.randomUUID()}.jsonl`)
        fs.renameSync(file, quarantine)
        fs.chmodSync(quarantine, 0o600)
        if (valid.length > 0) {
          const first = JSON.parse(valid[0]).sequence
          const recovered = path.join(
            this.directory,
            `segment-${String(first).padStart(20, '0')}-recovered-${crypto.randomUUID()}.jsonl`,
          )
          fs.writeFileSync(recovered, valid.join(''), { mode: 0o600, flag: 'wx' })
          const descriptor = fs.openSync(recovered, 'r')
          try { fs.fsyncSync(descriptor) } finally { fs.closeSync(descriptor) }
        }
      }
      this.records += valid.length
      this.bytes += valid.reduce((sum, line) => sum + Buffer.byteLength(line), 0)
    }
    return maximum + 1
  }

  _activeSegment(sequence, size) {
    const current = this._segments().at(-1)
    if (current) {
      const file = path.join(this.directory, current)
      if (fs.statSync(file).size + size <= SEGMENT_BYTES) return file
    }
    return path.join(this.directory, `segment-${String(sequence).padStart(20, '0')}.jsonl`)
  }

  _diskBytes() {
    const bytesIn = directory => fs.readdirSync(directory, { withFileTypes: true }).reduce((sum, entry) => {
      const target = path.join(directory, entry.name)
      return sum + (entry.isDirectory() ? bytesIn(target) : fs.statSync(target).size)
    }, 0)
    return bytesIn(this.directory)
  }
}

class NoopCaptureAdapter {
  constructor() { this.enabled = false }
  capturePhysicalFrame() { return { captured: false, reason: 'disabled' } }
  getCaptureHealth() {
    return {
      enabled: false, adapterState: 'disabled', spoolPendingCount: 0, spoolPendingBytes: 0,
      oldestPendingAgeMs: null, acknowledgedCount: 0, retryCount: 0, rejectedCount: 0,
      quarantinedCount: 0, lostBeforeSpoolCount: 0, lastSuccessfulJournalAck: null,
      lastDrainErrorCode: null, captureEnvelopeIdCollisionCount: 0, ingressIdempotentRetryCount: 0,
    }
  }
  close() {}
}

class CriticalCaptureAdapter {
  constructor(errorCode = 'SPOOL_IO_FAILURE') {
    this.enabled = true
    this.errorCode = errorCode
    this.lostBeforeSpoolCount = 0
  }
  capturePhysicalFrame() {
    this.lostBeforeSpoolCount += 1
    return { captured: false, errorCode: this.errorCode }
  }
  getCaptureHealth() {
    return {
      enabled: true, adapterState: 'critical', spoolPendingCount: 0, spoolPendingBytes: 0,
      oldestPendingAgeMs: null, acknowledgedCount: 0, retryCount: 0, rejectedCount: 0,
      quarantinedCount: 0, lostBeforeSpoolCount: this.lostBeforeSpoolCount,
      lastSuccessfulJournalAck: null, lastDrainErrorCode: this.errorCode,
      captureEnvelopeIdCollisionCount: 0, ingressIdempotentRetryCount: 0,
    }
  }
  close() {}
}

class LiveCaptureAdapter {
  constructor({ accountId, spoolPath, maxSpoolBytes = 256 * 1024 * 1024, clock = () => new Date(), idGenerator = () => crypto.randomUUID() }) {
    this.enabled = true
    this.accountId = accountId
    this.clock = clock
    this.idGenerator = idGenerator
    this.sessionGeneration = crypto.randomUUID()
    this.spool = new RuntimeCaptureSpool(spoolPath, maxSpoolBytes)
    this.lostBeforeSpoolCount = 0
    this.lastDrainErrorCode = null
  }

  capturePhysicalFrame({ raw, metadata }) {
    const sanitized = sanitizedPhysicalPayload(String(raw))
    const now = this.clock().toISOString()
    const envelope = Object.freeze({
      captureEnvelopeId: this.idGenerator(),
      captureEnvelopeVersion: CAPTURE_ENVELOPE_VERSION,
      accountId: this.accountId,
      observedAt: metadata.observedAt || now,
      sourceTransport: 'max_websocket',
      sourceOrigin: metadata.sourceOrigin || 'unknown',
      socketGeneration: String(metadata.socketGeneration || 'socket-unknown'),
      sessionGeneration: this.sessionGeneration,
      frameId: metadata.frameId == null ? null : String(metadata.frameId),
      providerEventId: metadata.providerEventId == null ? null : String(metadata.providerEventId),
      transportSequence: metadata.transportSequence == null ? null : String(metadata.transportSequence),
      opcode: Number.isInteger(metadata.opcode) ? metadata.opcode : null,
      eventType: metadata.eventType == null ? null : String(metadata.eventType),
      payloadEncoding: sanitized.payloadEncoding,
      sanitizedPayload: sanitized.sanitizedPayload,
      payloadSha256: sanitized.payloadSha256,
      payloadSizeBytes: sanitized.payloadSizeBytes,
      replayAvailability: sanitized.replayAvailability,
      quarantineReason: sanitized.quarantineReason,
      redactionMetadata: sanitized.redactionMetadata,
      sanitizerVersion: SANITIZER_VERSION,
      captureAdapterVersion: CAPTURE_ADAPTER_VERSION,
      capturedAt: now,
      retryCount: 0,
      safeMetadata: { boundary: 'TransportInterceptor._handleFrame' },
    })
    try {
      const persisted = this.spool.append(envelope)
      return { captured: true, envelope, sequence: persisted.sequence }
    } catch (error) {
      this.lostBeforeSpoolCount += 1
      this.lastDrainErrorCode = error && error.code ? error.code : 'SPOOL_IO_FAILURE'
      return { captured: false, errorCode: this.lastDrainErrorCode }
    }
  }

  getCaptureHealth() {
    const diskRatio = this.spool._diskBytes() / this.spool.maxTotalBytes
    const adapterState = this.lostBeforeSpoolCount > 0 || this.spool.critical || diskRatio >= 0.9
      ? 'critical'
      : diskRatio >= 0.7 ? 'degraded' : 'healthy'
    return {
      enabled: true,
      adapterState,
      spoolPendingCount: this.spool.records,
      spoolPendingBytes: this.spool.bytes,
      oldestPendingAgeMs: this.spool.oldestCapturedAt === null
        ? null
        : Math.max(0, this.clock().valueOf() - this.spool.oldestCapturedAt),
      acknowledgedCount: 0,
      retryCount: 0,
      rejectedCount: 0,
      quarantinedCount: this.spool.quarantinedCount,
      lostBeforeSpoolCount: this.lostBeforeSpoolCount,
      lastSuccessfulJournalAck: null,
      lastDrainErrorCode: this.lastDrainErrorCode || this.spool.lastErrorCode,
      captureEnvelopeIdCollisionCount: 0,
      ingressIdempotentRetryCount: 0,
    }
  }

  close() {}
}

function createLiveCaptureAdapterFromEnvironment(environment = process.env) {
  const accountId = String(environment.MAX_PERSONAL_ACCOUNT_ID || '')
  if (!isLiveCaptureEnabled(environment.MAX_PERSONAL_LIVE_CAPTURE_ENABLED, accountId)) {
    return new NoopCaptureAdapter()
  }
  const spoolPath = String(environment.MAX_PERSONAL_CAPTURE_SPOOL_PATH || '')
  if (!path.isAbsolute(spoolPath)) return new NoopCaptureAdapter()
  const configuredBytes = Number(environment.MAX_PERSONAL_CAPTURE_SPOOL_MAX_BYTES || 256 * 1024 * 1024)
  if (!Number.isSafeInteger(configuredBytes) || configuredBytes < MAX_RECORD_BYTES) return new NoopCaptureAdapter()
  try { return new LiveCaptureAdapter({ accountId, spoolPath, maxSpoolBytes: configuredBytes }) }
  catch (error) { return new CriticalCaptureAdapter(error && error.code ? error.code : 'SPOOL_IO_FAILURE') }
}

module.exports = {
  CAPTURE_ADAPTER_VERSION,
  CAPTURE_ENVELOPE_VERSION,
  SANITIZER_VERSION,
  LiveCaptureAdapter,
  CriticalCaptureAdapter,
  NoopCaptureAdapter,
  createLiveCaptureAdapterFromEnvironment,
  isLiveCaptureEnabled,
}
