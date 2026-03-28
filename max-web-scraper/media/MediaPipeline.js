'use strict'

const fs     = require('fs')
const path   = require('path')
const crypto = require('crypto')

const { ENDPOINTS } = require('../transport/TransportInterceptor')

const MEDIA_DIR      = path.join(__dirname, '..', 'media_storage')
const MAX_FILE_SIZE  = 20 * 1024 * 1024  // 20 MB

const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif',
  'application/pdf',
  'video/mp4', 'video/quicktime',
  'audio/ogg', 'audio/mpeg', 'audio/mp4',
  'application/zip', 'application/x-zip-compressed',
])

const MIME_TO_EXT = {
  'image/jpeg':       '.jpg',
  'image/png':        '.png',
  'image/webp':       '.webp',
  'image/gif':        '.gif',
  'application/pdf':  '.pdf',
  'video/mp4':        '.mp4',
  'audio/ogg':        '.ogg',
  'audio/mpeg':       '.mp3',
}

class MediaPipeline {
  constructor(page) {
    this._page = page
    fs.mkdirSync(MEDIA_DIR, { recursive: true })
  }

  // ─── Входящие: скачать вложение ──────────────────────────────────────────

  async downloadAttachment(url, mimeType) {
    if (!url) throw new Error('URL вложения не указан')

    // Скачиваем через браузерный контекст — используем сессионные куки
    const result = await this._page.evaluate(async ({ url }) => {
      try {
        const resp = await fetch(url, { credentials: 'include' })
        if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}` }

        const buffer = await resp.arrayBuffer()
        const bytes  = new Uint8Array(buffer)

        // Конвертируем в base64 для передачи из браузера в Node.js
        let binary = ''
        const chunk = 8192
        for (let i = 0; i < bytes.length; i += chunk) {
          binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
        }

        return {
          ok:       true,
          base64:   btoa(binary),
          mimeType: resp.headers.get('content-type') || null,
          size:     buffer.byteLength
        }
      } catch (e) {
        return { ok: false, error: e.message }
      }
    }, { url })

    if (!result.ok) throw new Error(`Download failed: ${result.error}`)
    if (result.size > MAX_FILE_SIZE) {
      throw new Error(`Файл слишком большой: ${result.size} байт (лимит ${MAX_FILE_SIZE})`)
    }

    const resolvedMime = result.mimeType || mimeType || 'application/octet-stream'
    const ext      = MIME_TO_EXT[resolvedMime] || ''
    const hash     = crypto.createHash('md5')
      .update(result.base64.slice(0, 200))
      .digest('hex')
      .slice(0, 8)
    const filename = `${Date.now()}_${hash}${ext}`
    const filepath = path.join(MEDIA_DIR, filename)

    fs.writeFileSync(filepath, Buffer.from(result.base64, 'base64'))

    // TODO Фаза 2: заменить localPath на object storage URL
    return {
      localPath: filepath,
      filename,
      mimeType:  resolvedMime,
      size:      result.size
    }
  }

  // ─── Исходящие: загрузить файл ───────────────────────────────────────────

  async uploadFile(fileBuffer, filename, mimeType) {
    if (!ENDPOINTS.uploadFile) {
      throw new Error('Upload endpoint не определён — заполните FINDINGS.md после Фазы 0')
    }

    if (!ALLOWED_MIME_TYPES.has(mimeType)) {
      throw new Error(`Недопустимый тип файла: ${mimeType}`)
    }

    if (fileBuffer.length > MAX_FILE_SIZE) {
      throw new Error(`Файл слишком большой: ${fileBuffer.length} байт`)
    }

    const base64   = fileBuffer.toString('base64')
    const endpoint = ENDPOINTS.uploadFile

    const result = await this._page.evaluate(
      async ({ base64, filename, mimeType, endpoint }) => {
        try {
          // base64 → Blob
          const byteStr = atob(base64)
          const bytes   = new Uint8Array(byteStr.length)
          for (let i = 0; i < byteStr.length; i++) {
            bytes[i] = byteStr.charCodeAt(i)
          }
          const blob = new Blob([bytes], { type: mimeType })

          const form = new FormData()
          form.append('file', blob, filename)
          // Дополнительные поля FormData — из FINDINGS.md
          // form.append('type', 'image')

          const resp = await fetch(endpoint, {
            method:      'POST',
            credentials: 'include',
            body:        form
            // Content-Type НЕ ставим — браузер сам выставит multipart/form-data с boundary
          })

          if (!resp.ok) {
            const text = await resp.text().catch(() => '')
            return { ok: false, error: `HTTP ${resp.status}: ${text.slice(0, 200)}` }
          }

          return { ok: true, data: await resp.json() }
        } catch (e) {
          return { ok: false, error: e.message }
        }
      },
      { base64, filename, mimeType, endpoint }
    )

    if (!result.ok) throw new Error(`Upload failed: ${result.error}`)

    // Возвращаем результат upload — структура из FINDINGS.md
    // Обычно содержит file_id, token или url для последующей отправки
    return result.data
  }

  // ─── Вспомогательные ────────────────────────────────────────────────────

  static isAllowedMime(mimeType) {
    return ALLOWED_MIME_TYPES.has(mimeType)
  }
}

module.exports = { MediaPipeline }
