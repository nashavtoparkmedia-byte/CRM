export type SessionOwnerErrorCode =
  | 'INVALID_INPUT'
  | 'LEASE_HELD'
  | 'STALE_FENCE'
  | 'LEASE_EXPIRED'
  | 'DATABASE_UNAVAILABLE'
  | 'LOCK_TIMEOUT'
  | 'DATABASE_FAILURE'

export class SessionOwnerError extends Error {
  readonly code: SessionOwnerErrorCode

  constructor(code: SessionOwnerErrorCode, safeMessage: string) {
    super(safeMessage)
    this.name = 'SessionOwnerError'
    this.code = code
  }
}

export function asSessionOwnerDatabaseError(error: unknown): SessionOwnerError {
  if (error instanceof SessionOwnerError) return error
  void error
  return new SessionOwnerError('DATABASE_FAILURE', 'Session owner persistence failed')
}
