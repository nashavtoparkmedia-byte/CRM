import type { ShadowRefusalReason } from './types.ts'

export type ShadowPlanErrorCode = 'INVALID_INPUT' | 'NOT_FOUND' | 'IDEMPOTENCY_CONFLICT' | 'DATABASE_FAILURE'

export class ShadowPlanError extends Error {
  readonly code: ShadowPlanErrorCode | ShadowRefusalReason

  constructor(code: ShadowPlanErrorCode | ShadowRefusalReason, safeMessage: string) {
    super(safeMessage)
    this.name = 'ShadowPlanError'
    this.code = code
  }
}

export function asShadowPlanDatabaseError(error: unknown): ShadowPlanError {
  if (error instanceof ShadowPlanError) return error
  void error
  return new ShadowPlanError('DATABASE_FAILURE', 'Outbound shadow plan persistence failed')
}
