export type OutboundActorErrorCode =
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  | 'ACCOUNT_MISMATCH'
  | 'COMMAND_IDEMPOTENCY_CONFLICT'
  | 'CLIENT_MESSAGE_ID_CONFLICT'
  | 'LEASE_HELD'
  | 'STALE_ACTOR_LEASE'
  | 'STALE_ACTOR_VERSION'
  | 'RESERVATION_CONFLICT'
  | 'RESERVATION_NOT_ACTIVE'
  | 'STALE_RESERVATION_VERSION'
  | 'RESERVATION_NOT_EXPIRED'
  | 'ALREADY_HANDED_OFF'
  | 'DISPATCH_LEDGER_REQUIRED'
  | 'ROUTE_NOT_SENDABLE'
  | 'DATABASE_FAILURE'

export class OutboundActorError extends Error {
  readonly code: OutboundActorErrorCode

  constructor(code: OutboundActorErrorCode, safeMessage: string) {
    super(safeMessage)
    this.name = 'OutboundActorError'
    this.code = code
  }
}

export function outboundErrorCode(error: unknown): string | undefined {
  if (error instanceof OutboundActorError) return error.code
  if (error !== null && typeof error === 'object') {
    const code = Reflect.get(error, 'code')
    if (typeof code === 'string') return code
  }
  return undefined
}

export function asOutboundDatabaseError(error: unknown): OutboundActorError {
  if (error instanceof OutboundActorError) return error
  void error
  return new OutboundActorError('DATABASE_FAILURE', 'Outbound actor persistence failed')
}
