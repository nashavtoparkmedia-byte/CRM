'use strict'

class MessageParser {
  /**
   * Нормализует сырое сообщение из TransportInterceptor в формат для CRM webhook
   */
  /**
   * @param {object} msg - нормализованное сообщение
   * @param {number|null} [chatId] - явный chatId (опционально, перекрывает msg.chatId)
   */
  static toCrmPayload(msg, chatId) {
    return {
      externalId:  msg.id || null,
      chatId:      chatId || msg.chatId || null,  // chatId для ответа из CRM
      senderId:    msg.from || null,              // userId отправителя в MAX
      phone:       MessageParser.normalizePhone(msg.from),
      text:        msg.text || '',
      timestamp:   MessageParser.normalizeTimestamp(msg.timestamp),
      messageType: msg.type || 'text',
      attachments: msg.attachments || [],
      isOutgoing:  msg.isOutgoing || false,
    }
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
    if (digits.length > 11)                               return digits.slice(-11)

    // Если это не телефон (может быть внутренний user_id MAX)
    // возвращаем как есть — будет использоваться как идентификатор
    return digits || String(raw)
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
    const t = (attaches[0]._type || '').toUpperCase()
    if (t === 'PHOTO')                     return 'image'
    if (t === 'VIDEO')                     return 'video'
    if (t === 'AUDIO' || t === 'VOICE')    return 'voice'
    // STICKER covers both static and animated (smileType=4) MAX stickers.
    // Without this branch they leaked into the default 'document' bucket
    // and rendered as empty "Документ" chips.
    if (t === 'STICKER' || t === 'SMILE')  return 'sticker'
    return 'document'
  }

  static _extractMaxAttachments(attaches) {
    return attaches.map(a => ({
      type:        (a._type || 'file').toLowerCase(),
      url:         a.baseUrl || a.url || null,
      name:        a.filename || null,
      size:        a.size || null,
      previewData: a.previewData || null,
      photoId:     a.photoId || null,
    }))
  }

  static isIncoming(msg) {
    return !msg.isOutgoing
  }
}

module.exports = { MessageParser }
