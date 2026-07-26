export type DispatchLedgerErrorCode =
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  | 'ACCOUNT_MISMATCH'
  | 'ROUTE_NOT_SENDABLE'
  | 'SENDER_AUTHORITY_REQUIRED'
  | 'STALE_SENDER_AUTHORITY'
  | 'STALE_ACTOR_LEASE'
  | 'STALE_ACTOR_VERSION'
  | 'STALE_RESERVATION_VERSION'
  | 'RESERVATION_NOT_ACTIVE'
  | 'DISPATCH_CREATION_CONFLICT'
  | 'DISPATCH_LEDGER_REQUIRED'
  | 'STALE_DISPATCH_VERSION'
  | 'STALE_ATTEMPT_VERSION'
  | 'INVALID_TRANSITION'
  | 'TRANSITION_IDEMPOTENCY_CONFLICT'
  | 'ATTEMPT_CONFLICT'
  | 'FIFO_BLOCKED'
  | 'RECONCILIATION_REQUIRED'
  | 'UNSAFE_RETRY'
  | 'PROVIDER_MESSAGE_ID_CONFLICT'
  | 'TERMINAL_STATE'
  | 'DATABASE_FAILURE'

export class DispatchLedgerError extends Error {
  readonly code: DispatchLedgerErrorCode

  constructor(code: DispatchLedgerErrorCode, safeMessage: string) {
    super(safeMessage)
    this.name = 'DispatchLedgerError'
    this.code = code
  }
}

export function dispatchErrorCode(error: unknown): string | undefined {
  if (error instanceof DispatchLedgerError) return error.code
  if (error !== null && typeof error === 'object') {
    const code = Reflect.get(error, 'code')
    if (typeof code === 'string') return code
  }
  return undefined
}

export function asDispatchDatabaseError(error: unknown): DispatchLedgerError {
  if (error instanceof DispatchLedgerError) return error
  void error
  return new DispatchLedgerError('DATABASE_FAILURE', 'Dispatch Ledger persistence failed')
}
