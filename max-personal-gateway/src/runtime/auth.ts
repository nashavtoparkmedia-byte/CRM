import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

export const CAPTURE_AUTH_VERSION = 'max-capture-hmac-v1' as const

export interface CaptureAuthHeaders {
  readonly keyId: string
  readonly timestamp: string
  readonly signature: string
}

function bodyHash(body: Buffer): string {
  return createHash('sha256').update(body).digest('hex')
}

function signingInput(method: string, path: string, timestamp: string, body: Buffer): string {
  return `${CAPTURE_AUTH_VERSION}\n${method.toUpperCase()}\n${path}\n${timestamp}\n${bodyHash(body)}`
}

export function signCaptureRequest(
  secret: string,
  keyId: string,
  method: string,
  path: string,
  timestamp: string,
  body: Buffer,
): CaptureAuthHeaders {
  return {
    keyId,
    timestamp,
    signature: createHmac('sha256', secret).update(signingInput(method, path, timestamp, body)).digest('hex'),
  }
}

export type CaptureAuthResult =
  | { readonly authenticated: true; readonly keyId: string }
  | { readonly authenticated: false; readonly code: 'AUTH_MISSING' | 'AUTH_INVALID' | 'AUTH_EXPIRED' }

export function authenticateCaptureRequest(input: {
  readonly keys: ReadonlyMap<string, string>
  readonly method: string
  readonly path: string
  readonly body: Buffer
  readonly keyId: string | undefined
  readonly timestamp: string | undefined
  readonly signature: string | undefined
  readonly now?: number
  readonly maximumClockSkewMs: number
}): CaptureAuthResult {
  if (input.keyId === undefined || input.timestamp === undefined || input.signature === undefined) {
    return { authenticated: false, code: 'AUTH_MISSING' }
  }
  if (!/^[0-9]{13}$/.test(input.timestamp) || !/^[a-f0-9]{64}$/i.test(input.signature)) {
    return { authenticated: false, code: 'AUTH_INVALID' }
  }
  const observedAt = Number(input.timestamp)
  if (!Number.isSafeInteger(observedAt) || Math.abs((input.now ?? Date.now()) - observedAt) > input.maximumClockSkewMs) {
    return { authenticated: false, code: 'AUTH_EXPIRED' }
  }
  const secret = input.keys.get(input.keyId)
  if (secret === undefined) return { authenticated: false, code: 'AUTH_INVALID' }
  const expected = createHmac('sha256', secret)
    .update(signingInput(input.method, input.path, input.timestamp, input.body)).digest()
  const supplied = Buffer.from(input.signature, 'hex')
  if (supplied.length !== expected.length || !timingSafeEqual(expected, supplied)) {
    return { authenticated: false, code: 'AUTH_INVALID' }
  }
  return { authenticated: true, keyId: input.keyId }
}
