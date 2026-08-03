'use strict'

const crypto = require('crypto')
const {
  postJson,
  requireDurableMaxWebhookAcknowledgement,
} = require('../inbound/CrmWebhookDelivery')
const {
  bindOpcode19ReconnectMessage,
  decodeOpcode19ReconnectPayload,
} = require('../transport/Opcode19ReconnectDecoder')

const INCIDENT_ACCOUNT_ID = 'max-personal-81d98d8cc9fc95c1f1c0461f'
const INCIDENT_OWNER_PROVIDER_USER_ID = '902171753248'
const INCIDENT_PROTOCOL_CHAT_ID = '902454841098'
const INCIDENT_SENDER_PROVIDER_USER_ID = '902264026154'
const INCIDENT_WEB_ROUTE_ID = '511708938'
const APPLY_AUTHORIZATION_ENV = 'PERSONAL_MAX_OPCODE19_REPLAY_AUTHORIZED'
const APPLY_AUTHORIZATION_VALUE = 'YES'
const MAX_STDIN_BYTES = 2 * 1024 * 1024

const INCIDENT_ROWS = Object.freeze({
  '68978': Object.freeze({
    journalSequence: '68978',
    observationId: '725a4991-18f2-4b5b-b49a-c1bf3858367c',
    payloadSha256: '76be13741b63e64d11e299fc3e557a2403232ce5f73ac6ca77b1f6690d1ea03c',
    providerMessageId: 'd3019fc8d4774a04bc',
    text: 'ывапро',
  }),
  '69360': Object.freeze({
    journalSequence: '69360',
    observationId: '2846db8a-6423-47e3-8bea-00c65ff56613',
    payloadSha256: '936f7681215e8d69e26eb66aadeb4225479f3b2a8e2aadd24c8c941121f5444f',
    providerMessageId: 'd3019fc8d8ab3a4130',
    text: 'у',
  }),
})

const INCIDENT_BINDING = Object.freeze({
  accountId: INCIDENT_ACCOUNT_ID,
  ownerProviderUserId: INCIDENT_OWNER_PROVIDER_USER_ID,
  protocolChatId: INCIDENT_PROTOCOL_CHAT_ID,
  senderProviderUserId: INCIDENT_SENDER_PROVIDER_USER_ID,
  webRouteId: INCIDENT_WEB_ROUTE_ID,
  routeOwnerAccountId: INCIDENT_ACCOUNT_ID,
})

class ReplayIncidentError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'ReplayIncidentError'
    this.code = code
  }
}

function replayError(code, message) {
  return new ReplayIncidentError(code, message)
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
}

function canonicalPayloadSha256(value) {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex')
}

function normalizeJournalSequence(value) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) return null
    return String(value)
  }
  if (typeof value === 'string' && /^(?:0|[1-9]\d*)$/.test(value)) return value
  return null
}

function exactString(value) {
  return typeof value === 'string' ? value : null
}

function validateRawRowMetadata(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw replayError('RAW_ROW_INVALID', 'Each raw row must be a JSON object')
  }
  const journalSequence = normalizeJournalSequence(row.journalSequence)
  const expected = journalSequence ? INCIDENT_ROWS[journalSequence] : null
  if (!expected) {
    throw replayError('RAW_ROW_NOT_ALLOWLISTED', 'Raw row journal sequence is not allowlisted')
  }
  if (exactString(row.observationId) !== expected.observationId) {
    throw replayError('OBSERVATION_ID_MISMATCH', `Observation identity mismatch for journal sequence ${journalSequence}`)
  }
  if (exactString(row.accountId) !== INCIDENT_ACCOUNT_ID) {
    throw replayError('ACCOUNT_ID_MISMATCH', `Account identity mismatch for journal sequence ${journalSequence}`)
  }
  if (row.opcode !== 19) {
    throw replayError('OPCODE_MISMATCH', `Opcode mismatch for journal sequence ${journalSequence}`)
  }
  if (exactString(row.replayAvailability) !== 'available') {
    throw replayError('REPLAY_NOT_AVAILABLE', `Raw row is not replayable for journal sequence ${journalSequence}`)
  }
  if (exactString(row.payloadSha256) !== expected.payloadSha256) {
    throw replayError('PAYLOAD_SHA_METADATA_MISMATCH', `Payload SHA metadata mismatch for journal sequence ${journalSequence}`)
  }
  if (!Object.prototype.hasOwnProperty.call(row, 'sanitizedPayload')) {
    throw replayError('SANITIZED_PAYLOAD_MISSING', `Sanitized payload is missing for journal sequence ${journalSequence}`)
  }
  return { expected, journalSequence }
}

