export type RouteRegistryErrorCode =
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  | 'ACCOUNT_MISMATCH'
  | 'IDENTITY_CONFLICT'
  | 'OPEN_CONFLICT'
  | 'STALE_ROUTE_VERSION'
  | 'STALE_CONFLICT_VERSION'
  | 'ROUTE_NOT_SENDABLE'
  | 'DATABASE_FAILURE'

export class RouteRegistryError extends Error {
  readonly code: RouteRegistryErrorCode

  constructor(code: RouteRegistryErrorCode, safeMessage: string) {
    super(safeMessage)
    this.name = 'RouteRegistryError'
    this.code = code
  }
}

export function asRouteDatabaseError(error: unknown): RouteRegistryError {
  if (error instanceof RouteRegistryError) return error
  // Database errors may contain SQL or connection details. The public error is
  // deliberately classified without preserving the original message/cause.
  void error
  return new RouteRegistryError('DATABASE_FAILURE', 'Route Registry persistence failed')
}
