export type CaptureErrorCode =
  | 'INVALID_CAPTURE_CONFIG'
  | 'INVALID_CAPTURE_ENVELOPE'
  | 'SPOOL_IO_FAILURE'
  | 'SPOOL_FULL'
  | 'SPOOL_RECORD_TOO_LARGE'
  | 'SPOOL_CORRUPT'
  | 'INGRESS_REJECTED'
  | 'INGRESS_UNAVAILABLE'
  | 'CAPTURE_ENVELOPE_ID_COLLISION'

export class CaptureError extends Error {
  readonly code: CaptureErrorCode

  constructor(code: CaptureErrorCode, safeMessage: string, options?: { cause?: unknown }) {
    super(safeMessage, options)
    this.name = 'CaptureError'
    this.code = code
  }
}

export function captureErrorCode(error: unknown): CaptureErrorCode {
  return error instanceof CaptureError ? error.code : 'INGRESS_UNAVAILABLE'
}
