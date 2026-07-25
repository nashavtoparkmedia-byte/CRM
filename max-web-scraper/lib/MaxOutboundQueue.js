'use strict'

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const ACTIVE = new Set(['queued', 'sending'])
const TERMINAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

function copy(item) {
  return item ? JSON.parse(JSON.stringify(item)) : null
}

function queueKey(command) {
  const stable = command.crmMessageId || command.clientMessageId
  if (stable) return `crm:${stable}`
  const digest = crypto.createHash('sha256')
    .update(JSON.stringify([
      command.chatId,
      command.message,
      command.quotedMsgId || null,
    ]))
    .digest('hex')
    .slice(0, 24)
  return `fallback:${digest}`
}

function normalizedText(value) {
  return String(value || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\r\n/g, '\n')
    .trim()
}

class MaxOutboundQueue {
  constructor(options) {
    if (!options?.filePath) throw new Error('filePath is required')
    if (typeof options.execute !== 'function') throw new Error('execute is required')
    this.filePath = options.filePath
    this.execute = options.execute
    this.report = options.report || (async () => {})
    this.now = options.now || (() => Date.now())
    this.logger = options.logger || console
    this.items = []
    this.running = false
    this.draining = false
    this.sequence = 0
    this.reportTimer = null
    this._load()
  }

