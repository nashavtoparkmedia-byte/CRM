'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { createHash, randomUUID } = require('node:crypto')

function digest(value) {
  return createHash('sha256').update(String(value)).digest('hex')
}

function durableDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  fs.chmodSync(directory, 0o700)
  return fs.openSync(directory, fs.constants.O_RDONLY)
}

function writeAtomic(filename, value) {
  const directory = path.dirname(filename)
  const temporary = path.join(directory, `.${path.basename(filename)}.${process.pid}.${Date.now()}.tmp`)
  const descriptor = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600)
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(value)}\n`, 'utf8')
    fs.fsyncSync(descriptor)
  } finally {
    fs.closeSync(descriptor)
  }
  fs.renameSync(temporary, filename)
  const directoryDescriptor = fs.openSync(directory, fs.constants.O_RDONLY)
  try { fs.fsyncSync(directoryDescriptor) } finally { fs.closeSync(directoryDescriptor) }
}

function readJson(filename) {
  try {
    const value = JSON.parse(fs.readFileSync(filename, 'utf8'))
    return value && typeof value === 'object' ? value : null
  } catch (error) {
    if (error && error.code === 'ENOENT') return null
    throw error
  }
}

function resolvedUnknown(record) {
  const resolution = record?.resolution
  return record?.response?.outcome === 'UNKNOWN_AFTER_ATTEMPT'
    && resolution?.schemaVersion === 1
    && ['provider_absence_proven', 'operator_dead_letter'].includes(resolution.resolutionType)
    && typeof resolution.resolvedAt === 'string'
    && typeof resolution.evidenceReference === 'string'
    && resolution.evidenceReference.length >= 1
    && resolution.evidenceReference.length <= 512
    && !/[\x00-\x1f\x7f]/.test(resolution.evidenceReference)
}

class DurableSenderReplayStore {
  constructor(directory) {
    this.directory = path.join(directory, 'replay')
    const descriptor = durableDirectory(this.directory)
    fs.closeSync(descriptor)
  }

  consume(key, expiresAt, now) {
    const filename = path.join(this.directory, `${digest(key)}.json`)
    try {
      const descriptor = fs.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600)
      try {
        fs.writeFileSync(descriptor, `${JSON.stringify({ schemaVersion: 1, expiresAt })}\n`, 'utf8')
        fs.fsyncSync(descriptor)
      } finally {
        fs.closeSync(descriptor)
      }
      const directoryDescriptor = fs.openSync(this.directory, fs.constants.O_RDONLY)
      try { fs.fsyncSync(directoryDescriptor) } finally { fs.closeSync(directoryDescriptor) }
      return true
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error
      const prior = readJson(filename)
      if (prior && Number.isFinite(prior.expiresAt) && prior.expiresAt <= now) {
        fs.unlinkSync(filename)
        return this.consume(key, expiresAt, now)
      }
      return false
    }
  }
}

class DurableSenderAttemptStore {
  constructor(directory) {
    this.directory = path.join(directory, 'attempts')
    this.keysDirectory = path.join(directory, 'idempotency')
    this.bootId = randomUUID()
    for (const item of [this.directory, this.keysDirectory]) {
      const descriptor = durableDirectory(item)
      fs.closeSync(descriptor)
    }
  }

  #attemptFile(attemptId) { return path.join(this.directory, `${digest(attemptId)}.json`) }
  #keyFile(accountId, idempotencyKey) { return path.join(this.keysDirectory, `${digest(`${accountId}\0${idempotencyKey}`)}.json`) }

  lookup(request, requestDigest) {
    const byAttempt = readJson(this.#attemptFile(request.attemptId))
    const key = readJson(this.#keyFile(request.accountId, request.idempotencyKey))
    if (byAttempt && key && key.attemptId !== request.attemptId) return { status: 'conflict' }
    const record = byAttempt || (key ? readJson(this.#attemptFile(key.attemptId)) : null)
    if (!record) return { status: 'missing' }
    if (record.requestDigest !== requestDigest) return { status: 'conflict' }
    if (record.state === 'final' && record.response) return { status: 'prior', response: record.response }
    if (record.state === 'physical_action_started') return { status: 'uncertain' }
    return { status: record.bootId === this.bootId ? 'pending_local' : 'pending_recoverable' }
  }

  reserve(request, requestDigest) {
    const attemptFile = this.#attemptFile(request.attemptId)
    const keyFile = this.#keyFile(request.accountId, request.idempotencyKey)
    const existing = this.lookup(request, requestDigest)
    if (existing.status !== 'missing') return existing
    writeAtomic(attemptFile, {
      schemaVersion: 1,
      attemptId: request.attemptId,
      accountId: request.accountId,
      idempotencyKey: request.idempotencyKey,
      requestDigest,
      bootId: this.bootId,
      state: 'reserved',
      updatedAt: new Date().toISOString(),
    })
    try {
      const descriptor = fs.openSync(keyFile, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600)
      try {
        fs.writeFileSync(descriptor, `${JSON.stringify({ schemaVersion: 1, attemptId: request.attemptId })}\n`, 'utf8')
        fs.fsyncSync(descriptor)
      } finally { fs.closeSync(descriptor) }
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error
      return this.lookup(request, requestDigest)
    }
    return { status: 'reserved' }
  }

  claimPending(request, requestDigest) {
    const current = this.lookup(request, requestDigest)
    if (current.status !== 'pending_recoverable') return current
    writeAtomic(this.#attemptFile(request.attemptId), {
      schemaVersion: 1, attemptId: request.attemptId, accountId: request.accountId,
      idempotencyKey: request.idempotencyKey, requestDigest, bootId: this.bootId,
      state: 'reserved', updatedAt: new Date().toISOString(),
    })
    const keyFile = this.#keyFile(request.accountId, request.idempotencyKey)
    if (!readJson(keyFile)) writeAtomic(keyFile, { schemaVersion: 1, attemptId: request.attemptId })
    return { status: 'reserved' }
  }

  markPhysicalStarted(request, requestDigest) {
    writeAtomic(this.#attemptFile(request.attemptId), {
      schemaVersion: 1,
      attemptId: request.attemptId,
      accountId: request.accountId,
      idempotencyKey: request.idempotencyKey,
      requestDigest,
      bootId: this.bootId,
      state: 'physical_action_started',
      physicalActionStartedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
  }

  finish(request, requestDigest, response) {
    writeAtomic(this.#attemptFile(request.attemptId), {
      schemaVersion: 1,
      attemptId: request.attemptId,
      accountId: request.accountId,
      idempotencyKey: request.idempotencyKey,
      requestDigest,
      bootId: this.bootId,
      state: 'final',
      response,
      updatedAt: new Date().toISOString(),
    })
  }

  resolveUnknownAttempt(attemptId, resolution) {
    if (typeof attemptId !== 'string' || attemptId.length < 1 || attemptId.length > 256) throw new Error('Attempt id is invalid')
    const filename = this.#attemptFile(attemptId)
    const record = readJson(filename)
    if (!record || record.schemaVersion !== 1 || record.attemptId !== attemptId
      || record.state !== 'final' || record.response?.outcome !== 'UNKNOWN_AFTER_ATTEMPT') {
      throw new Error('Attempt is not a resolvable unknown outcome')
    }
    const resolvedAt = resolution?.resolvedAt || new Date().toISOString()
    const resolutionType = resolution?.resolutionType
    const evidenceReference = resolution?.evidenceReference
    if (!['provider_absence_proven', 'operator_dead_letter'].includes(resolutionType)
      || typeof resolvedAt !== 'string' || Number.isNaN(Date.parse(resolvedAt))
      || typeof evidenceReference !== 'string' || evidenceReference.length < 1 || evidenceReference.length > 512
      || /[\x00-\x1f\x7f]/.test(evidenceReference)) {
      throw new Error('Unknown outcome resolution is invalid')
    }
    const updated = {
      ...record,
      resolution: { schemaVersion: 1, resolutionType, resolvedAt, evidenceReference },
      updatedAt: new Date().toISOString(),
    }
    writeAtomic(filename, updated)
    return updated
  }

  countPhysicalSince(timestamp) {
    return this.summarizeSince(timestamp).physicalCalls
  }

  summarizeSince(timestamp) {
    const summary = { physicalCalls: 0, unknownOutcomes: 0, routeConflicts: 0, wrongAccounts: 0, staleFences: 0 }
    for (const name of fs.readdirSync(this.directory)) {
      if (!name.endsWith('.json')) continue
      const record = readJson(path.join(this.directory, name))
      const started = record?.physicalActionStartedAt || (record?.response?.physicalProviderCalled === true ? record.updatedAt : null)
      if (started && Date.parse(started) >= timestamp) summary.physicalCalls += 1
      if (!record?.updatedAt || Date.parse(record.updatedAt) < timestamp) continue
      if (record.response?.outcome === 'UNKNOWN_AFTER_ATTEMPT' && !resolvedUnknown(record)) summary.unknownOutcomes += 1
      if (['ROUTE_CONFLICT', 'ROUTE_MISMATCH'].includes(record.response?.safeCode)) summary.routeConflicts += 1
      if (['WRONG_ACCOUNT', 'ACCOUNT_NOT_ALLOWLISTED'].includes(record.response?.safeCode)) summary.wrongAccounts += 1
      if (['STALE_FENCE', 'LEASE_EXPIRED'].includes(record.response?.safeCode)) summary.staleFences += 1
    }
    return summary
  }
}

module.exports = { DurableSenderAttemptStore, DurableSenderReplayStore }
