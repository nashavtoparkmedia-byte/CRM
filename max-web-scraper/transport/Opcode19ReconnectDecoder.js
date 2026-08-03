'use strict'

const { createHash } = require('crypto')
const { TextDecoder } = require('util')
const { providerMessageTimestampMs } = require('../lib/MaxMessageOrdering')
const { assessProviderText, low32RouteId } = require('../lib/MaxLiveConversation')

const OPCODE19_OUTER_LENGTH = 15
const OPCODE19_MAX_SNAPSHOT_BYTES = 256 * 1024
const OPCODE19_MAX_TEXT_BYTES = 16 * 1024
const REAL_PROVIDER_MESSAGE_ID = /^d301[0-9a-f]{14}$/i
const ACCOUNT_ID = /^(?!true$|false$|1$|0$|all$)[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/i
const PROVIDER_USER_ID = /^\d{9,15}$/
const PROTOCOL_CHAT_ID = /^\d{11,15}$/
const WEB_ROUTE_ID = /^\d{1,10}$/
const UTF8_FATAL_DECODER = new TextDecoder('utf-8', { fatal: true })

const LAST_MESSAGE_KEY = Buffer.from('ab6c6173744d657373616765', 'hex')
const LAST_MESSAGE_PREFIX = Buffer.from('ab6c6173744d657373616765de0006a26964c70901', 'hex')
const TYPE_USER_FIELD = Buffer.from('a474797065a455534552', 'hex')
const SENDER_UINT64_FIELD = Buffer.from('a673656e646572cf', 'hex')
const TEXT_KEY = Buffer.from('a474657874', 'hex')
const EMPTY_ATTACHMENTS = Buffer.from('a8617474616368657390', 'hex')
const ROUTE_UINT64_FIELD = Buffer.from('a5726f757465cf', 'hex')
const PREV_KEY = Buffer.from('ad70726576', 'hex')

function fail(reason, details = {}) {
  return { ok: false, reason, ...details }
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function indexesOf(buffer, marker, start = 0, end = buffer.length) {
  const indexes = []
  let cursor = Math.max(0, start)
  while (cursor <= end - marker.length) {
    const index = buffer.indexOf(marker, cursor)
    if (index === -1 || index + marker.length > end) break
    indexes.push(index)
    cursor = index + 1
  }
  return indexes
}

function requireBytes(buffer, offset, length) {
  if (!Number.isSafeInteger(length) || length < 0 || offset < 0 || offset + length > buffer.length) {
    throw new Error('msgpack_value_truncated')
  }
  return offset + length
}

function hasBytesAt(buffer, offset, expected) {
  return offset >= 0
    && offset + expected.length <= buffer.length
    && buffer.subarray(offset, offset + expected.length).equals(expected)
}

function skipMessagePackValues(buffer, offset, count, state, depth) {
  let cursor = offset
  for (let index = 0; index < count; index += 1) {
    cursor = skipMessagePackValue(buffer, cursor, state, depth + 1)
  }
  return cursor
}

function skipMessagePackValue(buffer, offset, state, depth = 0) {
  if (depth > 24 || state.values >= state.maxValues) throw new Error('msgpack_value_limit_exceeded')
  state.values += 1
  requireBytes(buffer, offset, 1)
  const prefix = buffer[offset]

  if (prefix <= 0x7f || prefix >= 0xe0 || prefix === 0xc0 || prefix === 0xc2 || prefix === 0xc3) {
    return offset + 1
  }
  if ((prefix & 0xe0) === 0xa0) return requireBytes(buffer, offset + 1, prefix & 0x1f)
  if ((prefix & 0xf0) === 0x90) {
    return skipMessagePackValues(buffer, offset + 1, prefix & 0x0f, state, depth)
  }
  if ((prefix & 0xf0) === 0x80) {
    return skipMessagePackValues(buffer, offset + 1, (prefix & 0x0f) * 2, state, depth)
  }

  if (prefix === 0xc4 || prefix === 0xd9) {
    requireBytes(buffer, offset + 1, 1)
    return requireBytes(buffer, offset + 2, buffer[offset + 1])
  }
  if (prefix === 0xc5 || prefix === 0xda) {
    requireBytes(buffer, offset + 1, 2)
    return requireBytes(buffer, offset + 3, buffer.readUInt16BE(offset + 1))
  }
  if (prefix === 0xc6 || prefix === 0xdb) {
    requireBytes(buffer, offset + 1, 4)
    return requireBytes(buffer, offset + 5, buffer.readUInt32BE(offset + 1))
  }
  if (prefix === 0xc7) {
    requireBytes(buffer, offset + 1, 2)
    return requireBytes(buffer, offset + 3, buffer[offset + 1])
  }
  if (prefix === 0xc8) {
    requireBytes(buffer, offset + 1, 3)
    return requireBytes(buffer, offset + 4, buffer.readUInt16BE(offset + 1))
  }
  if (prefix === 0xc9) {
    requireBytes(buffer, offset + 1, 5)
    return requireBytes(buffer, offset + 6, buffer.readUInt32BE(offset + 1))
  }

  const fixedWidths = new Map([
    [0xca, 5], [0xcb, 9], [0xcc, 2], [0xcd, 3], [0xce, 5], [0xcf, 9],
    [0xd0, 2], [0xd1, 3], [0xd2, 5], [0xd3, 9],
    [0xd4, 3], [0xd5, 4], [0xd6, 6], [0xd7, 10], [0xd8, 18],
  ])
  if (fixedWidths.has(prefix)) return requireBytes(buffer, offset, fixedWidths.get(prefix))

  if (prefix === 0xdc || prefix === 0xdd) {
    const width = prefix === 0xdc ? 2 : 4
    requireBytes(buffer, offset + 1, width)
    const count = width === 2 ? buffer.readUInt16BE(offset + 1) : buffer.readUInt32BE(offset + 1)
    if (count > state.maxValues) throw new Error('msgpack_value_limit_exceeded')
    return skipMessagePackValues(buffer, offset + 1 + width, count, state, depth)
  }
  if (prefix === 0xde || prefix === 0xdf) {
    const width = prefix === 0xde ? 2 : 4
    requireBytes(buffer, offset + 1, width)
    const count = width === 2 ? buffer.readUInt16BE(offset + 1) : buffer.readUInt32BE(offset + 1)
    if (count > Math.floor(state.maxValues / 2)) throw new Error('msgpack_value_limit_exceeded')
    return skipMessagePackValues(buffer, offset + 1 + width, count * 2, state, depth)
  }
  throw new Error('msgpack_type_unsupported')
}

function decodeCarrier(value, maxBytes) {
  if (Buffer.isBuffer(value)) {
    if (value.length > maxBytes) return fail('snapshot_oversized', { byteLength: value.length })
    return { ok: true, bytes: Buffer.from(value), encoding: 'buffer' }
  }

  if (value && typeof value === 'object' && value.type === 'Buffer' && Array.isArray(value.data)) {
    if (value.data.length > maxBytes) return fail('snapshot_oversized', { byteLength: value.data.length })
    if (value.data.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
      return fail('snapshot_buffer_json_invalid')
    }
    return { ok: true, bytes: Buffer.from(value.data), encoding: 'buffer_json' }
  }

  if (typeof value !== 'string' || value.length === 0 || value.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(value)) {
    return fail('not_even_hex_carrier')
  }
  if (value.length > maxBytes * 2) return fail('snapshot_oversized', { byteLength: value.length / 2 })
  return { ok: true, bytes: Buffer.from(value, 'hex'), encoding: 'hex' }
}

function decodeMessagePackString(buffer, offset, maxTextBytes) {
  if (offset >= buffer.length) return fail('text_value_missing')
  const prefix = buffer[offset]
  let length
  let headerLength

  if ((prefix & 0xe0) === 0xa0) {
    length = prefix & 0x1f
    headerLength = 1
  } else if (prefix === 0xd9) {
    if (offset + 2 > buffer.length) return fail('text_header_truncated')
    length = buffer[offset + 1]
    headerLength = 2
  } else if (prefix === 0xda) {
    if (offset + 3 > buffer.length) return fail('text_header_truncated')
    length = buffer.readUInt16BE(offset + 1)
    headerLength = 3
  } else if (prefix === 0xdb) {
    if (offset + 5 > buffer.length) return fail('text_header_truncated')
    length = buffer.readUInt32BE(offset + 1)
    headerLength = 5
  } else {
    return fail('text_value_not_msgpack_string')
  }

  if (length === 0) return fail('text_empty')
  if (length > maxTextBytes) return fail('text_oversized', { textByteLength: length })
  const start = offset + headerLength
  const end = start + length
  if (end > buffer.length) return fail('text_value_truncated')

  let text
  try {
    text = UTF8_FATAL_DECODER.decode(buffer.subarray(start, end))
  } catch {
    return fail('text_invalid_utf8')
  }
  const assessment = assessProviderText(text)
  if (!assessment.accepted) return fail(assessment.reason || 'text_rejected')
  return { ok: true, text: assessment.text, start, end, byteLength: length }
}

/**
 * Decode only the privacy-safe opcode-19 reconnect shape proven in production:
 * an outer array of 15 values with exactly one binary/even-hex carrier. The
 * carrier must contain one exact lastMessage map prefix and one unambiguous
 * text-only message marker sequence. No recursive object or DOM heuristics are
 * used here.
 */
function decodeOpcode19ReconnectPayload(payload, options = {}) {
  const maxBytes = Number.isSafeInteger(options.maxSnapshotBytes)
    ? options.maxSnapshotBytes
    : OPCODE19_MAX_SNAPSHOT_BYTES
  const maxTextBytes = Number.isSafeInteger(options.maxTextBytes)
    ? options.maxTextBytes
    : OPCODE19_MAX_TEXT_BYTES
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 128 || maxBytes > OPCODE19_MAX_SNAPSHOT_BYTES) {
    return fail('snapshot_limit_invalid')
  }
  if (!Number.isSafeInteger(maxTextBytes) || maxTextBytes < 1 || maxTextBytes > OPCODE19_MAX_TEXT_BYTES) {
    return fail('text_limit_invalid')
  }
  if (!Array.isArray(payload) || payload.length !== OPCODE19_OUTER_LENGTH) {
    return fail('outer_shape_mismatch')
  }

  const carriers = []
  let oversized = null
  for (let index = 0; index < payload.length; index += 1) {
    const decoded = decodeCarrier(payload[index], maxBytes)
    if (decoded.ok) carriers.push({ ...decoded, index })
    else if (decoded.reason === 'snapshot_oversized') oversized = decoded
  }
  if (oversized) return oversized
  if (carriers.length !== 1) return fail('carrier_count_mismatch', { carrierCount: carriers.length })

  const carrier = carriers[0]
  const bytes = carrier.bytes
  const lastMessageIndexes = indexesOf(bytes, LAST_MESSAGE_PREFIX)
  if (lastMessageIndexes.length !== 1) {
    return fail('last_message_prefix_count_mismatch', { count: lastMessageIndexes.length })
  }
  const lastMessageOffset = lastMessageIndexes[0]
  const lastMessageMapOffset = lastMessageOffset + LAST_MESSAGE_KEY.length
  let lastMessageEnd
  try {
    lastMessageEnd = skipMessagePackValue(bytes, lastMessageMapOffset, { values: 0, maxValues: 2048 })
  } catch (error) {
    return fail('last_message_map_invalid', { detail: error.message })
  }
  if (lastMessageEnd + PREV_KEY.length > bytes.length
    || !bytes.subarray(lastMessageEnd, lastMessageEnd + PREV_KEY.length).equals(PREV_KEY)) {
    return fail('following_prev_key_missing')
  }
  const providerIdOffset = lastMessageOffset + LAST_MESSAGE_PREFIX.length
  if (providerIdOffset + 9 > lastMessageEnd) return fail('provider_message_id_truncated')
  const providerMessageId = bytes.subarray(providerIdOffset, providerIdOffset + 9).toString('hex')
  if (!REAL_PROVIDER_MESSAGE_ID.test(providerMessageId)) return fail('provider_message_id_invalid')

  let cursor = providerIdOffset + 9
  if (!hasBytesAt(bytes, cursor, TYPE_USER_FIELD)) return fail('type_user_field_mismatch')
  cursor += TYPE_USER_FIELD.length
  if (!hasBytesAt(bytes, cursor, SENDER_UINT64_FIELD)) return fail('sender_field_mismatch')
  const senderValueOffset = cursor + SENDER_UINT64_FIELD.length
  if (senderValueOffset + 8 > lastMessageEnd) return fail('sender_value_truncated')
  const senderProviderUserId = bytes.readBigUInt64BE(senderValueOffset).toString()
  if (!PROVIDER_USER_ID.test(senderProviderUserId)) return fail('sender_provider_user_id_invalid')
  cursor = senderValueOffset + 8
  const textKeyOffset = cursor
  if (!hasBytesAt(bytes, textKeyOffset, TEXT_KEY)) return fail('text_key_mismatch')

  const parsedText = decodeMessagePackString(bytes, textKeyOffset + TEXT_KEY.length, maxTextBytes)
  if (!parsedText.ok) return parsedText
  if (parsedText.end > lastMessageEnd) return fail('text_value_outside_last_message')
  const attachmentsOffset = parsedText.end
  if (!hasBytesAt(bytes, attachmentsOffset, EMPTY_ATTACHMENTS)) {
    return fail('text_only_attachments_shape_mismatch')
  }
  const routeFieldOffset = attachmentsOffset + EMPTY_ATTACHMENTS.length
  if (!hasBytesAt(bytes, routeFieldOffset, ROUTE_UINT64_FIELD)) return fail('route_field_mismatch')
  const routeValueOffset = routeFieldOffset + ROUTE_UINT64_FIELD.length
  if (routeValueOffset + 8 > lastMessageEnd) return fail('route_value_truncated')
  const protocolChatId = bytes.readBigUInt64BE(routeValueOffset).toString()
  if (!PROTOCOL_CHAT_ID.test(protocolChatId)) return fail('protocol_chat_id_invalid')
  if (routeValueOffset + 8 !== lastMessageEnd) return fail('last_message_fields_mismatch')
  const prevOffset = lastMessageEnd
  const senderLow32 = low32RouteId(senderProviderUserId)
  const webRouteLow32 = low32RouteId(protocolChatId)
  if (!senderLow32 || !webRouteLow32 || senderLow32 === '0' || webRouteLow32 === '0') {
    return fail('low32_evidence_invalid')
  }

  const providerTimestampMs = providerMessageTimestampMs(providerMessageId, options.nowMs)
  if (!Number.isFinite(providerTimestampMs)) return fail('provider_timestamp_invalid')

  return {
    ok: true,
    candidate: {
      providerMessageId,
      providerTimestampMs,
      text: parsedText.text,
      messageType: 'text',
      attachmentCount: 0,
      senderProviderUserId,
      protocolChatId,
      senderLow32,
      webRouteLow32,
      rawSnapshotEvidence: {
        schemaVersion: 1,
        outerLength: payload.length,
        carrierIndex: carrier.index,
        carrierEncoding: carrier.encoding,
        byteLength: bytes.length,
        sha256: sha256(bytes),
        lastMessageOffset,
        lastMessageMapOffset,
        lastMessageEnd,
        senderValueOffset,
        textKeyOffset,
        attachmentsOffset,
        routeValueOffset,
        prevOffset,
      },
    },
  }
}

function normalizeBinding(value) {
  if (!value || typeof value !== 'object') return null
  const binding = {
    accountId: String(value.accountId || ''),
    ownerProviderUserId: String(value.ownerProviderUserId || ''),
    protocolChatId: String(value.protocolChatId || ''),
    senderProviderUserId: String(value.senderProviderUserId || ''),
    webRouteId: String(value.webRouteId || value.uiRouteId || ''),
    routeOwnerAccountId: String(value.routeOwnerAccountId || ''),
    fencingToken: value.fencingToken == null ? null : String(value.fencingToken),
  }
  if (!ACCOUNT_ID.test(binding.accountId)
    || !PROVIDER_USER_ID.test(binding.ownerProviderUserId)
    || !PROTOCOL_CHAT_ID.test(binding.protocolChatId)
    || !PROVIDER_USER_ID.test(binding.senderProviderUserId)
    || !WEB_ROUTE_ID.test(binding.webRouteId)
    || binding.senderProviderUserId === binding.ownerProviderUserId
    || low32RouteId(binding.protocolChatId) !== binding.webRouteId
    || low32RouteId(binding.senderProviderUserId) == null
    || binding.routeOwnerAccountId !== binding.accountId) {
    return null
  }
  return binding
}

/**
 * Bind low-32 evidence to one exact authenticated account/owner/route record.
 * The resolver must supply the full identities; this function never guesses a
 * 64-bit provider identity from its low 32 bits.
 */
function bindOpcode19ReconnectMessage(decoded, context) {
  const candidate = decoded?.ok === true ? decoded.candidate : decoded?.candidate || decoded
  if (!candidate
    || !REAL_PROVIDER_MESSAGE_ID.test(String(candidate.providerMessageId || ''))
    || !PROVIDER_USER_ID.test(String(candidate.senderProviderUserId || ''))
    || !PROTOCOL_CHAT_ID.test(String(candidate.protocolChatId || ''))) {
    return fail('decoded_candidate_invalid')
  }
  const accountId = String(context?.accountId || '')
  const ownerProviderUserId = String(context?.ownerProviderUserId || '')
  if (!ACCOUNT_ID.test(accountId) || !PROVIDER_USER_ID.test(ownerProviderUserId)) {
    return fail('authenticated_binding_invalid')
  }

  const bindings = Array.isArray(context?.bindings)
    ? context.bindings.map(normalizeBinding).filter(Boolean)
    : []
  const matches = bindings.filter(binding => (
    binding.accountId === accountId
    && binding.ownerProviderUserId === ownerProviderUserId
    && binding.routeOwnerAccountId === accountId
    && binding.senderProviderUserId === String(candidate.senderProviderUserId)
    && binding.protocolChatId === String(candidate.protocolChatId)
    && low32RouteId(binding.senderProviderUserId) === String(candidate.senderLow32)
    && binding.webRouteId === String(candidate.webRouteLow32)
  ))
  if (matches.length !== 1) {
    return fail('binding_match_count_mismatch', { matchCount: matches.length })
  }
  const binding = matches[0]
  const messageEnvelope = {
    chatId: binding.protocolChatId,
    message: {
      id: { __maxId: true, hex: candidate.providerMessageId },
      time: candidate.providerTimestampMs,
      type: 'USER',
      sender: binding.senderProviderUserId,
      text: candidate.text,
      attaches: [],
    },
    providerAccountId: binding.accountId,
    uiRouteId: binding.webRouteId,
    opcode19ReconnectEvidence: candidate.rawSnapshotEvidence,
  }
  return { ok: true, candidate, binding, messageEnvelope }
}

function isOpcode19ReconnectCandidate(value) {
  return Boolean(value?.ok === true
    && REAL_PROVIDER_MESSAGE_ID.test(String(value?.candidate?.providerMessageId || ''))
    && value?.candidate?.messageType === 'text'
    && value?.candidate?.attachmentCount === 0)
}

module.exports = {
  OPCODE19_MAX_SNAPSHOT_BYTES,
  OPCODE19_MAX_TEXT_BYTES,
  OPCODE19_OUTER_LENGTH,
  bindOpcode19ReconnectMessage,
  decodeOpcode19ReconnectPayload,
  isOpcode19ReconnectCandidate,
}
