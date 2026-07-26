export type JournalErrorCode =
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  | 'ACCOUNT_MISMATCH'
  | 'CLAIM_CONFLICT'
  | 'STALE_WORKER'
  | 'CURSOR_CONFLICT'
  | 'DATABASE_FAILURE'

export class JournalError extends Error {
  readonly code: JournalErrorCode

  constructor(code: JournalErrorCode, safeMessage: string, options?: { cause?: unknown }) {
    super(safeMessage, options)
    this.name = 'JournalError'
    this.code = code
  }
}

export function asJournalDatabaseError(error: unknown): JournalError {
  if (error instanceof JournalError) return error
  // The driver error can contain connection details or SQL fragments. Keep it
  // outside the public domain error; infrastructure logging may classify it at
  // a separately redacted boundary.
  void error
  return new JournalError('DATABASE_FAILURE', 'Raw event journal persistence failed')
}
