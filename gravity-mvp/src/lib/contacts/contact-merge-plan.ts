import { createHash, createHmac, timingSafeEqual } from 'crypto'

const MERGE_TOKEN_TTL_MS = 5 * 60 * 1000

export type ContactMergeConfirmationPayload = {
  version: 1
  actorId: string
  sourceId: string
  targetId: string
  planHash: string
  sourceVersion: string
  targetVersion: string
  expiresAt: number
}

export class ContactMergeTokenError extends Error {
  constructor(message = 'Merge confirmation token is invalid') {
    super(message)
    this.name = 'ContactMergeTokenError'
  }
}

function mergeTokenSecret(): string {
  const secret = process.env.CONTACT_MERGE_TOKEN_SECRET
    || process.env.PHONE_RESOLUTION_TOKEN_SECRET
    || process.env.NEXTAUTH_SECRET
    || process.env.AUTH_SECRET
    || process.env.DATABASE_URL
  if (!secret) throw new ContactMergeTokenError('Merge confirmation is not configured')
  return secret
}

function normalizeJson(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'bigint') return value.toString()
  if (Array.isArray(value)) return value.map(normalizeJson)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, normalizeJson(nested)]),
    )
  }
  return value
}

export function stableMergeJson(value: unknown): string {
  return JSON.stringify(normalizeJson(value))
}

export function hashMergeValue(value: unknown): string {
  return createHash('sha256').update(stableMergeJson(value)).digest('hex')
}

function sign(encodedPayload: string, secret: string): string {
  return createHmac('sha256', secret).update(encodedPayload).digest('base64url')
}

export function createContactMergeConfirmationToken(
  payload: Omit<ContactMergeConfirmationPayload, 'version' | 'expiresAt'>,
  options: { secret?: string; now?: number } = {},
): { token: string; expiresAt: number } {
  const expiresAt = (options.now ?? Date.now()) + MERGE_TOKEN_TTL_MS
  const value: ContactMergeConfirmationPayload = {
    version: 1,
    ...payload,
    expiresAt,
  }
  const encoded = Buffer.from(JSON.stringify(value)).toString('base64url')
  return {
    token: `${encoded}.${sign(encoded, options.secret ?? mergeTokenSecret())}`,
    expiresAt,
  }
}

export function verifyContactMergeConfirmationToken(
  token: string,
  options: { secret?: string; now?: number } = {},
): ContactMergeConfirmationPayload {
  const [encoded, providedSignature] = token.split('.')
  if (!encoded || !providedSignature) throw new ContactMergeTokenError()

  const expectedSignature = sign(encoded, options.secret ?? mergeTokenSecret())
  const provided = Buffer.from(providedSignature)
  const expected = Buffer.from(expectedSignature)
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    throw new ContactMergeTokenError()
  }

  let payload: ContactMergeConfirmationPayload
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as ContactMergeConfirmationPayload
  } catch {
    throw new ContactMergeTokenError()
  }

  if (
    payload.version !== 1
    || !payload.actorId
    || !payload.sourceId
    || !payload.targetId
    || !payload.planHash
    || !payload.sourceVersion
    || !payload.targetVersion
    || payload.expiresAt < (options.now ?? Date.now())
  ) {
    throw new ContactMergeTokenError('Merge confirmation token expired or is invalid')
  }

  return payload
}

export function toMergeJsonValue(value: unknown): unknown {
  return JSON.parse(stableMergeJson(value)) as unknown
}
