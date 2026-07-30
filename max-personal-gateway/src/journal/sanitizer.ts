import { createHash } from 'node:crypto'
import type { JsonValue, QuarantineReason, RedactionEvidence, ReplayAvailability } from './types.ts'

export const RAW_EVENT_SANITIZER_VERSION = 'max-raw-sanitizer-v1'

const MAX_DEPTH = 40
const MAX_COLLECTION_ITEMS = 10_000
const SENSITIVE_QUERY_KEYS = /^(access_token|auth|authorization|code|credential|expires|key|password|refresh_token|session|sig|signature|token)$/i

const KEY_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/^(authorization|proxy-authorization)$/i, 'authorization'],
  [/^(cookie|set-cookie|cookies)$/i, 'cookie'],
  [/^(password|passwd|passphrase)$/i, 'password'],
  [/^(access[_-]?token)$/i, 'access_token'],
  [/^(refresh[_-]?token)$/i, 'refresh_token'],
  [/^(session[_-]?(secret|token|id)|session)$/i, 'session_secret'],
  [/^(private[_-]?key)$/i, 'private_key'],
  [/^(client[_-]?secret|(?:x[_-]?)?api[_-]?key|x[_-]?auth[_-]?token|secret|credential)$/i, 'credential'],
  [/^(token|bearer[_-]?token)$/i, 'token'],
]

export interface SanitizationResult {
  readonly sanitizedPayload: JsonValue
  readonly payloadSha256: string
  readonly payloadSizeBytes: number
  readonly replayAvailability: ReplayAvailability
  readonly quarantineReason?: QuarantineReason
  readonly redactionMetadata: RedactionEvidence
  readonly sanitizerVersion: typeof RAW_EVENT_SANITIZER_VERSION
}

interface MutableEvidence {
  readonly categories: Set<string>
  readonly paths: Set<string>
  readonly quarantineReasons: Set<QuarantineReason>
}

function record(evidence: MutableEvidence, category: string, path: string): string {
  evidence.categories.add(category)
  evidence.paths.add(path)
  return `[REDACTED:${category}]`
}

function sensitiveCategory(key: string): string | null {
  for (const [pattern, category] of KEY_RULES) {
    if (pattern.test(key)) return category
  }
  return null
}

function quarantine(
  evidence: MutableEvidence,
  reason: QuarantineReason,
  category: string,
  path: string,
  details: Readonly<Record<string, JsonValue>> = {},
): JsonValue {
  evidence.quarantineReasons.add(reason)
  evidence.categories.add(category)
  evidence.paths.add(path)
  return { $quarantine: { reason, ...details } }
}

type BinaryInput = ArrayBuffer | SharedArrayBuffer | ArrayBufferView

function binaryBytes(input: BinaryInput): Uint8Array {
  if (input instanceof ArrayBuffer || input instanceof SharedArrayBuffer) return new Uint8Array(input)
  return new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
}

function sanitizeBinary(input: BinaryInput, path: string, evidence: MutableEvidence): JsonValue {
  const bytes = binaryBytes(input)
  const sourceType = Buffer.isBuffer(input)
    ? 'Buffer'
    : input instanceof Uint8Array
      ? 'Uint8Array'
      : input instanceof DataView
        ? 'DataView'
        : 'ArrayBufferView'
  return quarantine(evidence, 'binary_payload_not_persisted', 'binary_payload', path, {
    sourceType: input instanceof ArrayBuffer
      ? 'ArrayBuffer'
      : input instanceof SharedArrayBuffer
        ? 'SharedArrayBuffer'
        : sourceType,
    byteLength: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytesStored: false,
  })
}

function sanitizeQueryString(value: string, path: string, evidence: MutableEvidence): string | null {
  const prefix = value.startsWith('?') ? '?' : ''
  const body = prefix ? value.slice(1) : value
  if (!body.includes('=')) return null
  const params = new URLSearchParams(body)
  let changed = false
  for (const key of [...params.keys()]) {
    if (!SENSITIVE_QUERY_KEYS.test(key)) continue
    params.set(key, record(evidence, 'signed_url_query', `${path}.query.${key}`))
    changed = true
  }
  return changed ? `${prefix}${params.toString()}` : null
}

