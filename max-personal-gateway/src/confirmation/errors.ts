export type ConfirmationMatcherErrorCode =
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  | 'ACCOUNT_MISMATCH'
  | 'EVIDENCE_CONFLICT'
  | 'CORRELATION_DISAGREEMENT'
  | 'ROUTE_MISMATCH'
  | 'PROVIDER_MESSAGE_ID_CONFLICT'
  | 'CONFIRMATION_INVARIANT_CONFLICT'
  | 'LATE_CONFIRMATION_AFTER_TERMINAL_ADVANCE'
  | 'STALE_RESOLUTION_VERSION'
  | 'CURSOR_CONFLICT'
  | 'ABSENCE_EVIDENCE_DENIED'
  | 'DATABASE_FAILURE'

export class ConfirmationMatcherError extends Error {
  readonly code: ConfirmationMatcherErrorCode

  constructor(code: ConfirmationMatcherErrorCode, safeMessage: string, options?: ErrorOptions) {
    super(safeMessage, options)
    this.name = 'ConfirmationMatcherError'
    this.code = code
  }
}
export function confirmationErrorCode(error: unknown): string | undefined {
  if (error instanceof ConfirmationMatcherError) return error.code
  if (error !== null && typeof error === 'object') {
    const code = Reflect.get(error, 'code')
    return typeof code === 'string' ? code : undefined
  }
  return undefined
}

export function asConfirmationDatabaseError(error: unknown): ConfirmationMatcherError {
  if (error instanceof ConfirmationMatcherError) return error
  return new ConfirmationMatcherError('DATABASE_FAILURE', 'Confirmation matcher persistence failed', { cause: error })
}
