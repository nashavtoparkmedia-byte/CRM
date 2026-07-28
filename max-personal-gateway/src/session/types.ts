export type SessionOwnerState = 'active' | 'released'
export type SessionOwnerAcquireDisposition = 'acquired' | 'renewed' | 'taken_over'

export interface SessionOwnerLease {
  readonly accountId: string
  readonly ownerInstanceId: string
  readonly fencingToken: bigint
  readonly acquiredAt: Date
  readonly heartbeatAt: Date
  readonly leaseUntil: Date
  readonly lastReleasedAt: Date | null
  readonly state: SessionOwnerState
  readonly version: number
  readonly observedDatabaseTime: Date
}

export interface AcquireSessionOwnerInput {
  readonly accountId: string
  readonly ownerInstanceId: string
  readonly leaseMilliseconds?: number
}

export interface MutateSessionOwnerInput extends AcquireSessionOwnerInput {
  readonly fencingToken: bigint
}

export interface VerifySessionOwnerInput {
  readonly accountId: string
  readonly ownerInstanceId: string
  readonly fencingToken: bigint
}

export interface SessionOwnerAcquireResult {
  readonly disposition: SessionOwnerAcquireDisposition
  readonly lease: SessionOwnerLease
}

export interface SessionOwnerReleaseResult {
  readonly status: 'released' | 'stale'
  readonly lease: SessionOwnerLease | null
}

export interface SessionOwnerAuthorityProof {
  readonly accountId: string
  readonly ownerInstanceId: string
  readonly fencingToken: bigint
  readonly leaseUntil: Date
  readonly verifiedAtDatabaseTime: Date
  readonly senderBoundaryVerified: true
}

export interface SessionOwnerRepository {
  acquireAtomic(input: Required<AcquireSessionOwnerInput>): Promise<SessionOwnerAcquireResult>
  renewCurrent(input: Required<MutateSessionOwnerInput>): Promise<SessionOwnerLease>
  releaseCurrent(input: MutateSessionOwnerInput): Promise<SessionOwnerReleaseResult>
  verifyCurrent(input: VerifySessionOwnerInput): Promise<SessionOwnerAuthorityProof>
  get(accountId: string): Promise<SessionOwnerLease | null>
}

export interface AccountSessionOwner {
  acquire(input: AcquireSessionOwnerInput): Promise<SessionOwnerAcquireResult>
  renew(input: MutateSessionOwnerInput): Promise<SessionOwnerLease>
  release(input: MutateSessionOwnerInput): Promise<SessionOwnerReleaseResult>
  verifyImmediatelyBeforeSender(input: VerifySessionOwnerInput): Promise<SessionOwnerAuthorityProof>
  get(accountId: string): Promise<SessionOwnerLease | null>
}
