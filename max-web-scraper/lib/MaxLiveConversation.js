'use strict'

const REAL_PROVIDER_MESSAGE_ID = /^d301[0-9a-f]{14}$/i

function normalizeRussianPhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '')
  if (digits.length === 10) return `+7${digits}`
  if (digits.length === 11 && (digits.startsWith('7') || digits.startsWith('8'))) {
    return `+7${digits.slice(1)}`
  }
  return null
}

function assessProviderText(value) {
  if (typeof value !== 'string') {
    return { accepted: false, reason: 'provider_text_not_string', text: null }
  }
  if (value.includes('\uFFFD')) {
    return { accepted: false, reason: 'provider_text_invalid_utf8', text: null }
  }
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value)) {
    return { accepted: false, reason: 'provider_text_control_bytes', text: null }
  }
  const lower = value.toLocaleLowerCase('ru-RU')
  if (/attaches.{0,32}prevm|prevmsg|\bttl.{0,16}unread/.test(lower)) {
    return { accepted: false, reason: 'provider_text_protocol_fragment', text: null }
  }
  return { accepted: true, reason: null, text: value }
}

function providerPeerUserId(chat, myUserId) {
  if (!chat || typeof chat !== 'object') return null
  if (chat.type && String(chat.type).toUpperCase() !== 'DIALOG') return null
  const participants = chat.participants && typeof chat.participants === 'object'
    ? Object.keys(chat.participants)
    : []
  const owner = String(myUserId || '')
  if (owner && !participants.includes(owner)) return null
  const peers = participants
    .map(String)
    .filter(value => value !== owner && /^\d{9,15}$/.test(value))
  return peers.length === 1 ? peers[0] : null
}

function low32RouteId(protocolChatId) {
  try {
    return BigInt.asUintN(32, BigInt(String(protocolChatId))).toString()
  } catch {
    return null
  }
}

function protocolChatIdForUiRouteCandidate(uiRouteId, chats) {
  const route = String(uiRouteId || '')
  if (!/^\d{1,10}$/.test(route)) return null
  const matches = []
  for (const [chatId] of chats || []) {
    const protocolChatId = String(chatId || '')
    if (/^\d{11,15}$/.test(protocolChatId) && low32RouteId(protocolChatId) === route) {
      matches.push(protocolChatId)
    }
  }
  return matches.length === 1 ? matches[0] : null
}

function stableProviderOrder(left, right) {
  const timeDelta = Number(left?.timestamp || 0) - Number(right?.timestamp || 0)
  if (timeDelta !== 0) return timeDelta
  return String(left?.providerMessageId || '').localeCompare(String(right?.providerMessageId || ''))
}

function buildProviderHistorySnapshot({
  accountId,
  protocolChatId,
  uiRouteId,
  providerUserId,
  ownerUserId,
  phone,
  phoneEvidence,
  candidates,
  windowStart,
  windowEnd,
  providerChatId,
  routeMatchCount,
}) {
  const start = new Date(windowStart).getTime()
  const end = new Date(windowEnd).getTime()
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) {
    throw new Error('History snapshot window is invalid')
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(String(accountId || ''))) {
    throw new Error('History snapshot account is invalid')
  }
  if (!/^\d{11,15}$/.test(String(protocolChatId || ''))
    || !/^\d{1,10}$/.test(String(uiRouteId || ''))
    || low32RouteId(protocolChatId) !== String(uiRouteId)) {
    throw new Error('History snapshot route binding is invalid')
  }
  if (!/^\d{9,15}$/.test(String(providerUserId || ''))
    || !/^\d{9,15}$/.test(String(ownerUserId || ''))
    || String(providerUserId) === String(ownerUserId)) {
    throw new Error('History snapshot participant binding is invalid')
  }
  if (String(providerChatId || '') !== String(protocolChatId) || Number(routeMatchCount) !== 1) {
    throw new Error('History snapshot provider route is ambiguous')
  }

  const seen = new Set()
  const messages = []
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const rawTimestamp = Number(candidate?.timestamp)
    const timestamp = rawTimestamp > 0 && rawTimestamp < 1e12 ? rawTimestamp * 1000 : rawTimestamp
    let providerMessageId = null
    try {
      let numeric = BigInt(String(candidate?.id))
      if (numeric < 0n) numeric += 1n << 64n
      providerMessageId = `d3${numeric.toString(16).padStart(16, '0')}`
    } catch {}
    if (!REAL_PROVIDER_MESSAGE_ID.test(String(providerMessageId || ''))
      || !Number.isFinite(timestamp) || timestamp < start || timestamp > end
      || seen.has(providerMessageId)) continue

    const text = assessProviderText(candidate?.text)
    const attachmentCount = Number.isInteger(candidate?.attachmentCount)
      ? Math.max(0, candidate.attachmentCount)
      : 0
    const messageType = attachmentCount > 0 ? String(candidate?.messageType || 'attachment') : 'text'
    if (!text.accepted && attachmentCount === 0) {
      messages.push({
        providerMessageId,
        direction: candidate?.isOutgoing ? 'outbound' : 'inbound',
        providerUserId: candidate?.isOutgoing ? String(ownerUserId) : String(providerUserId),
        timestamp,
        text: null,
        textDisposition: 'quarantined',
        quarantineReason: text.reason,
        messageType,
        attachmentCount,
      })
      seen.add(providerMessageId)
      continue
    }
    messages.push({
      providerMessageId,
      direction: candidate?.isOutgoing ? 'outbound' : 'inbound',
      providerUserId: candidate?.isOutgoing ? String(ownerUserId) : String(providerUserId),
      timestamp,
      text: text.text,
      textDisposition: text.accepted ? 'exact_unicode' : 'not_text',
      quarantineReason: text.reason,
      messageType,
      attachmentCount,
    })
    seen.add(providerMessageId)
  }

  messages.sort(stableProviderOrder)
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    source: 'max_provider_store_read_only',
    accountId: String(accountId),
    protocolChatId: String(protocolChatId),
    uiRouteId: String(uiRouteId),
    providerChatId: String(providerChatId),
    routeMatchCount: Number(routeMatchCount),
    providerUserId: String(providerUserId),
    ownerUserId: String(ownerUserId),
    profile: {
      phone: normalizeRussianPhone(phone),
      phoneEvidence: phoneEvidence || null,
    },
    window: {
      start: new Date(start).toISOString(),
      end: new Date(end).toISOString(),
    },
    messages,
  }
}

module.exports = {
  assessProviderText,
  buildProviderHistorySnapshot,
  low32RouteId,
  normalizeRussianPhone,
  protocolChatIdForUiRouteCandidate,
  providerPeerUserId,
  stableProviderOrder,
}