  _load() {
    let parsed = null
    try { parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) } catch {}
    this.items = Array.isArray(parsed?.items) ? parsed.items : []
    this.sequence = this.items.reduce((max, item) => Math.max(max, Number(item.sequence) || 0), 0)
    let changed = false
    for (const item of this.items) {
      if (item.status === 'sending') {
        item.status = 'queued'
        item.recoveredAfterRestart = true
        item.updatedAt = new Date(this.now()).toISOString()
        changed = true
      }
    }
    if (changed) this._persist()
  }

  _persist() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
    const temp = `${this.filePath}.tmp`
    fs.writeFileSync(temp, JSON.stringify({ version: 1, items: this.items }, null, 2))
    fs.renameSync(temp, this.filePath)
  }

  _prune() {
    const cutoff = this.now() - TERMINAL_RETENTION_MS
    const terminal = this.items
      .filter(item => !ACTIVE.has(item.status))
      .sort((a, b) => (b.sequence || 0) - (a.sequence || 0))
    const keepTerminal = new Set(terminal.slice(0, 2000).map(item => item.queueId))
    this.items = this.items.filter(item => {
      if (ACTIVE.has(item.status) || item.reportPending) return true
      const updatedAt = Date.parse(item.updatedAt || item.createdAt || '')
      return keepTerminal.has(item.queueId) && (!Number.isFinite(updatedAt) || updatedAt >= cutoff)
    })
  }

  start() {
    if (this.running) return
    this.running = true
    this.reportTimer = setInterval(() => this.flushReports().catch(() => {}), 5000)
    this.reportTimer.unref?.()
    this.flushReports().catch(() => {})
    this.kick()
  }

  stop() {
    this.running = false
    if (this.reportTimer) clearInterval(this.reportTimer)
    this.reportTimer = null
  }

  pendingCount() {
    return this.items.filter(item => ACTIVE.has(item.status)).length
  }

  list() {
    return this.items.map(copy)
  }

  get(commandOrKey) {
    const key = typeof commandOrKey === 'string' ? commandOrKey : queueKey(commandOrKey)
    return copy(this.items.find(item => item.key === key))
  }

  enqueue(command) {
    const key = queueKey(command)
    let item = this.items.find(entry => entry.key === key)
    const now = new Date(this.now()).toISOString()

    if (item) {
      if (item.status === 'failed' && item.retryable !== false) {
        item.status = 'queued'
        item.error = null
        item.errorCode = null
        item.updatedAt = now
        item.reportPending = true
      }
      this._persist()
      this.kick()
      return copy(item)
    }

    item = {
      queueId: `maxq_${crypto.randomUUID()}`,
      key,
      sequence: ++this.sequence,
      status: 'queued',
      attempt: 0,
      retryable: true,
      reportPending: true,
      createdAt: now,
      updatedAt: now,
      crmMessageId: command.crmMessageId || null,
      clientMessageId: command.clientMessageId || null,
      chatId: String(command.chatId),
      uiChatId: command.uiChatId ? String(command.uiChatId) : null,
      message: String(command.message),
      quotedMsgId: command.quotedMsgId ? String(command.quotedMsgId) : null,
      quotedText: command.quotedText || null,
      quotedSentAt: command.quotedSentAt || null,
      quotedDirection: command.quotedDirection || null,
      externalId: null,
      source: 'persistent_fifo',
    }
    this.items.push(item)
    this._prune()
    this._persist()
    this.kick()
    return copy(item)
  }

  kick() {
    if (!this.running || this.draining) return
    setImmediate(() => this._drain().catch(error => {
      this.logger.error?.('[MaxOutboundQueue] drain failed:', error.message)
    }))
  }

  async _setStatus(item, status, fields = {}) {
    Object.assign(item, fields, {
      status,
      updatedAt: new Date(this.now()).toISOString(),
      reportPending: true,
    })
    this._persist()
    await this._report(item)
  }

  async _report(item) {
    try {
      await this.report(copy(item))
      item.reportPending = false
      item.reportedAt = new Date(this.now()).toISOString()
      this._persist()
    } catch (error) {
      item.reportPending = true
      item.reportError = String(error?.message || error)
      this._persist()
    }
  }

  async flushReports() {
    for (const item of this.items.filter(entry => entry.reportPending)) {
      await this._report(item)
    }
  }

  async _drain() {
    if (!this.running || this.draining) return
    this.draining = true
    try {
      while (this.running) {
        const item = this.items
          .filter(entry => entry.status === 'queued')
          .sort((a, b) => a.sequence - b.sequence)[0]
        if (!item) break

        item.attempt = Number(item.attempt || 0) + 1
        await this._setStatus(item, 'sending', { startedAt: new Date(this.now()).toISOString() })

        try {
          const result = await this.execute(copy(item))
          if (item.status === 'delivered') continue
          const externalId = result?.externalId || result?.maxMessageId || null
          if (!result?.deliveryConfirmed || !externalId) {
            const error = new Error('MAX provider confirmation timeout')
            error.code = 'MAX_CONFIRMATION_TIMEOUT'
            error.retryable = true
            throw error
          }
          await this._setStatus(item, 'delivered', {
            externalId: String(externalId),
            deliveryConfirmed: true,
            retryable: false,
            error: null,
            errorCode: null,
            source: result.source || 'provider_ack',
          })
        } catch (error) {
          if (item.status === 'delivered') continue
          await this._setStatus(item, 'failed', {
            deliveryConfirmed: false,
            retryable: error?.retryable !== false,
            error: String(error?.message || error),
            errorCode: error?.code || 'MAX_SEND_FAILED',
            source: 'queue_worker',
          })
        }
      }
    } finally {
      this.draining = false
      if (this.running && this.items.some(item => item.status === 'queued')) this.kick()
    }
  }

  async confirmEcho(echo) {
    const externalId = echo?.externalId ? String(echo.externalId) : null
    if (!externalId) return null

    const existing = this.items.find(item => item.externalId === externalId)
    if (existing) return copy(existing)

    const chatId = String(echo.chatId || '')
    const text = normalizedText(echo.message)
    const replyToExternalId = echo.replyToExternalId ? String(echo.replyToExternalId) : null
    const candidates = this.items
      .filter(item => ['queued', 'sending', 'failed'].includes(item.status))
      .filter(item => [item.chatId, item.uiChatId].filter(Boolean).includes(chatId))
      .filter(item => normalizedText(item.message) === text)
      .filter(item => !replyToExternalId || !item.quotedMsgId || item.quotedMsgId === replyToExternalId)
      .sort((a, b) => a.sequence - b.sequence)

    const item = candidates[0]
    if (!item) return null
    await this._setStatus(item, 'delivered', {
      externalId,
      deliveryConfirmed: true,
      retryable: false,
      error: null,
      errorCode: null,
      source: echo.source || 'provider_echo',
    })
    return copy(item)
  }

  async waitForIdle(timeoutMs = 2000) {
    const started = this.now()
    while (this.draining || this.pendingCount() > 0) {
      if (this.now() - started >= timeoutMs) throw new Error('queue did not become idle')
      await new Promise(resolve => setTimeout(resolve, 5))
    }
  }
}

module.exports = { MaxOutboundQueue, queueKey }
