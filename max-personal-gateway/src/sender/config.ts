import { canaryConversationScope } from './scope.ts'

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,191}$/
const ACCOUNT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

export interface TextSenderRuntimeConfig {
  readonly enabled: boolean
  readonly physicalEnabled: boolean
  readonly emergencyStopClear: boolean
  readonly accountId: string | null
  readonly conversationScopes: ReadonlySet<string>
  readonly hmacKeys: ReadonlyMap<string, Buffer>
  readonly currentKeyId: string | null
  readonly commandHmacSecret: Buffer | null
  readonly scraperUrl: URL | null
  readonly sessionOwnerInstanceId: string | null
  readonly actorOwnerId: string | null
  readonly requestTimeoutMs: number
}

function jsonArray(raw: string | undefined): string[] {
  let value: unknown
  try { value = JSON.parse(raw || '[]') } catch { throw new Error('Text sender conversation allowlist is invalid') }
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item.length < 1 || item.length > 512 || /\p{Cc}/u.test(item))) {
    throw new Error('Text sender conversation allowlist is invalid')
  }
  return value
}

function keys(raw: string | undefined): ReadonlyMap<string, Buffer> {
  let value: unknown
  try { value = JSON.parse(raw || '{}') } catch { throw new Error('Text sender HMAC keys are invalid') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Text sender HMAC keys are invalid')
  const result = new Map<string, Buffer>()
  for (const [keyId, secret] of Object.entries(value as Record<string, unknown>)) {
    if (!KEY_ID.test(keyId) || typeof secret !== 'string' || Buffer.byteLength(secret) < 32 || Buffer.byteLength(secret) > 512) {
      throw new Error('Text sender HMAC key is invalid')
    }
    result.set(keyId, Buffer.from(secret))
  }
  return result
}

function timeout(raw: string | undefined): number {
  if (raw === undefined || raw === '') return 40_000
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 1_000 || value > 60_000) throw new Error('Text sender timeout is invalid')
  return value
}

export function loadTextSenderRuntimeConfig(environment: NodeJS.ProcessEnv = process.env): TextSenderRuntimeConfig {
  const enabled = environment.MAX_PERSONAL_TEXT_SENDER_ENABLED === 'true'
  if (!enabled) return {
    enabled: false, physicalEnabled: false, emergencyStopClear: false, accountId: null,
    conversationScopes: new Set(), hmacKeys: new Map(), currentKeyId: null, commandHmacSecret: null,
    scraperUrl: null, sessionOwnerInstanceId: null, actorOwnerId: null, requestTimeoutMs: 40_000,
  }
  const accountId = environment.MAX_PERSONAL_TEXT_SENDER_ACCOUNT_ID || ''
  const currentKeyId = environment.MAX_PERSONAL_TEXT_SENDER_HMAC_KEY_ID || ''
  const senderKeys = keys(environment.MAX_PERSONAL_TEXT_SENDER_HMAC_KEYS_JSON)
  const commandSecret = environment.MAX_PERSONAL_TEXT_COMMAND_HMAC_SECRET || ''
  const sessionOwnerInstanceId = environment.MAX_PERSONAL_TEXT_SENDER_OWNER_ID || ''
  const actorOwnerId = environment.MAX_PERSONAL_TEXT_ACTOR_OWNER_ID || ''
  const scraperUrl = new URL(environment.MAX_PERSONAL_TEXT_SENDER_SCRAPER_URL || '')
  if (!ACCOUNT.test(accountId) || accountId === '*' || !KEY_ID.test(currentKeyId) || !senderKeys.has(currentKeyId)
    || Buffer.byteLength(commandSecret) < 32 || !IDENTIFIER.test(sessionOwnerInstanceId) || !IDENTIFIER.test(actorOwnerId)
    || scraperUrl.protocol !== 'http:' || scraperUrl.hostname !== 'max-web-scraper' || scraperUrl.port !== '3005'
    || scraperUrl.pathname !== '/v1/personal-max/send/text' || scraperUrl.search || scraperUrl.hash || scraperUrl.username || scraperUrl.password) {
    throw new Error('Text sender runtime binding is invalid')
  }
  const conversations = jsonArray(environment.MAX_PERSONAL_TEXT_SENDER_CONVERSATIONS_JSON)
  const conversationScopes = new Set(conversations.map(conversation => canaryConversationScope(accountId, conversation)))
  if (conversationScopes.size > 1) throw new Error('Text sender canary must be bound to at most one conversation')
  return {
    enabled,
    physicalEnabled: environment.MAX_PERSONAL_TEXT_SENDER_PHYSICAL_ENABLED === 'true',
    emergencyStopClear: environment.MAX_PERSONAL_TEXT_SENDER_EMERGENCY_STOP_CLEAR === 'true',
    accountId,
    conversationScopes,
    hmacKeys: senderKeys,
    currentKeyId,
    commandHmacSecret: Buffer.from(commandSecret),
    scraperUrl,
    sessionOwnerInstanceId,
    actorOwnerId,
    requestTimeoutMs: timeout(environment.MAX_PERSONAL_TEXT_SENDER_REQUEST_TIMEOUT_MS),
  }
}
