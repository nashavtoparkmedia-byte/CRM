'use strict'

function buildMaxTextMessage(text, replyToMessageId, cid = -Date.now()) {
  const message = {
    text: String(text ?? ''),
    cid,
    elements: [],
    attaches: [],
  }

  if (replyToMessageId) {
    message.link = { type: 'REPLY', messageId: String(replyToMessageId) }
  }

  return message
}

function withForwardingMetadata(payload, message, lookupContact = () => null) {
  if (!message?.forwardedFromId) return payload

  const providerIdentity = String(message.forwardedFromId)
  const contact = lookupContact(providerIdentity) || {}

  return {
    ...payload,
    // Forwarding is structured metadata. It must never be prepended to text.
    forwardedFrom: {
      id: providerIdentity,
      name: contact.name || providerIdentity,
      phone: contact.phone || null,
    },
  }
}

module.exports = {
  buildMaxTextMessage,
  withForwardingMetadata,
}
