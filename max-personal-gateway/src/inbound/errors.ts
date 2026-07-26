export type InboundNormalizationErrorCode =
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  | 'ACCOUNT_MISMATCH'
  | 'CLAIM_CONFLICT'
  | 'STALE_WORKER'
  | 'CURSOR_CONFLICT'
  | 'NORMALIZER_MALFORMED'
  | 'NORMALIZER_OVERSIZED'
  | 'DATABASE_FAILURE'

export class InboundNormalizationError extends Error {
  readonly code: InboundNormalizationErrorCode

  constructor(code: InboundNormalizationErrorCode, safeMessage: string, options?: ErrorOptions) {
    super(safeMessage, options)
    this.name = 'InboundNormalizationError'
    this.code = code
  }
}
export function normalizationErrorCode(error: unknown): string | undefined {
  if (error instanceof InboundNormalizationError) return error.code
  if (error !== null && typeof error === 'object') {
    const code = Reflect.get(error, 'code')
    if (typeof code === 'string') return code
  }
  return undefined
}

export function asInboundDatabaseError(error: unknown): InboundNormalizationError {
  if (error instanceof InboundNormalizationError) return error
  const code = normalizationErrorCode(error)
  if (code === 'P2002') return new InboundNormalizationError('CLAIM_CONFLICT', 'Normalization was created concurrently', { cause: error })
  if (code === 'P2034') return new InboundNormalizationError('CURSOR_CONFLICT', 'Concurrent transaction conflict', { cause: error })
  return new InboundNormalizationError('DATABASE_FAILURE', 'Inbound normalization database operation failed', { cause: error })
}
