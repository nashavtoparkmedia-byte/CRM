'use strict'

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const SPOOL_VERSION = 1
const MAX_RECORD_BYTES = 64 * 1024
const MAX_RECORDS = 1024
const PROVIDER_MESSAGE_ID = /^d301[0-9a-f]{14}$/i

function spoolError(code, message) {
  return Object.assign(new Error(message), { code })
}

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
}

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function normalizeProviderMessageId(value) {
  const providerMessageId = String(value || '').toLowerCase()
  if (!PROVIDER_MESSAGE_ID.test(providerMessageId)) {
    throw spoolError('OPCODE19_SPOOL_ID_INVALID', 'opcode-19 spool provider message ID is invalid')
  }
  return providerMessageId
}

function recordFilename(providerMessageId) {
  return `${normalizeProviderMessageId(providerMessageId)}.json`
}

function collisionIdentity(record) {
  return {
    providerMessageId: String(record?.providerMessageId || '').toLowerCase(),
    providerTimestampMs: Number(record?.candidate?.providerTimestampMs),
    text: record?.candidate?.text,
    messageType: record?.candidate?.messageType,
    attachmentCount: record?.candidate?.attachmentCount,
    senderProviderUserId: String(record?.candidate?.senderProviderUserId || ''),
    protocolChatId: String(record?.candidate?.protocolChatId || ''),
    senderLow32: String(record?.candidate?.senderLow32 || ''),
    webRouteLow32: String(record?.candidate?.webRouteLow32 || ''),
  }
}

function validCandidateRecord(record, providerMessageId) {
  const candidate = record?.candidate
  return Boolean(
    candidate && typeof candidate === 'object'
    && String(candidate.providerMessageId || '').toLowerCase() === providerMessageId
    && Number.isFinite(Number(candidate.providerTimestampMs))
    && typeof candidate.text === 'string' && candidate.text.length > 0
    && candidate.messageType === 'text'
    && candidate.attachmentCount === 0
    && /^\d{9,15}$/.test(String(candidate.senderProviderUserId || ''))
    && /^\d{11,15}$/.test(String(candidate.protocolChatId || ''))
    && /^\d{1,10}$/.test(String(candidate.senderLow32 || ''))
    && /^\d{1,10}$/.test(String(candidate.webRouteLow32 || ''))
  )
}

class Opcode19DeliverySpool {
  constructor(directory, options = {}) {
    if (!path.isAbsolute(String(directory || ''))) {
      throw spoolError('OPCODE19_SPOOL_PATH_INVALID', 'opcode-19 spool path must be absolute')
    }
    this.directory = path.resolve(directory)
    this.maxRecordBytes = Number.isSafeInteger(options.maxRecordBytes)
      ? options.maxRecordBytes
      : MAX_RECORD_BYTES
    this.maxRecords = Number.isSafeInteger(options.maxRecords)
      ? options.maxRecords
      : MAX_RECORDS
    if (this.maxRecordBytes < 1024 || this.maxRecordBytes > MAX_RECORD_BYTES
      || this.maxRecords < 1 || this.maxRecords > MAX_RECORDS) {
      throw spoolError('OPCODE19_SPOOL_LIMIT_INVALID', 'opcode-19 spool limits are invalid')
    }
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    if ((fs.statSync(this.directory).mode & 0o777) !== 0o700) fs.chmodSync(this.directory, 0o700)
  }

  _syncDirectory() {
    const descriptor = fs.openSync(this.directory, 'r')
    try { fs.fsyncSync(descriptor) } finally { fs.closeSync(descriptor) }
  }

  _path(providerMessageId) {
    return path.join(this.directory, recordFilename(providerMessageId))
  }

