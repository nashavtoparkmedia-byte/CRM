import { SessionOwnerError } from './errors.ts'
import type {
  AcquireSessionOwnerInput,
  MutateSessionOwnerInput,
  SessionOwnerAcquireResult,
  SessionOwnerAuthorityProof,
  SessionOwnerLease,
  SessionOwnerReleaseResult,
  SessionOwnerRepository,
  SessionOwnerState,
  VerifySessionOwnerInput,
} from './types.ts'

interface SessionOwnerRow {
  accountId: string
  ownerInstanceId: string
  fencingToken: bigint
  acquiredAt: Date
  heartbeatAt: Date
  leaseUntil: Date
  lastReleasedAt: Date | null
  state: string
  version: number
  databaseNow: Date
}

export interface SessionOwnerPrismaTransaction {
  $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>
}

export interface SessionOwnerPrismaClient extends SessionOwnerPrismaTransaction {
  $transaction<T>(operation: (transaction: SessionOwnerPrismaTransaction) => Promise<T>): Promise<T>
}

function dateCopy(value: unknown, field: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.valueOf())) {
    throw new SessionOwnerError('DATABASE_FAILURE', `Stored ${field} is invalid`)
  }
  return new Date(value.valueOf())
}

function asLease(row: SessionOwnerRow): SessionOwnerLease {
  if ((row.state !== 'active' && row.state !== 'released') || typeof row.fencingToken !== 'bigint' || row.fencingToken < 1n
    || !Number.isSafeInteger(row.version) || row.version < 1) {
    throw new SessionOwnerError('DATABASE_FAILURE', 'Stored session owner state is invalid')
  }
  return Object.freeze({
    accountId: row.accountId,
    ownerInstanceId: row.ownerInstanceId,
    fencingToken: row.fencingToken,
    acquiredAt: dateCopy(row.acquiredAt, 'acquiredAt'),
    heartbeatAt: dateCopy(row.heartbeatAt, 'heartbeatAt'),
    leaseUntil: dateCopy(row.leaseUntil, 'leaseUntil'),
    lastReleasedAt: row.lastReleasedAt === null ? null : dateCopy(row.lastReleasedAt, 'lastReleasedAt'),
    state: row.state as SessionOwnerState,
    version: row.version,
    observedDatabaseTime: dateCopy(row.databaseNow, 'databaseNow'),
  })
}

function postgresCode(error: unknown): string | undefined {
  if (error === null || typeof error !== 'object') return undefined
  const direct = Reflect.get(error, 'code')
  if (typeof direct === 'string' && direct !== 'P2010') return direct
  const meta = Reflect.get(error, 'meta')
  if (meta !== null && typeof meta === 'object') {
    const code = Reflect.get(meta, 'code')
    if (typeof code === 'string') return code
  }
  return undefined
}

function persistenceError(error: unknown): SessionOwnerError {
  if (error instanceof SessionOwnerError) return error
  const code = postgresCode(error)
  if (code === '55P03' || code === '57014') return new SessionOwnerError('LOCK_TIMEOUT', 'Session owner row lock timed out')
  if (code === '08000' || code === '08003' || code === '08006' || code === '57P01') {
    return new SessionOwnerError('DATABASE_UNAVAILABLE', 'Session owner database is unavailable')
  }
  return new SessionOwnerError('DATABASE_FAILURE', 'Session owner persistence failed')
}

async function setBoundedLockTimeout(transaction: SessionOwnerPrismaTransaction): Promise<void> {
  await transaction.$queryRaw`SELECT set_config('lock_timeout', '5s', true)`
}

export class PrismaSessionOwnerRepository implements SessionOwnerRepository {
  readonly #client: SessionOwnerPrismaClient

  constructor(client: SessionOwnerPrismaClient) {
    this.#client = client
  }

