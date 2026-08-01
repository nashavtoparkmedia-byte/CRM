export const REQUIRED_MIGRATION = '20260727154647_add_max_capture_ingress' as const

const ACCOUNT = /^(?!true$|false$|1$|0$|all$)[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/i
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

export interface FeatureAccounts {
  readonly rawJournal: ReadonlySet<string>
  readonly normalizer: ReadonlySet<string>
  readonly providerConfirmation: ReadonlySet<string>
  readonly comparison: ReadonlySet<string>
  readonly liveCapture: ReadonlySet<string>
}

export interface GatewayConfig {
  readonly mode: 'dormant' | 'active'
  readonly bindHost: string
  readonly port: number
  readonly privateNetworkRequired: boolean
  readonly databaseUrl: string | null
  readonly hmacKeys: ReadonlyMap<string, string>
  readonly features: FeatureAccounts
  readonly enabledAccounts: ReadonlySet<string>
  readonly expectedMigration: typeof REQUIRED_MIGRATION
  readonly requestMaxBytes: number
  readonly bodyTimeoutMs: number
  readonly headerTimeoutMs: number
  readonly authClockSkewMs: number
  readonly workerBatchSize: number
  readonly workerPollMs: number
  readonly recentAckWindowMs: number
  readonly normalizerLagLimitMs: number
  readonly comparisonLagLimitMs: number
  readonly browserOwnersExpected: 1
  readonly browserOwnersObserved: number | null
  readonly senderModulesInactive: boolean
  readonly providerActionsInactive: boolean
}

export class GatewayConfigError extends Error {
  readonly code = 'INVALID_GATEWAY_CONFIG'
}

function boundedInteger(raw: string | undefined, fallback: number, minimum: number, maximum: number, name: string): number {
  if (raw === undefined || raw === '') return fallback
  if (!/^[0-9]+$/.test(raw)) throw new GatewayConfigError(`${name} must be a bounded integer`)
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new GatewayConfigError(`${name} must be a bounded integer`)
  }
  return value
}

export function parseExactAccountAllowlist(raw: string | undefined): ReadonlySet<string> {
  if (raw === undefined || raw === '') return new Set()
  const values = raw.split(',')
  if (values.length === 0 || values.some(value => value === '' || value !== value.trim() || !ACCOUNT.test(value))) {
    throw new GatewayConfigError('Feature account allowlist is malformed')
  }
  return new Set(values)
}

function parseHmacKeys(raw: string | undefined): ReadonlyMap<string, string> {
  if (raw === undefined || raw === '') return new Map()
  let value: unknown
  try { value = JSON.parse(raw) } catch { throw new GatewayConfigError('Ingress HMAC key set is malformed') }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new GatewayConfigError('Ingress HMAC key set is malformed')
  }
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length < 1 || entries.length > 4) throw new GatewayConfigError('Ingress HMAC key set is outside rotation bound')
  const keys = new Map<string, string>()
  for (const [keyId, secret] of entries) {
    if (!KEY_ID.test(keyId) || typeof secret !== 'string' || Buffer.byteLength(secret) < 32 || Buffer.byteLength(secret) > 512) {
      throw new GatewayConfigError('Ingress HMAC key entry is invalid')
    }
    keys.set(keyId, secret)
  }
  return keys
}

function subset(child: ReadonlySet<string>, parent: ReadonlySet<string>, label: string): void {
  for (const account of child) {
    if (!parent.has(account)) throw new GatewayConfigError(`${label} requires the upstream account feature`)
  }
}

