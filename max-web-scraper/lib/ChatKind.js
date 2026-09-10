'use strict'

const PRIVATE_CHAT_TYPES = new Set(['DIALOG'])
const GROUP_CHAT_TYPES = new Set(['CHAT', 'GROUP', 'GROUP_CHAT', 'CHANNEL'])

/**
 * Derive chat kind only from explicit MAX provider chat-model `type` values.
 * Conflicting signals fail closed with deterministic group > unknown > private
 * precedence; names, participant counts and message content are never used.
 */
function deriveMaxChatKind(...chatModels) {
  let sawPrivate = false
  let sawUnknownType = false

  for (const model of chatModels) {
    if (!model || typeof model !== 'object' || model.type == null) continue
    const type = String(model.type).trim().toUpperCase()
    if (!type) continue
    if (GROUP_CHAT_TYPES.has(type)) return 'group'
    if (PRIVATE_CHAT_TYPES.has(type)) {
      sawPrivate = true
    } else {
      sawUnknownType = true
    }
  }

  if (sawUnknownType) return 'unknown'
  return sawPrivate ? 'private' : 'unknown'
}

module.exports = { deriveMaxChatKind }