function prepareReplayItems(rows, dependencies = {}) {
  if (!Array.isArray(rows)) throw replayError('RAW_ROWS_NOT_ARRAY', 'Standard input must be one JSON array of raw rows')
  if (rows.length !== Object.keys(INCIDENT_ROWS).length) {
    throw replayError('RAW_ROW_COUNT_MISMATCH', 'Exactly two allowlisted raw rows are required')
  }

  const decode = dependencies.decodeOpcode19ReconnectPayload || decodeOpcode19ReconnectPayload
  const bind = dependencies.bindOpcode19ReconnectMessage || bindOpcode19ReconnectMessage
  const payloadSha256 = dependencies.canonicalPayloadSha256 || canonicalPayloadSha256
  const seenSequences = new Set()
  const seenObservations = new Set()
  const seenProviderIds = new Set()
  const items = []

  for (const row of rows) {
    const { expected, journalSequence } = validateRawRowMetadata(row)
    if (seenSequences.has(journalSequence) || seenObservations.has(row.observationId)) {
      throw replayError('RAW_ROW_DUPLICATE', 'Each allowlisted raw row must occur exactly once')
    }
    seenSequences.add(journalSequence)
    seenObservations.add(row.observationId)

    if (payloadSha256(row.sanitizedPayload, row) !== expected.payloadSha256) {
      throw replayError('PAYLOAD_SHA_CONTENT_MISMATCH', `Sanitized payload hash mismatch for journal sequence ${journalSequence}`)
    }

    const decoded = decode(row.sanitizedPayload)
    if (!decoded || decoded.ok !== true) {
      throw replayError('OPCODE19_DECODE_REJECTED', `Opcode 19 payload rejected for journal sequence ${journalSequence}: ${decoded?.reason || 'unknown'}`)
    }
    if (decoded.candidate?.providerMessageId !== expected.providerMessageId
      || decoded.candidate?.text !== expected.text) {
      throw replayError('INCIDENT_MESSAGE_MISMATCH', `Decoded message mismatch for journal sequence ${journalSequence}`)
    }
    if (!Number.isSafeInteger(decoded.candidate.providerTimestampMs) || decoded.candidate.providerTimestampMs <= 0) {
      throw replayError('PROVIDER_TIMESTAMP_INVALID', `Provider timestamp is invalid for journal sequence ${journalSequence}`)
    }
    if (seenProviderIds.has(decoded.candidate.providerMessageId)) {
      throw replayError('PROVIDER_ID_DUPLICATE', 'Decoded provider identities must be unique')
    }
    seenProviderIds.add(decoded.candidate.providerMessageId)

    const bound = bind(decoded, {
      accountId: INCIDENT_ACCOUNT_ID,
      ownerProviderUserId: INCIDENT_OWNER_PROVIDER_USER_ID,
      bindings: [INCIDENT_BINDING],
    })
    if (!bound || bound.ok !== true) {
      throw replayError('INCIDENT_BINDING_REJECTED', `Opcode 19 binding rejected for journal sequence ${journalSequence}: ${bound?.reason || 'unknown'}`)
    }
    if (bound.binding?.accountId !== INCIDENT_ACCOUNT_ID
      || bound.binding?.ownerProviderUserId !== INCIDENT_OWNER_PROVIDER_USER_ID
      || bound.binding?.protocolChatId !== INCIDENT_PROTOCOL_CHAT_ID
      || bound.binding?.senderProviderUserId !== INCIDENT_SENDER_PROVIDER_USER_ID
      || bound.binding?.webRouteId !== INCIDENT_WEB_ROUTE_ID
      || bound.binding?.routeOwnerAccountId !== INCIDENT_ACCOUNT_ID) {
      throw replayError('INCIDENT_BINDING_MISMATCH', `Bound route mismatch for journal sequence ${journalSequence}`)
    }

    items.push(Object.freeze({
      journalSequence,
      observationId: expected.observationId,
      providerMessageId: expected.providerMessageId,
      providerTimestampMs: decoded.candidate.providerTimestampMs,
      text: expected.text,
      binding: Object.freeze({ ...bound.binding }),
    }))
  }

  if (seenSequences.size !== Object.keys(INCIDENT_ROWS).length) {
    throw replayError('RAW_ALLOWLIST_INCOMPLETE', 'Both allowlisted raw rows are required')
  }

  return items.sort((left, right) => (
    left.providerTimestampMs - right.providerTimestampMs
    || Number(left.journalSequence) - Number(right.journalSequence)
  ))
}

