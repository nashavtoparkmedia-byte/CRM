import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { basename, join } from 'node:path'
import { CaptureError } from './errors.ts'
import type {
  CaptureEnvelope,
  CaptureHealthSnapshot,
  DurableCaptureSpool,
  SpoolRecord,
} from './types.ts'

const DEFAULT_MAX_RECORD_BYTES = 1024 * 1024
const DEFAULT_MAX_TOTAL_BYTES = 256 * 1024 * 1024
const DEFAULT_SEGMENT_BYTES = 4 * 1024 * 1024
const SEGMENT = /^segment-(\d{20})(?:-[a-z0-9-]+)?\.jsonl$/

export interface SegmentedFileCaptureSpoolOptions {
  readonly directory: string
  readonly maxRecordBytes?: number
  readonly maxTotalBytes?: number
  readonly maxSegmentBytes?: number
  readonly warningRatio?: number
  readonly criticalRatio?: number
  readonly clock?: () => Date
}

interface PersistedRecord {
  readonly spoolVersion: 1
  readonly sequence: number
  readonly envelope: CaptureEnvelope
  readonly checksum: string
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function body(sequence: number, envelope: CaptureEnvelope): string {
  return JSON.stringify({ spoolVersion: 1, sequence, envelope })
}

function serialize(sequence: number, envelope: CaptureEnvelope): string {
  const value = body(sequence, envelope)
  return `${JSON.stringify({ ...JSON.parse(value), checksum: hash(value) })}\n`
}

function parseLine(line: string): PersistedRecord {
  const parsed = JSON.parse(line) as PersistedRecord
  if (parsed.spoolVersion !== 1 || !Number.isSafeInteger(parsed.sequence) || parsed.sequence < 1
    || typeof parsed.checksum !== 'string' || parsed.envelope === undefined
    || parsed.checksum !== hash(body(parsed.sequence, parsed.envelope))) {
    throw new CaptureError('SPOOL_CORRUPT', 'Capture spool checksum or record shape is invalid')
  }
  return parsed
}

function safeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new CaptureError('INVALID_CAPTURE_CONFIG', `${field} must be a positive integer`)
  }
}

export class SegmentedFileCaptureSpool implements DurableCaptureSpool {
  readonly #directory: string
  readonly #quarantineDirectory: string
  readonly #maxRecordBytes: number
  readonly #maxTotalBytes: number
  readonly #maxSegmentBytes: number
  readonly #warningRatio: number
  readonly #criticalRatio: number
  readonly #clock: () => Date
  readonly #records = new Map<number, SpoolRecord>()
  #nextSequence = 1
  #acknowledgedWatermark = 0
  #acknowledgedCount = 0
  #retryCount = 0
  #rejectedCount = 0
  #quarantinedCount = 0
  #lostBeforeSpoolCount = 0
  #lastSuccessfulJournalAck: string | null = null
  #lastDrainErrorCode: string | null = null
  #critical = false

