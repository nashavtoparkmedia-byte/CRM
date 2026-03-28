'use strict'

// ─── Константы из FINDINGS.md ────────────────────────────────────────────────
// ЗАПОЛНИТЬ после Фазы 0 discovery
// Все значения null — сервис запустится, но отправка будет выдавать ошибку

const ENDPOINTS = {
  sendText:    null,  // 'POST /api/v1/...'
  uploadFile:  null,  // 'POST /api/v1/...'
  sendMedia:   null,  // 'POST /api/v1/...'
  getHistory:  null,  // 'GET /api/v1/...'
  getChats:    null,  // 'GET /api/v1/...'
}

// Тип WS-события для входящего сообщения (из FINDINGS.md)
// Примеры: 'new_message', 'msg', 'update', 4 (число для VK-style updates)
const WS_INCOMING_TYPE = null

// Поле в event payload, содержащее тип события
// Пример: 'type', 'event', 'action'
const WS_TYPE_FIELD = 'type'

// ─────────────────────────────────────────────────────────────────────────────

class TransportInterceptor {
  constructor() {
    this._messageHandlers = []
    this._page            = null
    this._context         = null
    this._cdpClient       = null
    this._wsRequestIds    = new Set()
  }

  // ─── Подключение перехватчика ────────────────────────────────────────────

  async attach(page, context) {
    this._page    = page
    this._context = context

    // Метод 1: CDP — основной, работает независимо от момента подключения listener
    this._cdpClient = await context.newCDPSession(page)
    await this._cdpClient.send('Network.enable')

    this._cdpClient.on('Network.webSocketCreated', ({ requestId, url }) => {
      this._wsRequestIds.add(requestId)
      console.log('[Transport] WS создан:', url)
    })

    this._cdpClient.on('Network.webSocketFrameReceived', ({ requestId, response }) => {
      if (!response.payloadData) return
      // opcode 2 = binary frame
      if (response.opcode === 2) return
      this._handleFrame(response.payloadData)
    })

    this._cdpClient.on('Network.webSocketClosed', ({ requestId }) => {
      this._wsRequestIds.delete(requestId)
      console.log('[Transport] WS закрыт')
    })

    // Метод 2: SSE (если discovery показал SSE вместо WS)
    this._cdpClient.on('Network.eventSourceMessageReceived', (e) => {
      this._handleSseEvent(e)
    })

    // Метод 3: page.on('websocket') — дополнительно для новых соединений
    page.on('websocket', (ws) => {
      console.log('[Transport] WS (page):', ws.url())

      ws.on('framereceived', ({ payload }) => {
        if (Buffer.isBuffer(payload)) return  // binary — пропускаем
        this._handleFrame(String(payload))
      })

      ws.on('close', () => {
        console.log('[Transport] WS (page) закрыт')
      })
    })

    console.log('[Transport] Перехват активен (CDP + page.on websocket)')
  }

  // ─── Обработка WS фрейма ────────────────────────────────────────────────

  _handleFrame(raw) {
    let data
    try {
      data = JSON.parse(raw)
    } catch {
      return  // не JSON — пропускаем
    }

    // ── Вариант А: { type: 'new_message', data: {...} }
    if (WS_INCOMING_TYPE && data[WS_TYPE_FIELD] === WS_INCOMING_TYPE) {
      const msg = this._normalize(data.data || data)
      if (msg) this._emit(msg)
      return
    }

    // ── Вариант Б: VK-style updates: { updates: [[type, ...fields]] }
    if (Array.isArray(data.updates)) {
      for (const update of data.updates) {
        const msg = this._parseVkStyleUpdate(update)
        if (msg) this._emit(msg)
      }
      return
    }

    // ── Вариант В: { event: 'message.received', payload: {...} }
    if (data.event && data.payload) {
      const msg = this._normalize(data.payload)
      if (msg) this._emit(msg)
      return
    }

    // ── Вариант Г: массив событий [{ type, ... }, ...]
    if (Array.isArray(data)) {
      for (const item of data) {
        if (WS_INCOMING_TYPE && item[WS_TYPE_FIELD] === WS_INCOMING_TYPE) {
          const msg = this._normalize(item.data || item)
          if (msg) this._emit(msg)
        }
      }
    }

    // Если ни один вариант не подошёл — данные из discovery покажут правильный
  }

