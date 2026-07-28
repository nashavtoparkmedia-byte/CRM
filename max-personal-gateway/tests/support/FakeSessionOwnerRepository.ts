import { SessionOwnerError } from '../../src/session/errors.ts'
import type {
  AcquireSessionOwnerInput,
  MutateSessionOwnerInput,
  SessionOwnerAcquireResult,
  SessionOwnerAuthorityProof,
  SessionOwnerLease,
  SessionOwnerReleaseResult,
  SessionOwnerRepository,
  VerifySessionOwnerInput,
} from '../../src/session/types.ts'

interface MutableLease {
  accountId: string
  ownerInstanceId: string
  fencingToken: bigint
  acquiredAt: Date
  heartbeatAt: Date
  leaseUntil: Date
  lastReleasedAt: Date | null
  state: 'active' | 'released'
  version: number
}

function cloneRow(row: MutableLease): MutableLease {
  return {
    ...row,
    acquiredAt: new Date(row.acquiredAt),
    heartbeatAt: new Date(row.heartbeatAt),
    leaseUntil: new Date(row.leaseUntil),
    lastReleasedAt: row.lastReleasedAt === null ? null : new Date(row.lastReleasedAt),
  }
}

export class FakeSessionOwnerRepository implements SessionOwnerRepository {
  readonly #rows = new Map<string, MutableLease>()
  #databaseNow: Date
  #tail: Promise<void> = Promise.resolve()
  #connected = true
  #rollbackNext = false
  #lockTimeoutNext = false

  constructor(databaseNow = new Date('2026-07-28T21:30:00.000Z')) {
    this.#databaseNow = new Date(databaseNow)
  }

  setDatabaseTime(value: Date): void { this.#databaseNow = new Date(value) }
  advanceDatabaseTime(milliseconds: number): void { this.#databaseNow = new Date(this.#databaseNow.valueOf() + milliseconds) }
  disconnect(): void { this.#connected = false }
  reconnect(): void { this.#connected = true }
  rollbackNextTransaction(): void { this.#rollbackNext = true }
  timeoutNextLock(): void { this.#lockTimeoutNext = true }

  row(accountId: string): SessionOwnerLease | null {
    const row = this.#rows.get(accountId)
    return row === undefined ? null : this.#lease(row)
  }

  async #atomic<T>(operation: () => T): Promise<T> {
    const previous = this.#tail
    let release!: () => void
    this.#tail = new Promise(resolve => { release = resolve })
    await previous
    const snapshot = new Map([...this.#rows].map(([key, value]) => [key, cloneRow(value)]))
    try {
      if (!this.#connected) throw new SessionOwnerError('DATABASE_UNAVAILABLE', 'Synthetic database is disconnected')
      if (this.#lockTimeoutNext) {
        this.#lockTimeoutNext = false
        throw new SessionOwnerError('LOCK_TIMEOUT', 'Synthetic row lock timed out')
      }
      const result = operation()
      if (this.#rollbackNext) {
        this.#rollbackNext = false
        throw new SessionOwnerError('DATABASE_FAILURE', 'Synthetic transaction rolled back')
      }
      return result
    } catch (error) {
      this.#rows.clear()
      for (const [key, value] of snapshot) this.#rows.set(key, value)
      throw error
    } finally {
      release()
    }
  }

  #lease(row: MutableLease): SessionOwnerLease {
    return Object.freeze({
      ...cloneRow(row),
      observedDatabaseTime: new Date(this.#databaseNow),
    })
  }

  async acquireAtomic(input: Required<AcquireSessionOwnerInput>): Promise<SessionOwnerAcquireResult> {
    return this.#atomic(() => {
      const now = new Date(this.#databaseNow)
      const current = this.#rows.get(input.accountId)
      if (current === undefined) {
        const created: MutableLease = {
          accountId: input.accountId, ownerInstanceId: input.ownerInstanceId, fencingToken: 1n,
          acquiredAt: now, heartbeatAt: now, leaseUntil: new Date(now.valueOf() + input.leaseMilliseconds),
          lastReleasedAt: null, state: 'active', version: 1,
        }
        this.#rows.set(input.accountId, created)
        return Object.freeze({ disposition: 'acquired' as const, lease: this.#lease(created) })
      }
      if (current.state === 'active' && current.leaseUntil > now) {
        if (current.ownerInstanceId !== input.ownerInstanceId) {
          throw new SessionOwnerError('LEASE_HELD', 'Synthetic session lease is held')
        }
        current.heartbeatAt = now
        current.leaseUntil = new Date(now.valueOf() + input.leaseMilliseconds)
        current.version += 1
        return Object.freeze({ disposition: 'renewed' as const, lease: this.#lease(current) })
      }
      current.ownerInstanceId = input.ownerInstanceId
      current.fencingToken += 1n
      current.acquiredAt = now
      current.heartbeatAt = now
      current.leaseUntil = new Date(now.valueOf() + input.leaseMilliseconds)
      current.state = 'active'
      current.version += 1
      return Object.freeze({ disposition: 'taken_over' as const, lease: this.#lease(current) })
    })
  }

  async renewCurrent(input: Required<MutateSessionOwnerInput>): Promise<SessionOwnerLease> {
    return this.#atomic(() => {
      const now = new Date(this.#databaseNow)
      const current = this.#rows.get(input.accountId)
      if (current === undefined || current.ownerInstanceId !== input.ownerInstanceId || current.fencingToken !== input.fencingToken
        || current.state !== 'active' || current.leaseUntil <= now) {
        throw new SessionOwnerError('STALE_FENCE', 'Synthetic renew rejected stale authority')
      }
      current.heartbeatAt = now
      current.leaseUntil = new Date(now.valueOf() + input.leaseMilliseconds)
      current.version += 1
      return this.#lease(current)
    })
  }

  async releaseCurrent(input: MutateSessionOwnerInput): Promise<SessionOwnerReleaseResult> {
    return this.#atomic(() => {
      const current = this.#rows.get(input.accountId)
      if (current === undefined || current.ownerInstanceId !== input.ownerInstanceId || current.fencingToken !== input.fencingToken || current.state !== 'active') {
        return Object.freeze({ status: 'stale' as const, lease: null })
      }
      const now = new Date(this.#databaseNow)
      current.state = 'released'
      current.leaseUntil = now
      current.lastReleasedAt = now
      current.version += 1
      return Object.freeze({ status: 'released' as const, lease: this.#lease(current) })
    })
  }

  async verifyCurrent(input: VerifySessionOwnerInput): Promise<SessionOwnerAuthorityProof> {
    return this.#atomic(() => {
      const current = this.#rows.get(input.accountId)
      const now = new Date(this.#databaseNow)
      if (current === undefined || current.ownerInstanceId !== input.ownerInstanceId || current.fencingToken !== input.fencingToken
        || current.state !== 'active' || current.leaseUntil <= now) {
        throw new SessionOwnerError('STALE_FENCE', 'Synthetic sender boundary rejected authority')
      }
      return Object.freeze({
        accountId: current.accountId, ownerInstanceId: current.ownerInstanceId, fencingToken: current.fencingToken,
        leaseUntil: new Date(current.leaseUntil), verifiedAtDatabaseTime: now, senderBoundaryVerified: true as const,
      })
    })
  }

  async get(accountId: string): Promise<SessionOwnerLease | null> {
    if (!this.#connected) throw new SessionOwnerError('DATABASE_UNAVAILABLE', 'Synthetic database is disconnected')
    return this.row(accountId)
  }
}
