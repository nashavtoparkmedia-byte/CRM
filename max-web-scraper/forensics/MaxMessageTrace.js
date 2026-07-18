'use strict'

const { TransportInterceptor } = require('../transport/TransportInterceptor')
const { MessageParser } = require('../parser/MessageParser')
const { withForwardingMetadata } = require('../pipeline/MessageEnvelope')

function sanitizeStageValue(value) {
  if (value == null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(sanitizeStageValue)

  const sanitized = {}
  for (const [key, entry] of Object.entries(value)) {
    if (/phone|token|cookie|secret|authorization|password|base64|previewData|url/i.test(key)) {
      sanitized[key] = '[redacted]'
    } else if (key === 'raw') {
      sanitized[key] = '[raw-provider-payload]'
    } else {
      sanitized[key] = sanitizeStageValue(entry)
    }
  }
  return sanitized
}

function traceInboundPayload(rawProviderPayload, options = {}) {
  const transport = new TransportInterceptor()
  if (options.currentUserId) transport._myUserId = String(options.currentUserId)

  const transportEvent = transport._normalizeMaxMsg(rawProviderPayload)
  if (!transportEvent) throw new Error('MAX payload did not normalize to a message')

  const parserOutput = MessageParser.toCrmPayload(transportEvent)
  const webhookPayload = withForwardingMetadata(
    parserOutput,
    transportEvent,
    options.lookupContact,
  )

  return {
    rawProviderPayload: sanitizeStageValue(rawProviderPayload),
    transportEvent: sanitizeStageValue(transportEvent),
    parserOutput: sanitizeStageValue(parserOutput),
    webhookPayload: sanitizeStageValue(webhookPayload),
    unsafeTextSignals: {
      replacementCharacter: String(webhookPayload.text || '').includes('\uFFFD'),
      serializedAttachments: /attachments\s*[:=]/i.test(String(webhookPayload.text || '')),
      serializedPrevMessage: /\bprevM\s*[:=]/i.test(String(webhookPayload.text || '')),
    },
  }
}

module.exports = {
  sanitizeStageValue,
  traceInboundPayload,
}