function buildWebhookPayload(item) {
  return {
    externalId: item.providerMessageId,
    chatId: item.binding.protocolChatId,
    senderId: item.binding.senderProviderUserId,
    phone: null,
    text: item.text,
    timestamp: new Date(item.providerTimestampMs).toISOString(),
    messageType: 'text',
    attachments: [],
    isOutgoing: false,
    replyToExternalId: null,
    source: 'raw_journal_replay',
    rawChatId: item.binding.protocolChatId,
    providerAccountId: item.binding.accountId,
    protocolChatId: item.binding.protocolChatId,
    uiRouteId: item.binding.webRouteId,
    providerUserId: item.binding.senderProviderUserId,
  }
}

function isInternalHostname(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '')
  if (!host) return false
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) return true
  if (/^[a-z0-9][a-z0-9_-]*$/i.test(host) && !/^\d+$/.test(host)) return true
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (ipv4) {
    const octets = ipv4.slice(1).map(Number)
    if (octets.some(value => value > 255)) return false
    return octets[0] === 10
      || octets[0] === 127
      || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
      || (octets[0] === 192 && octets[1] === 168)
  }
  return host === '::1' || /^f[cd][0-9a-f:]+$/i.test(host)
}

function requireInternalWebhookUrl(env) {
  if (!Object.prototype.hasOwnProperty.call(env, 'CRM_WEBHOOK_URL')
    || typeof env.CRM_WEBHOOK_URL !== 'string'
    || env.CRM_WEBHOOK_URL.trim() === '') {
    throw replayError('CRM_WEBHOOK_URL_REQUIRED', 'Apply requires an explicit internal CRM_WEBHOOK_URL')
  }
  let url
  try {
    url = new URL(env.CRM_WEBHOOK_URL)
  } catch {
    throw replayError('CRM_WEBHOOK_URL_INVALID', 'CRM_WEBHOOK_URL must be an absolute URL')
  }
  if (!['http:', 'https:'].includes(url.protocol)
    || url.username || url.password
    || url.pathname !== '/api/webhooks/max'
    || url.search || url.hash
    || !isInternalHostname(url.hostname)) {
    throw replayError('CRM_WEBHOOK_URL_NOT_INTERNAL', 'CRM_WEBHOOK_URL must target the exact internal plural MAX webhook without credentials or query data')
  }
  return url.toString()
}

function requireApplyAuthorization(env) {
  if (env[APPLY_AUTHORIZATION_ENV] !== APPLY_AUTHORIZATION_VALUE) {
    throw replayError('REPLAY_NOT_AUTHORIZED', `Apply requires ${APPLY_AUTHORIZATION_ENV}=${APPLY_AUTHORIZATION_VALUE}`)
  }
}

function summarizeItem(item, acknowledgement = null) {
  return {
    journalSequence: item.journalSequence,
    observationId: item.observationId,
    providerMessageId: item.providerMessageId,
    providerTimestampMs: item.providerTimestampMs,
    protocolChatId: item.binding.protocolChatId,
    ...(acknowledgement ? {
      messageId: acknowledgement.messageId,
      chatInternalId: acknowledgement.chatInternalId,
      deduped: acknowledgement.deduped,
    } : {}),
  }
}