  constructor(options: SegmentedFileCaptureSpoolOptions) {
    if (!options.directory.startsWith('/')) {
      throw new CaptureError('INVALID_CAPTURE_CONFIG', 'Capture spool directory must be absolute')
    }
    this.#directory = options.directory
    this.#quarantineDirectory = join(options.directory, 'quarantine')
    this.#maxRecordBytes = options.maxRecordBytes ?? DEFAULT_MAX_RECORD_BYTES
    this.#maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES
    this.#maxSegmentBytes = options.maxSegmentBytes ?? DEFAULT_SEGMENT_BYTES
    this.#warningRatio = options.warningRatio ?? 0.7
    this.#criticalRatio = options.criticalRatio ?? 0.9
    this.#clock = options.clock ?? (() => new Date())
    for (const [value, field] of [
      [this.#maxRecordBytes, 'maxRecordBytes'],
      [this.#maxTotalBytes, 'maxTotalBytes'],
      [this.#maxSegmentBytes, 'maxSegmentBytes'],
    ] as const) safeInteger(value, field)
    if (!(this.#warningRatio > 0 && this.#warningRatio < this.#criticalRatio && this.#criticalRatio <= 1)) {
      throw new CaptureError('INVALID_CAPTURE_CONFIG', 'Capture spool thresholds are invalid')
    }
    mkdirSync(this.#directory, { recursive: true, mode: 0o700 })
    chmodSync(this.#directory, 0o700)
    mkdirSync(this.#quarantineDirectory, { recursive: true, mode: 0o700 })
    chmodSync(this.#quarantineDirectory, 0o700)
    this.recoverSpool()
  }

  appendToSpool(envelope: CaptureEnvelope): SpoolRecord {
    const sequence = this.#nextSequence
    const line = serialize(sequence, envelope)
    const bytes = Buffer.byteLength(line)
    if (bytes > this.#maxRecordBytes) {
      this.#lostBeforeSpoolCount += 1
      this.#critical = true
      this.#lastDrainErrorCode = 'SPOOL_RECORD_TOO_LARGE'
      throw new CaptureError('SPOOL_RECORD_TOO_LARGE', 'Capture spool record exceeds configured bound')
    }
    if (this.#diskBytes() + bytes > this.#maxTotalBytes) {
      this.#lostBeforeSpoolCount += 1
      this.#critical = true
      this.#lastDrainErrorCode = 'SPOOL_FULL'
      throw new CaptureError('SPOOL_FULL', 'Capture spool reached configured disk bound')
    }
    const segment = this.#activeSegment(sequence, bytes)
    let descriptor: number | null = null
    try {
      descriptor = openSync(segment, 'a', 0o600)
      writeSync(descriptor, line, null, 'utf8')
      fsyncSync(descriptor)
      chmodSync(segment, 0o600)
      this.#syncDirectory(this.#directory)
    } catch (error) {
      this.#lostBeforeSpoolCount += 1
      this.#critical = true
      this.#lastDrainErrorCode = 'SPOOL_IO_FAILURE'
      throw new CaptureError('SPOOL_IO_FAILURE', 'Capture spool durable append failed', { cause: error })
    } finally {
      if (descriptor !== null) closeSync(descriptor)
    }
    this.#nextSequence += 1
    const record = { spoolVersion: 1 as const, sequence, envelope, checksum: hash(body(sequence, envelope)), bytes }
    this.#records.set(sequence, record)
    return record
  }

  readPending(limit: number): readonly SpoolRecord[] {
    safeInteger(limit, 'limit')
    return [...this.#records.values()]
      .filter(record => record.sequence > this.#acknowledgedWatermark)
      .sort((left, right) => left.sequence - right.sequence)
      .slice(0, limit)
  }

  markAcknowledged(sequence: number): void {
    if (!Number.isSafeInteger(sequence) || sequence !== this.#acknowledgedWatermark + 1 || !this.#records.has(sequence)) {
      throw new CaptureError('SPOOL_CORRUPT', 'Capture ACK must advance the contiguous watermark')
    }
    this.#acknowledgedWatermark = sequence
    this.#acknowledgedCount += 1
    this.#lastSuccessfulJournalAck = this.#clock().toISOString()
    this.#writeWatermark()
    if (this.readPending(1).length === 0) {
      this.#retryCount = 0
      this.#lastDrainErrorCode = null
      if (this.#diskBytes() < this.#maxTotalBytes * this.#criticalRatio) this.#critical = false
    }
  }

  quarantineRecord(sequence: number, reasonCode: string): void {
    const record = this.#records.get(sequence)
    if (record === undefined) return
    const evidence = JSON.stringify({ sequence, reasonCode, checksum: record.checksum })
    const target = join(this.#quarantineDirectory, `record-${String(sequence).padStart(20, '0')}.json`)
    writeFileSync(target, evidence, { mode: 0o600, flag: 'wx' })
    this.#quarantinedCount += 1
    if (sequence === this.#acknowledgedWatermark + 1) this.markAcknowledged(sequence)
  }

  recoverSpool(): CaptureHealthSnapshot {
    this.#records.clear()
    this.#acknowledgedWatermark = this.#readWatermark()
    let maxSequence = 0
    for (const name of this.#segmentNames()) {
      const file = join(this.#directory, name)
      const raw = readFileSync(file, 'utf8')
      const lines = raw.split('\n')
      const valid: string[] = []
      let corrupt = false
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index]
        if (line === '') continue
        try {
          const parsed = parseLine(line)
          if (this.#records.has(parsed.sequence)) throw new Error('duplicate sequence')
          const bytes = Buffer.byteLength(`${line}\n`)
          this.#records.set(parsed.sequence, { ...parsed, bytes })
          valid.push(`${line}\n`)
          maxSequence = Math.max(maxSequence, parsed.sequence)
        } catch {
          corrupt = true
        }
      }
      if (corrupt || (raw.length > 0 && !raw.endsWith('\n'))) {
        this.#quarantinedCount += 1
        this.#critical = true
        this.#lastDrainErrorCode = 'SPOOL_CORRUPT'
        const quarantined = join(this.#quarantineDirectory, `${basename(name, '.jsonl')}-${randomUUID()}.jsonl`)
        renameSync(file, quarantined)
        this.#syncDirectory(this.#directory)
        this.#syncDirectory(this.#quarantineDirectory)
        if (valid.length > 0) {
          const first = parseLine(valid[0]!.trim()).sequence
          const recovered = join(
            this.#directory,
            `segment-${String(first).padStart(20, '0')}-recovered-${randomUUID()}.jsonl`,
          )
          writeFileSync(recovered, valid.join(''), { mode: 0o600, flag: 'wx' })
          const descriptor = openSync(recovered, 'r')
          try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
          this.#syncDirectory(this.#directory)
        }
      }
    }
    this.#nextSequence = Math.max(maxSequence, this.#acknowledgedWatermark) + 1
    return this.getCaptureHealth()
  }

  compactAcknowledged(): number {
    let removed = 0
    for (const name of this.#segmentNames()) {
      const file = join(this.#directory, name)
      const sequences = readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap(line => {
        try { return [parseLine(line).sequence] } catch { return [] }
      })
      if (sequences.length > 0 && sequences.every(sequence => sequence <= this.#acknowledgedWatermark)) {
        unlinkSync(file)
        for (const sequence of sequences) this.#records.delete(sequence)
        removed += sequences.length
      }
    }
    return removed
  }

  noteRetry(errorCode: string): void {
    this.#retryCount += 1
    this.#lastDrainErrorCode = errorCode
  }

  getCaptureHealth(): CaptureHealthSnapshot {
    const pending = this.readPending(Number.MAX_SAFE_INTEGER)
    const pendingBytes = pending.reduce((sum, record) => sum + record.bytes, 0)
    const diskRatio = this.#diskBytes() / this.#maxTotalBytes
    const state = this.#critical || diskRatio >= this.#criticalRatio
      ? 'critical'
      : this.#retryCount > 0 || diskRatio >= this.#warningRatio ? 'degraded' : 'healthy'
    return {
      enabled: true,
      adapterState: state,
      spoolPendingCount: pending.length,
      spoolPendingBytes: pendingBytes,
      oldestPendingAgeMs: pending[0] === undefined
        ? null
        : Math.max(0, this.#clock().valueOf() - new Date(pending[0].envelope.capturedAt).valueOf()),
      acknowledgedCount: this.#acknowledgedCount,
      retryCount: this.#retryCount,
      rejectedCount: this.#rejectedCount,
      quarantinedCount: this.#quarantinedCount,
      lostBeforeSpoolCount: this.#lostBeforeSpoolCount,
      lastSuccessfulJournalAck: this.#lastSuccessfulJournalAck,
      lastDrainErrorCode: this.#lastDrainErrorCode,
      captureEnvelopeIdCollisionCount: 0,
      ingressIdempotentRetryCount: 0,
    }
  }

  close(): void {
    // Every append is fsync'd before return; there is no buffered record to flush.
  }

  #segmentNames(): string[] {
    return readdirSync(this.#directory).filter(name => SEGMENT.test(name)).sort()
  }

  #activeSegment(sequence: number, incomingBytes: number): string {
    const names = this.#segmentNames()
    const current = names.at(-1)
    if (current !== undefined) {
      const file = join(this.#directory, current)
      if (statSync(file).size + incomingBytes <= this.#maxSegmentBytes) return file
    }
    return join(this.#directory, `segment-${String(sequence).padStart(20, '0')}.jsonl`)
  }

  #diskBytes(): number {
    const count = (directory: string): number => {
      let bytes = 0
      for (const name of readdirSync(directory)) {
        const file = join(directory, name)
        try {
          const stat = statSync(file)
          bytes += stat.isDirectory() ? count(file) : stat.size
        } catch {}
      }
      return bytes
    }
    return count(this.#directory)
  }

  #watermarkPath(): string {
    return join(this.#directory, 'ack.watermark')
  }

  #readWatermark(): number {
    if (!existsSync(this.#watermarkPath())) return 0
    try {
      const parsed = JSON.parse(readFileSync(this.#watermarkPath(), 'utf8')) as { sequence: number; checksum: string }
      if (!Number.isSafeInteger(parsed.sequence) || parsed.sequence < 0 || parsed.checksum !== hash(String(parsed.sequence))) {
        throw new Error('invalid watermark')
      }
      return parsed.sequence
    } catch (error) {
      this.#critical = true
      this.#lastDrainErrorCode = 'SPOOL_CORRUPT'
      throw new CaptureError('SPOOL_CORRUPT', 'Capture spool ACK watermark is invalid', { cause: error })
    }
  }

  #writeWatermark(): void {
    const target = this.#watermarkPath()
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`
    const value = JSON.stringify({
      sequence: this.#acknowledgedWatermark,
      checksum: hash(String(this.#acknowledgedWatermark)),
    })
    writeFileSync(temporary, value, { mode: 0o600, flag: 'wx' })
    const descriptor = openSync(temporary, 'r')
    try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
    renameSync(temporary, target)
    chmodSync(target, 0o600)
    this.#syncDirectory(this.#directory)
  }

  #syncDirectory(directory: string): void {
    const descriptor = openSync(directory, 'r')
    try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
  }
}
