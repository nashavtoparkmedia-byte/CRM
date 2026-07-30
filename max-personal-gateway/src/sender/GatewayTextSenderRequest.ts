import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { TEXT_SENDER_AUTH_NAMESPACE, TEXT_SENDER_SCHEMA_VERSION } from './types.ts'
import type { BuildTextSenderRequestInput, TextSenderAuthenticationV1, TextSenderRequestV1 } from './types.ts'

const IDENTIFIER = /^[^\p{Cc}]{1,256}$/u
const ACCOUNT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

function identifier(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value !== value.trim() || value === '*' || !IDENTIFIER.test(value)) throw new Error(`${field} is invalid`)
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  return `{${Object.keys(value as Record<string, unknown>).sort().map(key => `${JSON.stringify(key)}:${canonical(Reflect.get(value as object, key))}`).join(',')}}`
}

export function canonicalTextSenderBody(request: TextSenderRequestV1): string {
  return canonical(request)
}

export function buildTextSenderRequest(input: BuildTextSenderRequestInput): TextSenderRequestV1 {
  if (!ACCOUNT.test(input.accountId) || input.accountId === '*') throw new Error('accountId is invalid')
  for (const [value, field] of [[input.conversationKey, 'conversationKey'], [input.route.protocolChatId, 'protocolChatId'], [input.commandId, 'commandId'],
    [input.attemptId, 'attemptId'], [input.attemptCorrelationId, 'attemptCorrelationId'], [input.idempotencyKey, 'idempotencyKey'], [input.ownerInstanceId, 'ownerInstanceId']] as const) identifier(value, field)
  if (!Number.isSafeInteger(input.route.routeVersion) || input.route.routeVersion < 1) throw new Error('routeVersion is invalid')
  if (typeof input.fencingToken !== 'bigint' || input.fencingToken < 1n) throw new Error('fencingToken is invalid')
  if (input.payload.kind !== 'text' || typeof input.payload.text !== 'string' || input.payload.text.length === 0 || Buffer.byteLength(input.payload.text, 'utf8') > 65_536) {
    throw new Error('text payload is invalid')
  }
  if (!Number.isFinite(input.requestedAt.valueOf()) || !Number.isFinite(input.deadlineAt.valueOf()) || input.deadlineAt <= input.requestedAt) throw new Error('request time bounds are invalid')
  return Object.freeze({
    schemaVersion: TEXT_SENDER_SCHEMA_VERSION,
    accountId: input.accountId,
    conversationKey: input.conversationKey,
    route: Object.freeze({ ...input.route }),
    commandId: input.commandId,
    attemptId: input.attemptId,
    attemptCorrelationId: input.attemptCorrelationId,
    clientMessageId: input.clientMessageId,
    idempotencyKey: input.idempotencyKey,
    ownerInstanceId: input.ownerInstanceId,
    fencingToken: input.fencingToken.toString(10),
    payload: Object.freeze({ kind: 'text' as const, text: input.payload.text }),
    requestedAt: input.requestedAt.toISOString(),
    deadlineAt: input.deadlineAt.toISOString(),
  })
}

export function signTextSenderRequest(
  request: TextSenderRequestV1,
  input: { readonly keyId: string; readonly secret: Buffer; readonly timestamp: Date; readonly nonce: string },
): TextSenderAuthenticationV1 {
  identifier(input.keyId, 'keyId')
  identifier(input.nonce, 'nonce')
  if (!Buffer.isBuffer(input.secret) || input.secret.byteLength < 32) throw new Error('sender authentication key is invalid')
  if (!Number.isFinite(input.timestamp.valueOf())) throw new Error('authentication timestamp is invalid')
  const timestamp = input.timestamp.toISOString()
  const bodySha256 = createHash('sha256').update(canonicalTextSenderBody(request)).digest('hex')
  const signingInput = `${TEXT_SENDER_AUTH_NAMESPACE}\n${input.keyId}\n${timestamp}\n${input.nonce}\n${bodySha256}`
  const signature = createHmac('sha256', input.secret).update(signingInput).digest('hex')
  return Object.freeze({ namespace: TEXT_SENDER_AUTH_NAMESPACE, keyId: input.keyId, timestamp, nonce: input.nonce, bodySha256, signature })
}

export function verifyTextSenderAuthentication(
  request: TextSenderRequestV1,
  authentication: TextSenderAuthenticationV1,
  input: { readonly keys: ReadonlyMap<string, Buffer>; readonly now: Date; readonly maximumClockSkewMs: number },
): boolean {
  if (authentication?.namespace !== TEXT_SENDER_AUTH_NAMESPACE
    || typeof authentication.keyId !== 'string' || typeof authentication.timestamp !== 'string'
    || typeof authentication.nonce !== 'string' || authentication.nonce.length < 1 || authentication.nonce.length > 256
    || !/^[0-9a-f]{64}$/.test(authentication.bodySha256 || '') || !/^[0-9a-f]{64}$/.test(authentication.signature || '')) return false
  const timestamp = new Date(authentication.timestamp)
  if (!Number.isFinite(timestamp.valueOf()) || Math.abs(input.now.valueOf() - timestamp.valueOf()) >= input.maximumClockSkewMs) return false
  const secret = input.keys.get(authentication.keyId)
  if (!secret || secret.byteLength < 32) return false
  const bodySha256 = createHash('sha256').update(canonicalTextSenderBody(request)).digest('hex')
  if (bodySha256 !== authentication.bodySha256) return false
  const expected = createHmac('sha256', secret)
    .update(`${TEXT_SENDER_AUTH_NAMESPACE}\n${authentication.keyId}\n${authentication.timestamp}\n${authentication.nonce}\n${bodySha256}`)
    .digest()
  const supplied = Buffer.from(authentication.signature, 'hex')
  return supplied.byteLength === expected.byteLength && timingSafeEqual(supplied, expected)
}
