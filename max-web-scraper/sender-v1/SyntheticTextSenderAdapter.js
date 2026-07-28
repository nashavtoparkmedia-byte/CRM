'use strict'

const ALLOWED_MODES = new Set(['accepted', 'confirmed', 'failed', 'unknown', 'timeout_before', 'timeout_after', 'unsupported'])

class SyntheticTextSenderAdapter {
  constructor(defaultMode = 'confirmed') {
    if (!ALLOWED_MODES.has(defaultMode)) throw new Error('Synthetic mode is invalid')
    this.defaultMode = defaultMode
    this.modes = new Map()
    this.calls = []
    this.physicalProviderCalls = 0
  }

  setMode(attemptId, mode) {
    if (!ALLOWED_MODES.has(mode)) throw new Error('Synthetic mode is invalid')
    this.modes.set(attemptId, mode)
  }

  async invoke(request) {
    const mode = this.modes.get(request.attemptId) || this.defaultMode
    this.calls.push(Object.freeze({ accountId: request.accountId, conversationKey: request.conversationKey, commandId: request.commandId, attemptId: request.attemptId, idempotencyKey: request.idempotencyKey, mode }))
    if (mode === 'confirmed') return Object.freeze({ outcome: 'PROVIDER_CONFIRMED', safeCode: 'SYNTHETIC_CONFIRMED' })
    if (mode === 'accepted') return Object.freeze({ outcome: 'ACCEPTED_BY_SENDER_BOUNDARY', safeCode: 'SYNTHETIC_ACCEPTED' })
    if (mode === 'failed') return Object.freeze({ outcome: 'FAILED_BEFORE_PROVIDER', safeCode: 'SYNTHETIC_PRE_PROVIDER_FAILURE' })
    if (mode === 'unknown') return Object.freeze({ outcome: 'UNKNOWN_AFTER_ATTEMPT', safeCode: 'SYNTHETIC_UNKNOWN' })
    if (mode === 'timeout_before') return Object.freeze({ outcome: 'FAILED_BEFORE_PROVIDER', safeCode: 'SYNTHETIC_TIMEOUT_BEFORE_PROVIDER' })
    if (mode === 'timeout_after') return Object.freeze({ outcome: 'UNKNOWN_AFTER_ATTEMPT', safeCode: 'SYNTHETIC_TIMEOUT_AFTER_BOUNDARY' })
    return Object.freeze({ outcome: 'UNSUPPORTED', safeCode: 'SYNTHETIC_UNSUPPORTED' })
  }
}

module.exports = { SyntheticTextSenderAdapter }