  _readFile(file) {
    const stat = fs.lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600
      || stat.size < 2 || stat.size > this.maxRecordBytes) {
      throw spoolError('OPCODE19_SPOOL_CORRUPT', 'opcode-19 spool record size is invalid')
    }
    let parsed
    try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')) } catch {
      throw spoolError('OPCODE19_SPOOL_CORRUPT', 'opcode-19 spool record is not valid JSON')
    }
    const providerMessageId = normalizeProviderMessageId(parsed?.providerMessageId)
    const expectedBody = canonical(parsed?.record)
    if (parsed?.spoolVersion !== SPOOL_VERSION
      || parsed?.contentHash !== hash(expectedBody)
      || parsed?.collisionHash !== hash(canonical(collisionIdentity(parsed?.record)))
      || String(parsed?.record?.providerMessageId || '').toLowerCase() !== providerMessageId
      || !validCandidateRecord(parsed?.record, providerMessageId)
      || path.basename(file) !== recordFilename(providerMessageId)) {
      throw spoolError('OPCODE19_SPOOL_CORRUPT', 'opcode-19 spool record integrity check failed')
    }
    return parsed
  }

  _recordFiles() {
    return fs.readdirSync(this.directory)
      .filter(name => /^d301[0-9a-f]{14}\.json$/i.test(name))
      .sort()
      .map(name => path.join(this.directory, name))
  }

  put(record) {
    if (!record || typeof record !== 'object') {
      throw spoolError('OPCODE19_SPOOL_RECORD_INVALID', 'opcode-19 spool record is invalid')
    }
    const providerMessageId = normalizeProviderMessageId(record.providerMessageId)
    if (!validCandidateRecord(record, providerMessageId)) {
      throw spoolError('OPCODE19_SPOOL_RECORD_INVALID', 'opcode-19 spool candidate identity does not match')
    }
    let body
    try { body = canonical(record) } catch {
      throw spoolError('OPCODE19_SPOOL_RECORD_INVALID', 'opcode-19 spool record is not serializable')
    }
    const contentHash = hash(body)
    const collisionHash = hash(canonical(collisionIdentity(record)))
    const envelope = {
      spoolVersion: SPOOL_VERSION,
      providerMessageId,
      contentHash,
      collisionHash,
      record,
    }
    const serialized = `${JSON.stringify(envelope)}\n`
    if (Buffer.byteLength(serialized) > this.maxRecordBytes) {
      throw spoolError('OPCODE19_SPOOL_RECORD_TOO_LARGE', 'opcode-19 spool record is too large')
    }

    const destination = this._path(providerMessageId)
    if (fs.existsSync(destination)) {
      const existing = this._readFile(destination)
      if (existing.collisionHash !== collisionHash) {
        throw spoolError('OPCODE19_PROVIDER_ID_COLLISION', 'opcode-19 provider ID maps to different durable spool content')
      }
      return { existing: true, providerMessageId, contentHash: existing.contentHash, path: destination }
    }
    if (this._recordFiles().length >= this.maxRecords) {
      throw spoolError('OPCODE19_SPOOL_FULL', 'opcode-19 delivery spool is full')
    }

    const temporary = path.join(
      this.directory,
      `.${providerMessageId}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`,
    )
    let descriptor
    let writeError = null
    try {
      descriptor = fs.openSync(temporary, 'wx', 0o600)
      fs.writeFileSync(descriptor, serialized, 'utf8')
      fs.fsyncSync(descriptor)
      fs.fchmodSync(descriptor, 0o600)
    } catch (error) {
      writeError = error
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor)
    }
    if (writeError) {
      try { fs.unlinkSync(temporary) } catch {}
      throw writeError
    }

    try {
      fs.linkSync(temporary, destination)
      fs.unlinkSync(temporary)
      this._syncDirectory()
      return { existing: false, providerMessageId, contentHash, path: destination }
    } catch (error) {
      try { fs.unlinkSync(temporary) } catch {}
      if (error.code !== 'EEXIST') throw error
      const existing = this._readFile(destination)
      if (existing.collisionHash !== collisionHash) {
        throw spoolError('OPCODE19_PROVIDER_ID_COLLISION', 'opcode-19 provider ID maps to different durable spool content')
      }
      return { existing: true, providerMessageId, contentHash: existing.contentHash, path: destination }
    }
  }

  list() {
    return this._recordFiles()
      .map(file => this._readFile(file))
      .sort((left, right) => {
        const timestampDelta = Number(left.record?.candidate?.providerTimestampMs || 0)
          - Number(right.record?.candidate?.providerTimestampMs || 0)
        return timestampDelta || left.providerMessageId.localeCompare(right.providerMessageId)
      })
  }

  acknowledge(providerMessageId, expectedContentHash) {
    const file = this._path(providerMessageId)
    if (!fs.existsSync(file)) return { removed: false, reason: 'already_absent' }
    const existing = this._readFile(file)
    if (!/^[0-9a-f]{64}$/.test(String(expectedContentHash || ''))
      || existing.contentHash !== expectedContentHash) {
      throw spoolError('OPCODE19_SPOOL_ACK_MISMATCH', 'opcode-19 spool acknowledgement does not match durable content')
    }
    fs.unlinkSync(file)
    this._syncDirectory()
    return { removed: true, providerMessageId: existing.providerMessageId }
  }

  getHealth() {
    const records = this.list()
    return {
      pending: records.length,
      state: records.length > 0 ? 'retained' : 'empty',
    }
  }
}

module.exports = {
  MAX_RECORD_BYTES,
  MAX_RECORDS,
  Opcode19DeliverySpool,
  SPOOL_VERSION,
}