export function loadGatewayConfig(environment: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const features: FeatureAccounts = {
    rawJournal: parseExactAccountAllowlist(environment.MAX_RAW_JOURNAL_ENABLED),
    normalizer: parseExactAccountAllowlist(environment.MAX_INBOUND_NORMALIZER_ENABLED),
    providerConfirmation: parseExactAccountAllowlist(environment.MAX_PROVIDER_CONFIRMATION_MATCHER_ENABLED),
    comparison: parseExactAccountAllowlist(environment.MAX_SHADOW_COMPARISON_ENABLED),
    liveCapture: parseExactAccountAllowlist(environment.MAX_PERSONAL_LIVE_CAPTURE_ENABLED),
  }
  subset(features.liveCapture, features.rawJournal, 'Live capture')
  subset(features.normalizer, features.rawJournal, 'Normalizer')
  subset(features.providerConfirmation, features.normalizer, 'Provider confirmation matcher')
  subset(features.comparison, features.normalizer, 'Comparison')
  const enabledAccounts = new Set([
    ...features.rawJournal,
    ...features.normalizer,
    ...features.providerConfirmation,
    ...features.comparison,
    ...features.liveCapture,
  ])
  const mode = enabledAccounts.size === 0 ? 'dormant' : 'active'
  if ((environment.MAX_PERSONAL_GATEWAY_BROWSER_OWNER ?? '') !== ''
    || (environment.MAX_PERSONAL_GATEWAY_CHROMIUM_PROFILE_PATH ?? '') !== '') {
    throw new GatewayConfigError('Browser ownership is prohibited in max-personal-gateway')
  }
  const browserOwnersExpected = boundedInteger(
    environment.MAX_PERSONAL_BROWSER_OWNERS_EXPECTED,
    1,
    1,
    1,
    'MAX_PERSONAL_BROWSER_OWNERS_EXPECTED',
  ) as 1
  const privateNetworkRequired = environment.MAX_PERSONAL_GATEWAY_PRIVATE_NETWORK === 'required'
  const bindHost = environment.MAX_PERSONAL_GATEWAY_BIND_HOST || '127.0.0.1'
  if (!['127.0.0.1', '::1', 'localhost', '0.0.0.0'].includes(bindHost)
    || (bindHost === '0.0.0.0' && !privateNetworkRequired)) {
    throw new GatewayConfigError('Gateway bind host must be loopback or an explicitly required private container network')
  }
  const databaseUrl = environment.MAX_PERSONAL_GATEWAY_DATABASE_URL || null
  if (mode === 'active' && (databaseUrl === null || !/^postgres(?:ql)?:\/\//.test(databaseUrl))) {
    throw new GatewayConfigError('Active gateway requires its explicit PostgreSQL URL')
  }
  const hmacKeys = parseHmacKeys(environment.MAX_PERSONAL_CAPTURE_HMAC_KEYS_JSON)
  if (mode === 'active' && features.rawJournal.size > 0 && hmacKeys.size === 0) {
    throw new GatewayConfigError('Active capture ingress requires HMAC keys')
  }
  const expectedMigration = environment.MAX_PERSONAL_GATEWAY_REQUIRED_MIGRATION || REQUIRED_MIGRATION
  if (expectedMigration !== REQUIRED_MIGRATION) throw new GatewayConfigError('Required migration version must be exact')
  return {
    mode,
    bindHost,
    port: boundedInteger(environment.MAX_PERSONAL_GATEWAY_PORT, 8080, 1, 65_535, 'MAX_PERSONAL_GATEWAY_PORT'),
    privateNetworkRequired,
    databaseUrl,
    hmacKeys,
    features,
    enabledAccounts,
    expectedMigration,
    requestMaxBytes: boundedInteger(environment.MAX_PERSONAL_CAPTURE_REQUEST_MAX_BYTES, 1_200_000, 1024, 2_000_000, 'MAX_PERSONAL_CAPTURE_REQUEST_MAX_BYTES'),
    bodyTimeoutMs: boundedInteger(environment.MAX_PERSONAL_CAPTURE_BODY_TIMEOUT_MS, 5_000, 100, 30_000, 'MAX_PERSONAL_CAPTURE_BODY_TIMEOUT_MS'),
    headerTimeoutMs: boundedInteger(environment.MAX_PERSONAL_CAPTURE_HEADER_TIMEOUT_MS, 5_000, 100, 30_000, 'MAX_PERSONAL_CAPTURE_HEADER_TIMEOUT_MS'),
    authClockSkewMs: boundedInteger(environment.MAX_PERSONAL_CAPTURE_AUTH_CLOCK_SKEW_MS, 30_000, 1_000, 300_000, 'MAX_PERSONAL_CAPTURE_AUTH_CLOCK_SKEW_MS'),
    workerBatchSize: boundedInteger(environment.MAX_PERSONAL_GATEWAY_WORKER_BATCH_SIZE, 100, 1, 1000, 'MAX_PERSONAL_GATEWAY_WORKER_BATCH_SIZE'),
    workerPollMs: boundedInteger(environment.MAX_PERSONAL_GATEWAY_WORKER_POLL_MS, 1000, 100, 60_000, 'MAX_PERSONAL_GATEWAY_WORKER_POLL_MS'),
    recentAckWindowMs: boundedInteger(environment.MAX_PERSONAL_CAPTURE_RECENT_ACK_MS, 60_000, 1000, 3_600_000, 'MAX_PERSONAL_CAPTURE_RECENT_ACK_MS'),
    normalizerLagLimitMs: boundedInteger(environment.MAX_PERSONAL_NORMALIZER_LAG_LIMIT_MS, 60_000, 1000, 3_600_000, 'MAX_PERSONAL_NORMALIZER_LAG_LIMIT_MS'),
    comparisonLagLimitMs: boundedInteger(environment.MAX_PERSONAL_COMPARISON_LAG_LIMIT_MS, 60_000, 1000, 3_600_000, 'MAX_PERSONAL_COMPARISON_LAG_LIMIT_MS'),
    browserOwnersExpected,
    browserOwnersObserved: null,
    senderModulesInactive: environment.MAX_PERSONAL_TEXT_SENDER_ENABLED !== 'true',
    providerActionsInactive: !(environment.MAX_PERSONAL_TEXT_SENDER_ENABLED === 'true'
      && environment.MAX_PERSONAL_TEXT_SENDER_PHYSICAL_ENABLED === 'true'
      && environment.MAX_PERSONAL_TEXT_SENDER_EMERGENCY_STOP_CLEAR === 'true'),
  }
}