  // ─── Обработка SSE события ──────────────────────────────────────────────

  _handleSseEvent(e) {
    // Заполнить после discovery если транспорт SSE, а не WS
    // console.log('[Transport] SSE:', e.eventName, e.data)
  }

  // ─── Нормализация сообщения ─────────────────────────────────────────────

  _normalize(raw) {
    if (!raw) return null

    // Маппинг полей — точные имена из FINDINGS.md
    // Заглушки охватывают наиболее распространённые варианты
    const id        = raw.id         || raw.message_id  || raw.msgId   || null
    const from      = raw.from       || raw.sender      || raw.user_id ||
                      raw.peer_id    || raw.contact      || null
    const text      = raw.text       || raw.body        || raw.message || raw.content || ''
    const timestamp = raw.ts         || raw.timestamp   || raw.date    ||
                      raw.created_at || Date.now()
    const isOutgoing = (
      raw.out === 1       || raw.out === true   ||
      raw.is_out === 1    || raw.is_out === true ||
      raw.fromMe === true || raw.outgoing === true
    )

    return {
      id,
      from,
      text,
      // Нормализуем timestamp: unix seconds → ms
      timestamp: (typeof timestamp === 'number' && timestamp < 1e12)
        ? timestamp * 1000
        : Number(timestamp),
      type:        this._detectType(raw),
      attachments: this._extractAttachments(raw),
      isOutgoing,
      raw          // сохраняем оригинал для отладки
    }
  }

  // ─── Парсинг VK-style update массива ────────────────────────────────────

  _parseVkStyleUpdate(update) {
    // Структура VK updates зависит от версии — заполнить после discovery
    // Пример: update[0] = тип события, остальные поля — данные
    // if (update[0] === 4) { ... }
    return null
  }

  // ─── Определение типа сообщения ─────────────────────────────────────────

  _detectType(raw) {
    const atts = raw.attachments || raw.attach || raw.files || []
    if (!atts.length) return 'text'

    const first = atts[0]
    const t = (first.type || first.attach_type || first.kind || '').toLowerCase()

    if (['photo', 'image', 'img'].includes(t))           return 'image'
    if (['doc', 'file', 'document'].includes(t))         return 'document'
    if (['sticker'].includes(t))                         return 'sticker'
    if (['audio_message', 'voice', 'voicemsg'].includes(t)) return 'voice'
    if (['video'].includes(t))                           return 'video'
    return 'text'
  }

  // ─── Извлечение вложений ────────────────────────────────────────────────

  _extractAttachments(raw) {
    const atts = raw.attachments || raw.attach || raw.files || []
    if (!atts.length) return []

    return atts.map(a => ({
      type:       a.type       || a.attach_type || a.kind || 'file',
      // Пробуем разные варианты URL из разных API
      url:        a.url        || a.download_url ||
                  a.photo?.orig_photo?.url || a.photo?.sizes?.slice(-1)[0]?.url ||
                  a.doc?.url   || a.file?.url   || null,
      previewUrl: a.preview    || a.thumbnail   ||
                  a.photo?.sizes?.[0]?.url      || null,
      name:       a.name       || a.title       || a.filename || null,
      size:       a.size       || a.file_size   || null,
      mimeType:   a.mime_type  || a.content_type || null,
    }))
  }

  // ─── Публичный API ──────────────────────────────────────────────────────

  onMessage(handler) {
    this._messageHandlers.push(handler)
  }

  detach() {
    this._messageHandlers = []
    if (this._cdpClient) {
      this._cdpClient.detach().catch(() => {})
      this._cdpClient = null
    }
    console.log('[Transport] Перехват отключён')
  }

  // ─── Внутренние ─────────────────────────────────────────────────────────

  _emit(msg) {
    for (const handler of this._messageHandlers) {
      try { handler(msg) } catch (e) {
        console.error('[Transport] Handler error:', e.message)
      }
    }
  }
}

module.exports = { TransportInterceptor, ENDPOINTS }