async function runReplay(options) {
  const rows = options?.rows
  const apply = options?.apply === true
  const env = options?.env || process.env
  const post = options?.postJson || postJson
  const items = prepareReplayItems(rows, options?.dependencies)

  if (!apply) {
    return {
      success: true,
      mode: 'dry-run',
      providerActions: 0,
      databaseDirectWrites: 0,
      rawJournalMutations: 0,
      readyCount: items.length,
      items: items.map(item => summarizeItem(item)),
    }
  }

  requireApplyAuthorization(env)
  const webhookUrl = requireInternalWebhookUrl(env)
  const results = []
  for (const item of items) {
    const response = await post(webhookUrl, buildWebhookPayload(item), {
      timeoutMs: env.MAX_PERSONAL_CRM_WEBHOOK_TIMEOUT_MS,
    })
    const acknowledgement = requireDurableMaxWebhookAcknowledgement(response)
    results.push(summarizeItem(item, acknowledgement))
  }
  return {
    success: true,
    mode: 'apply',
    providerActions: 0,
    databaseDirectWrites: 0,
    rawJournalMutations: 0,
    acknowledgedCount: results.length,
    items: results,
  }
}

function parseCliArguments(argv) {
  if (argv.length === 0 || (argv.length === 1 && argv[0] === '--dry-run')) return { apply: false }
  if (argv.length === 1 && argv[0] === '--apply') return { apply: true }
  throw replayError('CLI_ARGUMENTS_INVALID', 'Usage: replay-op19-incident.js [--dry-run|--apply]')
}

function parseRowsJson(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw replayError('STDIN_EMPTY', 'Standard input must contain the raw-row JSON array')
  }
  if (Buffer.byteLength(value) > MAX_STDIN_BYTES) {
    throw replayError('STDIN_OVERSIZED', 'Standard input exceeds the bounded replay limit')
  }
  let parsed
  try {
    parsed = JSON.parse(value)
  } catch {
    throw replayError('STDIN_JSON_INVALID', 'Standard input is not valid JSON')
  }
  if (!Array.isArray(parsed)) throw replayError('RAW_ROWS_NOT_ARRAY', 'Standard input must be one JSON array of raw rows')
  return parsed
}

function readStdinBounded(input = process.stdin) {
  return new Promise((resolve, reject) => {
    let settled = false
    let bytes = 0
    const chunks = []
    const finish = operation => {
      if (settled) return
      settled = true
      operation()
    }
    input.on('data', chunk => {
      if (settled) return
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      bytes += buffer.length
      if (bytes > MAX_STDIN_BYTES) {
        finish(() => reject(replayError('STDIN_OVERSIZED', 'Standard input exceeds the bounded replay limit')))
        if (typeof input.destroy === 'function') input.destroy()
        else if (typeof input.pause === 'function') input.pause()
        return
      }
      chunks.push(buffer)
    })
    input.on('end', () => finish(() => resolve(Buffer.concat(chunks).toString('utf8'))))
    input.on('error', error => finish(() => reject(replayError('STDIN_READ_FAILED', error?.message || 'Unable to read standard input'))))
  })
}

async function main(argv = process.argv.slice(2), env = process.env, input = process.stdin) {
  const { apply } = parseCliArguments(argv)
  const rows = parseRowsJson(await readStdinBounded(input))
  const result = await runReplay({ rows, apply, env })
  process.stdout.write(`${JSON.stringify(result)}\n`)
  return result
}

if (require.main === module) {
  main().catch(error => {
    const code = typeof error?.code === 'string' ? error.code : 'REPLAY_FAILED'
    process.stderr.write(`${JSON.stringify({ success: false, code, message: error?.message || 'Replay failed' })}\n`)
    process.exitCode = 1
  })
}

module.exports = {
  APPLY_AUTHORIZATION_ENV,
  APPLY_AUTHORIZATION_VALUE,
  INCIDENT_ACCOUNT_ID,
  INCIDENT_BINDING,
  INCIDENT_ROWS,
  MAX_STDIN_BYTES,
  ReplayIncidentError,
  buildWebhookPayload,
  canonicalJson,
  canonicalPayloadSha256,
  isInternalHostname,
  main,
  parseCliArguments,
  parseRowsJson,
  prepareReplayItems,
  readStdinBounded,
  requireApplyAuthorization,
  requireInternalWebhookUrl,
  runReplay,
}
