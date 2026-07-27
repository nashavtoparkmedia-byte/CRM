export type ShadowComparisonErrorCode =
  | 'INVALID_INPUT'
  | 'RUN_NOT_FOUND'
  | 'RUN_SCOPE_MISMATCH'
  | 'RUN_NOT_RUNNING'
  | 'OBSERVATION_NOT_FOUND'
  | 'CURSOR_CONFLICT'
  | 'COMPARISON_TRANSACTION_FAILED'

export class ShadowComparisonError extends Error {
  readonly code: ShadowComparisonErrorCode

  constructor(code: ShadowComparisonErrorCode, message: string) {
    super(message)
    this.name = 'ShadowComparisonError'
    this.code = code
  }
}