  async acquireAtomic(input: Required<AcquireSessionOwnerInput>): Promise<SessionOwnerAcquireResult> {
    try {
      return await this.#client.$transaction(async transaction => {
        await setBoundedLockTimeout(transaction)
        const duration = BigInt(input.leaseMilliseconds)
        const inserted = await transaction.$queryRaw<SessionOwnerRow[]>`
          INSERT INTO "MaxAccountSessionOwner" (
            "accountId", "ownerInstanceId", "fencingToken", "acquiredAt", "heartbeatAt", "leaseUntil",
            "lastReleasedAt", "state", "version", "createdAt", "updatedAt"
          )
          VALUES (
            ${input.accountId}, ${input.ownerInstanceId}, 1, now(), now(), now() + (${duration}::bigint * interval '1 millisecond'),
            NULL, 'active', 1, now(), now()
          )
          ON CONFLICT ("accountId") DO NOTHING
          RETURNING "accountId", "ownerInstanceId", "fencingToken", "acquiredAt", "heartbeatAt", "leaseUntil",
            "lastReleasedAt", "state", "version", now() AS "databaseNow"
        `
        if (inserted.length === 1) return Object.freeze({ disposition: 'acquired' as const, lease: asLease(inserted[0]!) })

        const locked = await transaction.$queryRaw<SessionOwnerRow[]>`
          SELECT "accountId", "ownerInstanceId", "fencingToken", "acquiredAt", "heartbeatAt", "leaseUntil",
            "lastReleasedAt", "state", "version", now() AS "databaseNow"
          FROM "MaxAccountSessionOwner"
          WHERE "accountId" = ${input.accountId}
          FOR UPDATE
        `
        const current = locked[0]
        if (current === undefined) throw new SessionOwnerError('DATABASE_FAILURE', 'Session owner row disappeared during acquisition')

        if (current.state === 'active' && current.leaseUntil > current.databaseNow) {
          if (current.ownerInstanceId !== input.ownerInstanceId) {
            throw new SessionOwnerError('LEASE_HELD', 'Another owner holds the account session lease')
          }
          const renewed = await transaction.$queryRaw<SessionOwnerRow[]>`
            UPDATE "MaxAccountSessionOwner"
            SET "heartbeatAt" = now(), "leaseUntil" = now() + (${duration}::bigint * interval '1 millisecond'),
                "version" = "version" + 1, "updatedAt" = now()
            WHERE "accountId" = ${input.accountId} AND "ownerInstanceId" = ${input.ownerInstanceId}
              AND "fencingToken" = ${current.fencingToken} AND "state" = 'active' AND "leaseUntil" > now()
            RETURNING "accountId", "ownerInstanceId", "fencingToken", "acquiredAt", "heartbeatAt", "leaseUntil",
              "lastReleasedAt", "state", "version", now() AS "databaseNow"
          `
          if (renewed.length !== 1) throw new SessionOwnerError('STALE_FENCE', 'Session owner changed during duplicate acquisition')
          return Object.freeze({ disposition: 'renewed' as const, lease: asLease(renewed[0]!) })
        }

        const takenOver = await transaction.$queryRaw<SessionOwnerRow[]>`
          UPDATE "MaxAccountSessionOwner"
          SET "ownerInstanceId" = ${input.ownerInstanceId}, "fencingToken" = "fencingToken" + 1,
              "acquiredAt" = now(), "heartbeatAt" = now(), "leaseUntil" = now() + (${duration}::bigint * interval '1 millisecond'),
              "state" = 'active', "version" = "version" + 1, "updatedAt" = now()
          WHERE "accountId" = ${input.accountId} AND "fencingToken" = ${current.fencingToken}
            AND ("state" = 'released' OR "leaseUntil" <= now())
          RETURNING "accountId", "ownerInstanceId", "fencingToken", "acquiredAt", "heartbeatAt", "leaseUntil",
            "lastReleasedAt", "state", "version", now() AS "databaseNow"
        `
        if (takenOver.length !== 1) throw new SessionOwnerError('LEASE_HELD', 'Session owner takeover was not eligible')
        return Object.freeze({ disposition: 'taken_over' as const, lease: asLease(takenOver[0]!) })
      })
    } catch (error) {
      throw persistenceError(error)
    }
  }

  async renewCurrent(input: Required<MutateSessionOwnerInput>): Promise<SessionOwnerLease> {
    try {
      const duration = BigInt(input.leaseMilliseconds)
      const rows = await this.#client.$queryRaw<SessionOwnerRow[]>`
        WITH database_clock AS (SELECT now() AS value)
        UPDATE "MaxAccountSessionOwner" AS owner
        SET "heartbeatAt" = database_clock.value,
            "leaseUntil" = database_clock.value + (${duration}::bigint * interval '1 millisecond'),
            "version" = owner."version" + 1, "updatedAt" = database_clock.value
        FROM database_clock
        WHERE owner."accountId" = ${input.accountId} AND owner."ownerInstanceId" = ${input.ownerInstanceId}
          AND owner."fencingToken" = ${input.fencingToken} AND owner."state" = 'active'
          AND owner."leaseUntil" > database_clock.value
        RETURNING owner."accountId", owner."ownerInstanceId", owner."fencingToken", owner."acquiredAt", owner."heartbeatAt", owner."leaseUntil",
          owner."lastReleasedAt", owner."state", owner."version", database_clock.value AS "databaseNow"
      `
      if (rows.length !== 1) throw new SessionOwnerError('STALE_FENCE', 'Only the unexpired current owner may renew')
      return asLease(rows[0]!)
    } catch (error) {
      throw persistenceError(error)
    }
  }

  async releaseCurrent(input: MutateSessionOwnerInput): Promise<SessionOwnerReleaseResult> {
    try {
      const rows = await this.#client.$queryRaw<SessionOwnerRow[]>`
        WITH database_clock AS (SELECT now() AS value)
        UPDATE "MaxAccountSessionOwner" AS owner
        SET "state" = 'released', "leaseUntil" = database_clock.value, "lastReleasedAt" = database_clock.value,
            "version" = owner."version" + 1, "updatedAt" = database_clock.value
        FROM database_clock
        WHERE owner."accountId" = ${input.accountId} AND owner."ownerInstanceId" = ${input.ownerInstanceId}
          AND owner."fencingToken" = ${input.fencingToken} AND owner."state" = 'active'
        RETURNING owner."accountId", owner."ownerInstanceId", owner."fencingToken", owner."acquiredAt", owner."heartbeatAt", owner."leaseUntil",
          owner."lastReleasedAt", owner."state", owner."version", database_clock.value AS "databaseNow"
      `
      if (rows.length === 0) return Object.freeze({ status: 'stale' as const, lease: null })
      return Object.freeze({ status: 'released' as const, lease: asLease(rows[0]!) })
    } catch (error) {
      throw persistenceError(error)
    }
  }

  async verifyCurrent(input: VerifySessionOwnerInput): Promise<SessionOwnerAuthorityProof> {
    try {
      const rows = await this.#client.$queryRaw<SessionOwnerRow[]>`
        SELECT "accountId", "ownerInstanceId", "fencingToken", "acquiredAt", "heartbeatAt", "leaseUntil",
          "lastReleasedAt", "state", "version", now() AS "databaseNow"
        FROM "MaxAccountSessionOwner"
        WHERE "accountId" = ${input.accountId} AND "ownerInstanceId" = ${input.ownerInstanceId}
          AND "fencingToken" = ${input.fencingToken} AND "state" = 'active' AND "leaseUntil" > now()
      `
      const row = rows[0]
      if (row === undefined) throw new SessionOwnerError('STALE_FENCE', 'Sender boundary rejected stale or account-mismatched authority')
      return Object.freeze({
        accountId: row.accountId,
        ownerInstanceId: row.ownerInstanceId,
        fencingToken: row.fencingToken,
        leaseUntil: dateCopy(row.leaseUntil, 'leaseUntil'),
        verifiedAtDatabaseTime: dateCopy(row.databaseNow, 'databaseNow'),
        senderBoundaryVerified: true as const,
      })
    } catch (error) {
      throw persistenceError(error)
    }
  }

  async get(accountId: string): Promise<SessionOwnerLease | null> {
    try {
      const rows = await this.#client.$queryRaw<SessionOwnerRow[]>`
        SELECT "accountId", "ownerInstanceId", "fencingToken", "acquiredAt", "heartbeatAt", "leaseUntil",
          "lastReleasedAt", "state", "version", now() AS "databaseNow"
        FROM "MaxAccountSessionOwner"
        WHERE "accountId" = ${accountId}
      `
      return rows[0] === undefined ? null : asLease(rows[0])
    } catch (error) {
      throw persistenceError(error)
    }
  }
}