function sanitizeString(value: string, path: string, evidence: MutableEvidence): string {
  if (value.includes('\u0000')) {
    record(evidence, 'postgres_nul_replacement', path)
    value = value.replaceAll('\u0000', '\uFFFD')
  }
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i.test(value)) {
    return record(evidence, 'private_key', path)
  }
  if (/^\s*Bearer\s+\S+/i.test(value)) {
    return record(evidence, 'bearer_token', path)
  }
  if (/^\s*(?:authorization|proxy-authorization)\s*:/i.test(value)) {
    return record(evidence, 'authorization', path)
  }
  if (/^\s*(?:cookie|set-cookie)\s*:/i.test(value)) {
    return record(evidence, 'cookie', path)
  }
  if (/(?:^|\s)Bearer\s+\S+/i.test(value)) {
    return record(evidence, 'bearer_token', path)
  }

  try {
    const url = new URL(value)
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      let changed = false
      if (url.username) {
        url.username = record(evidence, 'url_credentials', `${path}.username`)
        changed = true
      }
      if (url.password) {
        url.password = record(evidence, 'url_credentials', `${path}.password`)
        changed = true
      }
      for (const key of [...url.searchParams.keys()]) {
        if (SENSITIVE_QUERY_KEYS.test(key)) {
          url.searchParams.set(key, record(evidence, 'signed_url_query', `${path}.query.${key}`))
          changed = true
        }
      }
      if (changed) return url.toString()
    }
  } catch {
    // A non-URL string may still be a query string.
  }
  return sanitizeQueryString(value, path, evidence) ?? value
}

function sanitizeValue(
  input: unknown,
  path: string,
  evidence: MutableEvidence,
  seen: WeakSet<object>,
  depth: number,
): JsonValue {
  if (depth > MAX_DEPTH) {
    return quarantine(evidence, 'unsupported_payload', 'unsupported_value', path, { kind: 'max_depth' })
  }
  if (input === null || typeof input === 'boolean' || typeof input === 'string') {
    return typeof input === 'string' ? sanitizeString(input, path, evidence) : input
  }
  if (typeof input === 'number') {
    return Number.isFinite(input)
      ? input
      : quarantine(evidence, 'unsupported_payload', 'unsupported_value', path, { kind: 'non_finite_number' })
  }
  if (typeof input !== 'object') {
    return quarantine(evidence, 'unsupported_payload', 'unsupported_value', path, { kind: typeof input })
  }
  try {
    if (input instanceof ArrayBuffer || input instanceof SharedArrayBuffer || ArrayBuffer.isView(input)) {
      return sanitizeBinary(input, path, evidence)
    }
  } catch {
    return quarantine(evidence, 'unsupported_payload', 'unsupported_value', path, { kind: 'uninspectable_object' })
  }
  if (seen.has(input)) {
    return quarantine(evidence, 'unsupported_payload', 'unsupported_value', path, { kind: 'circular_reference' })
  }
  seen.add(input)
  try {
    if (Array.isArray(input)) {
      if (input.length > MAX_COLLECTION_ITEMS) {
        return quarantine(evidence, 'unsupported_payload', 'unsupported_value', path, {
          kind: 'collection_too_large',
          itemCount: input.length,
        })
      }
      const first = Object.getOwnPropertyDescriptor(input, '0')
      if (input.length === 2 && first && 'value' in first && typeof first.value === 'string') {
        const category = sensitiveCategory(first.value)
        if (category) return [first.value, record(evidence, category, `${path}[1]`)]
      }
      const result: JsonValue[] = []
      for (let index = 0; index < input.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(input, String(index))
        result.push(!descriptor || !('value' in descriptor)
          ? quarantine(evidence, 'unsupported_payload', 'unsupported_value', `${path}[${index}]`, { kind: 'array_accessor_or_hole' })
          : sanitizeValue(descriptor.value, `${path}[${index}]`, evidence, seen, depth + 1))
      }
      return result
    }

    if (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null) {
      return quarantine(evidence, 'unsupported_payload', 'unsupported_value', path, {
        kind: input instanceof Error ? 'error_object' : 'non_plain_object',
      })
    }

    const keys = Object.keys(input)
    if (keys.length > MAX_COLLECTION_ITEMS) {
      return quarantine(evidence, 'unsupported_payload', 'unsupported_value', path, {
        kind: 'collection_too_large',
        itemCount: keys.length,
      })
    }
    const result = Object.create(null) as Record<string, JsonValue>
    for (const key of keys.sort()) {
      let outputKey = key
      if (outputKey.includes('\u0000')) {
        record(evidence, 'postgres_nul_replacement', `${path}.$key`)
        outputKey = outputKey.replaceAll('\u0000', '\uFFFD')
      }
      if (Object.prototype.hasOwnProperty.call(result, outputKey)) {
        record(evidence, 'postgres_nul_key_collision', `${path}.$key`)
        outputKey = `${outputKey}[nul:${createHash('sha256').update(key).digest('hex').slice(0, 12)}]`
      }
      const childPath = path === '$' ? `$.${outputKey}` : `${path}.${outputKey}`
      const category = sensitiveCategory(key)
      if (category) {
        result[outputKey] = record(evidence, category, childPath)
        continue
      }
      const descriptor = Object.getOwnPropertyDescriptor(input, key)
      result[outputKey] = !descriptor || !('value' in descriptor)
        ? quarantine(evidence, 'unsupported_payload', 'unsupported_value', childPath, { kind: 'property_accessor' })
        : sanitizeValue(descriptor.value, childPath, evidence, seen, depth + 1)
    }
    return result
  } catch {
    return quarantine(evidence, 'unsupported_payload', 'unsupported_value', path, { kind: 'uninspectable_object' })
  } finally {
    seen.delete(input)
  }
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
}

