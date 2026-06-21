'use strict'

const fs     = require('fs')
const path   = require('path')
const crypto = require('crypto')
const https  = require('https')
const http   = require('http')

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

    // PR-Ч: retry 3 раза с backoff. MAX даёт signed URL который может
    // протухнуть за секунды; первая попытка фейлится, но через WebSocket
    // прилетает refreshed URL — даём шанс ему попасть в очередь.
    const MAX_RETRIES = 3
    let lastError = null
    let result = null
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        await new Promise(r => setTimeout(r, 500 * attempt))
      }
      result = await this._page.evaluate(async ({ url }) => {
        try {
          const resp = await fetch(url, { credentials: 'include' })
          if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}`, status: resp.status }

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

      if (result.ok) break
      lastError = result.error
      // 4xx (кроме 408 timeout / 429 rate-limit) — не имеет смысла retry
      if (result.status && result.status >= 400 && result.status < 500 &&
          result.status !== 408 && result.status !== 429) {
        break
      }
    }

    if (!result || !result.ok) {
      // Browser fetch failed (likely CORS on CDN domain). Try Node.js download —
      // signed CDN URLs are valid without browser cookies; CORS doesn't apply in Node.
      console.log(`[MediaPipeline] Browser fetch failed (${lastError}), trying Node.js fallback for ${url.split('?')[0]}`)
      try {
        result = await this._downloadViaNodejs(url)
      } catch (nodeErr) {
        throw new Error(`Download failed: browser="${lastError}", nodejs="${nodeErr.message}"`)
      }
    }
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

  // ─── Node.js fallback download (no CORS restrictions) ───────────────────

  _downloadViaNodejs(url, redirectDepth = 0) {
    if (redirectDepth > 5) return Promise.reject(new Error('Too many redirects'))
    const mod = url.startsWith('https:') ? https : http
    const urlObj = new URL(url)
    return new Promise((resolve, reject) => {
      const req = mod.get({
        hostname: urlObj.hostname,
        path:     urlObj.pathname + urlObj.search,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120',
          'Accept':     '*/*',
        },
        timeout: 30000,
      }, res => {
        if ((res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) && res.headers.location) {
          res.resume()
          return this._downloadViaNodejs(res.headers.location, redirectDepth + 1).then(resolve).catch(reject)
        }
        if (res.statusCode !== 200) {
          res.resume()
          return reject(new Error(`HTTP ${res.statusCode}`))
        }
        const chunks = []
        res.on('data', c => chunks.push(c))
        res.on('end', () => {
          const buffer  = Buffer.concat(chunks)
          const mime    = (res.headers['content-type'] || '').split(';')[0].trim() || 'application/octet-stream'
          console.log(`[MediaPipeline] Node.js download OK: ${buffer.length} bytes, mime=${mime}`)
          resolve({ ok: true, base64: buffer.toString('base64'), mimeType: mime, size: buffer.length })
        })
        res.on('error', reject)
      })
      req.on('error', reject)
      req.on('timeout', () => { req.destroy(); reject(new Error('Node.js download timeout')) })
    })
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
