'use strict'

const { maxRuntimeTrace } = require('../lib/runtimeTrace')

class MessageParser {
  /**
   * Нормализует сырое сообщение из TransportInterceptor в формат для CRM webhook
   */
  /**
   * @param {object} msg - нормализованное сообщение
   * @param {number|null} [chatId] - явный chatId (опционально, перекрывает msg.chatId)
   */
  static toCrmPayload(msg, chatId) {
    const payload = {
      externalId:        msg.id || null,
      chatId:            chatId || msg.chatId || null,
      senderId:          msg.from || null,
      phone:             MessageParser.normalizePhone(msg.phone || msg.senderPhone),
      text:              msg.text || '',
      timestamp:         MessageParser.normalizeTimestamp(msg.timestamp),
      messageType:       msg.type || 'text',
      attachments:       msg.attachments || [],
      isOutgoing:        msg.isOutgoing || false,
      replyToExternalId: msg.replyToMessageId || null,
      ...(msg.source ? { source: msg.source } : {}),
      ...(msg.textQuarantineReason ? { textQuarantineReason: msg.textQuarantineReason } : {}),
    }
    maxRuntimeTrace('parser.to_crm_payload', {
      providerMessageId: payload.externalId,
      chatId: payload.chatId,
      text: payload.text,
      messageType: payload.messageType,
      isOutgoing: payload.isOutgoing,
      attachmentCount: Array.isArray(payload.attachments) ? payload.attachments.length : 0,
    })
    return payload
  }

  /**
   * Нормализует телефонный номер в формат 7XXXXXXXXXX
   */
  static normalizePhone(raw) {
    if (!raw) return null

    const digits = String(raw).replace(/\D/g, '')

    if (digits.length === 10)                              return '7' + digits
    if (digits.length === 11 && digits.startsWith('8'))   return '7' + digits.slice(1)
    if (digits.length === 11 && digits.startsWith('7'))   return digits
    if (digits.length > 11 && digits.startsWith('7'))     return digits.slice(-11)

    // Если это не телефон (может быть внутренний user_id MAX)
    // не подставляем его в phone, чтобы CRM не склеивала чат по ложному номеру.
    return null
  }

  /**
   * Нормализует timestamp в ISO строку
   * Принимает: unix ms, unix seconds, Date, ISO строку
   */
  static normalizeTimestamp(raw) {
    if (!raw) return new Date().toISOString()

    let ms
    if (typeof raw === 'number') {
      // unix seconds → ms
      ms = raw < 1e12 ? raw * 1000 : raw
    } else if (raw instanceof Date) {
      ms = raw.getTime()
    } else {
      ms = new Date(raw).getTime()
    }

    return isNaN(ms) ? new Date().toISOString() : new Date(ms).toISOString()
  }

  /**
   * Нормализует сырое сообщение из history endpoint в тот же формат
   * что и из TransportInterceptor._normalize()
   */
  static normalizeHistoryMessage(raw) {
    const attaches = raw.attaches || raw.attachments || []
    const hasAttaches = attaches.length > 0
    return {
      id:          raw.id         || raw.message_id  || raw.msgId     || null,
      from:        raw.from       || raw.sender      || raw.user_id   ||
                   raw.peer_id   || raw.contact      || null,
      text:        raw.text       || raw.body        || raw.message   || raw.content || '',
      timestamp:   raw.time       || raw.ts          || raw.timestamp || raw.date    ||
                   raw.created_at || Date.now(),
      type:        hasAttaches ? MessageParser._detectMaxType(attaches) : 'text',
      attachments: MessageParser._extractMaxAttachments(attaches),
      isOutgoing:  (
        raw.out === 1       || raw.out === true   ||
        raw.is_out === 1    || raw.is_out === true ||
        raw.fromMe === true || raw.outgoing === true
      )
    }
  }

  static _detectMaxType(attaches) {
    if (!attaches || !attaches.length) return 'text'
    const first = attaches[0] || {}
    const t = (first._type || first.preview?._type || first.type || '').toUpperCase()
    const name = String(first.name || first.filename || '').replace(/\u0000/g, '').replace(/\uFFFD/g, '')
    const mime = String(first.mimeType || first.type || '')
    if (t === 'PHOTO')                     return 'image'
    if (t === 'VIDEO' || first.videoId || first.thumbnail || /\.mp4\b/i.test(name) || /^video\//i.test(mime)) return 'video'
    if (t === 'MUSIC')                     return 'audio'
    if (t === 'AUDIO' || t === 'VOICE')    return 'voice'
    if (/\.ogg\b/i.test(name) || /^audio\//i.test(mime)) return 'audio'
    // STICKER covers both static and animated (smileType=4) MAX stickers.
    // Without this branch they leaked into the default 'document' bucket
    // and rendered as empty "Документ" chips.
    if (t === 'STICKER' || t === 'SMILE')  return 'sticker'
    return 'document'
  }

  static _extractMaxAttachments(attaches) {
    return attaches.map(a => {
      const rawType = String(a._type || a.preview?._type || a.type || '').toUpperCase()
      const name = String(a.name || a.filename || '').replace(/\u0000/g, '').replace(/\uFFFD/g, '').trim() || null
      let type = (a._type || 'file').toLowerCase()
      if (rawType === 'MUSIC') type = 'audio'
      if (rawType === 'VIDEO' || a.videoId || a.thumbnail || /\.mp4\b/i.test(name || '')) type = 'video'
      if (/\.ogg\b/i.test(name || '') && type === 'file') type = 'audio'
      const mimeType = a.mimeType || (type === 'audio' ? 'audio/ogg' : type === 'video' ? 'video/mp4' : a.type || null)
      return {
        type,
        url:         a.baseUrl || a.url || null,
        name,
        size:        a.size || null,
        mimeType,
        previewData: a.previewData || null,
        thumbnail:   a.thumbnail || null,
        duration:    a.duration || a.preview?.duration || null,
        photoId:     a.photoId || null,
        videoId:     a.videoId || null,
        fileId:      a.fileId || a.token || null,
        token:       a.token || null,
      }
    })
  }

  static isIncoming(msg) {
    return !msg.isOutgoing
  }
}

module.exports = { MessageParser }