export interface PostgresSafeJsonResult {
  readonly value: JsonValue
  readonly changed: boolean
  readonly paths: readonly string[]
  readonly payloadSha256: string
  readonly payloadSizeBytes: number
}

/**
 * PostgreSQL JSONB rejects U+0000 even though JSON.parse accepts `\\u0000`.
 * This compatibility boundary is also applied to already-durable v1 spool
 * envelopes so an upgrade can drain them without deleting or rewriting the
 * source evidence. The original payload hash is retained by the ingress in
 * correlation metadata whenever replacement is required.
 */
export function normalizePostgresSafeJson(input: JsonValue): PostgresSafeJsonResult {
  const paths: string[] = []
  const visit = (value: JsonValue, path: string): JsonValue => {
    if (typeof value === 'string') {
      if (!value.includes('\u0000')) return value
      paths.push(path)
      return value.replaceAll('\u0000', '\uFFFD')
    }
    if (value === null || typeof value !== 'object') return value
    if (Array.isArray(value)) return value.map((child, index) => visit(child, `${path}[${index}]`))
    const output = Object.create(null) as Record<string, JsonValue>
    for (const key of Object.keys(value).sort()) {
      let safeKey = key.replaceAll('\u0000', '\uFFFD')
      const childPath = path === '$' ? `$.${safeKey}` : `${path}.${safeKey}`
      if (safeKey !== key) paths.push(`${path}.$key`)
      if (Object.prototype.hasOwnProperty.call(output, safeKey)) {
        paths.push(`${path}.$key-collision`)
        safeKey = `${safeKey}[nul:${createHash('sha256').update(key).digest('hex').slice(0, 12)}]`
      }
      output[safeKey] = visit(value[key], childPath)
    }
    return output
  }
  const value = visit(input, '$')
  const canonicalPayload = canonicalJson(value)
  return {
    value,
    changed: paths.length > 0,
    paths: [...new Set(paths)].sort(),
    payloadSha256: createHash('sha256').update(canonicalPayload).digest('hex'),
    payloadSizeBytes: Buffer.byteLength(canonicalPayload, 'utf8'),
  }
}

export function sanitizeRawObservationPayload(input: unknown): SanitizationResult {
  const evidence: MutableEvidence = { categories: new Set(), paths: new Set(), quarantineReasons: new Set() }
  const sanitizedPayload = sanitizeValue(input, '$', evidence, new WeakSet(), 0)
  const canonicalPayload = canonicalJson(sanitizedPayload)
  const payloadSha256 = createHash('sha256').update(canonicalPayload).digest('hex')
  const quarantineReasons = [...evidence.quarantineReasons].sort()
  const quarantineReason = quarantineReasons.includes('unsupported_payload')
    ? 'unsupported_payload'
    : quarantineReasons[0]

  return {
    sanitizedPayload,
    payloadSha256,
    payloadSizeBytes: Buffer.byteLength(canonicalPayload, 'utf8'),
    replayAvailability: quarantineReason ? 'quarantined' : 'available',
    quarantineReason,
    sanitizerVersion: RAW_EVENT_SANITIZER_VERSION,
    redactionMetadata: {
      sanitizerVersion: RAW_EVENT_SANITIZER_VERSION,
      categories: [...evidence.categories].sort(),
      paths: [...evidence.paths].sort(),
    },
  }
}
