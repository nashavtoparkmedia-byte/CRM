'use strict'

const crypto = require('crypto')

const MAX_RUNTIME_TRACE_PREFIX = '[MAX_RUNTIME_TRACE]'
let eventSeq = 0

function shortHash(value) {
  return crypto.createHash('sha1').update(String(value || '')).digest('hex').slice(0, 12)
}

function traceIdFor(fields = {}) {
  const providerMessageId = fields.providerMessageId || fields.externalId || fields.maxMessageId
  if (providerMessageId) return `max:${providerMessageId}`
  if (fields.chatId) return `max-chat:${fields.chatId}`
  return `max-runtime:${process.pid}`
}

function sanitizeTraceText(value) {
  if (value == null) return null
  const raw = String(value).replace(/[\u0000-\u001F\u007F]/g, '').trim()
  if (!raw) return ''
  return raw.length > 80 ? `${raw.slice(0, 80)}...[${raw.length}]` : raw
}

function sanitizeTraceValue(key, value, depth = 0, seen = new WeakSet()) {
  if (depth > 4) return '[truncated]'
  if (value == null) return value
  const name = String(key || '')
  if (/phone|token|cookie|secret|authorization|password|base64/i.test(name)) return '[redacted]'
  if (/url/i.test(name)) return '[redacted]'
  if (Buffer.isBuffer(value)) return `[buffer:${value.length}]`
  if (typeof value === 'string') {
    if (/^data:.*;base64,/i.test(value)) return '[redacted]'
    if (/^[A-Za-z0-9+/=_-]{160,}$/.test(value)) return '[redacted]'
    if (name === 'text' || name === 'textPreview') return sanitizeTraceText(value)
    return value.length > 160 ? `${value.slice(0, 160)}...[${value.length}]` : value
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) return value.slice(0, 25).map(item => sanitizeTraceValue(name, item, depth + 1, seen))
  if (typeof value === 'object') {
    if (seen.has(value)) return '[circular]'
    seen.add(value)
    const out = {}
    for (const [childKey, childValue] of Object.entries(value)) {
      out[childKey] = sanitizeTraceValue(childKey, childValue, depth + 1, seen)
    }
    return out
  }
  return String(value)
}

function sanitizeTraceFields(fields = {}) {
  const out = {}
  for (const [key, value] of Object.entries(fields || {})) {
    if (key === 'text') {
      out.textPreview = sanitizeTraceText(value)
      out.textLength = value == null ? 0 : String(value).length
      out.textHash = shortHash(value)
    } else {
      out[key] = sanitizeTraceValue(key, value)
    }
  }
  return out
}

function maxRuntimeTrace(stage, fields = {}) {
  try {
    const safeFields = sanitizeTraceFields(fields)
    const entry = {
      ts: new Date().toISOString(),
      eventId: `${process.pid}:${++eventSeq}`,
      traceId: safeFields.traceId || traceIdFor(safeFields),
      stage,
      ...safeFields,
    }
    process.stdout.write(`${MAX_RUNTIME_TRACE_PREFIX} ${JSON.stringify(entry)}\n`)
  } catch {
    // Instrumentation must never affect runtime behavior.
  }
}

module.exports = {
  MAX_RUNTIME_TRACE_PREFIX,
  maxRuntimeTrace,
  sanitizeTraceFields,
  sanitizeTraceText,
  traceIdFor,
}
