import {
  DEFAULT_SESSION_OWNER_LEASE_MILLISECONDS,
  MAX_SESSION_OWNER_LEASE_MILLISECONDS,
  MIN_SESSION_OWNER_LEASE_MILLISECONDS,
} from './constants.ts'
import { asSessionOwnerDatabaseError, SessionOwnerError } from './errors.ts'
import type {
  AccountSessionOwner,
  AcquireSessionOwnerInput,
  MutateSessionOwnerInput,
  SessionOwnerAcquireResult,
  SessionOwnerAuthorityProof,
  SessionOwnerLease,
  SessionOwnerReleaseResult,
  SessionOwnerRepository,
  VerifySessionOwnerInput,
} from './types.ts'

const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const OWNER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/

function validateAccountId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !ACCOUNT_ID_PATTERN.test(value) || value === '*') {
    throw new SessionOwnerError('INVALID_INPUT', 'accountId is not an exact bounded identifier')
  }
}

function validateOwnerInstanceId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !OWNER_ID_PATTERN.test(value) || value === '*') {
    throw new SessionOwnerError('INVALID_INPUT', 'ownerInstanceId is not an exact bounded identifier')
  }
}

function validateToken(value: unknown): asserts value is bigint {
  if (typeof value !== 'bigint' || value < 1n) throw new SessionOwnerError('INVALID_INPUT', 'fencingToken must be a positive bigint')
}

function leaseDuration(value: number | undefined): number {
  const resolved = value ?? DEFAULT_SESSION_OWNER_LEASE_MILLISECONDS
  if (!Number.isSafeInteger(resolved) || resolved < MIN_SESSION_OWNER_LEASE_MILLISECONDS || resolved > MAX_SESSION_OWNER_LEASE_MILLISECONDS) {
    throw new SessionOwnerError('INVALID_INPUT', `leaseMilliseconds must be between ${MIN_SESSION_OWNER_LEASE_MILLISECONDS} and ${MAX_SESSION_OWNER_LEASE_MILLISECONDS}`)
  }
  return resolved
}

export class DurableAccountSessionOwner implements AccountSessionOwner {
  readonly #repository: SessionOwnerRepository

  constructor(repository: SessionOwnerRepository) {
    this.#repository = repository
  }

  async acquire(input: AcquireSessionOwnerInput): Promise<SessionOwnerAcquireResult> {
    validateAccountId(input.accountId)
    validateOwnerInstanceId(input.ownerInstanceId)
    try {
      return await this.#repository.acquireAtomic({ ...input, leaseMilliseconds: leaseDuration(input.leaseMilliseconds) })
    } catch (error) {
      throw asSessionOwnerDatabaseError(error)
    }
  }

  async renew(input: MutateSessionOwnerInput): Promise<SessionOwnerLease> {
    validateAccountId(input.accountId)
    validateOwnerInstanceId(input.ownerInstanceId)
    validateToken(input.fencingToken)
    try {
      return await this.#repository.renewCurrent({ ...input, leaseMilliseconds: leaseDuration(input.leaseMilliseconds) })
    } catch (error) {
      throw asSessionOwnerDatabaseError(error)
    }
  }

  async release(input: MutateSessionOwnerInput): Promise<SessionOwnerReleaseResult> {
    validateAccountId(input.accountId)
    validateOwnerInstanceId(input.ownerInstanceId)
    validateToken(input.fencingToken)
    if (input.leaseMilliseconds !== undefined) leaseDuration(input.leaseMilliseconds)
    try {
      return await this.#repository.releaseCurrent(input)
    } catch (error) {
      throw asSessionOwnerDatabaseError(error)
    }
  }

  async verifyImmediatelyBeforeSender(input: VerifySessionOwnerInput): Promise<SessionOwnerAuthorityProof> {
    validateAccountId(input.accountId)
    validateOwnerInstanceId(input.ownerInstanceId)
    validateToken(input.fencingToken)
    try {
      return await this.#repository.verifyCurrent(input)
    } catch (error) {
      throw asSessionOwnerDatabaseError(error)
    }
  }

  async get(accountId: string): Promise<SessionOwnerLease | null> {
    validateAccountId(accountId)
    try {
      return await this.#repository.get(accountId)
    } catch (error) {
      throw asSessionOwnerDatabaseError(error)
    }
  }
}
