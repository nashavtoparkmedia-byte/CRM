'use strict'

const http = require('http')
const https = require('https')

const DEFAULT_TIMEOUT_MS = 15_000

function positiveTimeout(value) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 1_000 && parsed <= 60_000
    ? parsed
    : DEFAULT_TIMEOUT_MS
}

function postJson(urlValue, payload, options = {}) {
  const url = new URL(String(urlValue))
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('CRM webhook protocol is not supported')
  }
  const body = JSON.stringify(payload)
  const transport = url.protocol === 'https:' ? https : http
  const timeoutMs = positiveTimeout(options.timeoutMs)

  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (operation) => {
      if (settled) return
      settled = true
      operation()
    }
    const request = transport.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, response => {
      let data = ''
      response.on('data', chunk => {
        const remaining = (256 * 1024) - Buffer.byteLength(data)
        if (remaining > 0) data += Buffer.from(chunk).subarray(0, remaining).toString('utf8')
      })
      response.on('end', () => finish(() => {
        let json = null
        try { json = data ? JSON.parse(data) : null } catch {}
        const skipped = json && typeof json === 'object' && json.skipped
          ? String(json.skipped)
          : null
        resolve({ status: response.statusCode, data, json, skipped })
      }))
    })
    request.setTimeout(timeoutMs, () => {
      request.destroy(Object.assign(new Error('CRM webhook timed out'), { code: 'CRM_WEBHOOK_TIMEOUT' }))
    })
    request.on('error', error => finish(() => reject(error)))
    request.write(body)
    request.end()
  })
}

function postJsonAfterSynchronousFence(urlValue, payload, options = {}) {
  if (typeof options.assertCurrent !== 'function') {
    throw Object.assign(new Error('a synchronous current-binding assertion is required'), {
      code: 'CRM_WEBHOOK_FENCE_REQUIRED',
    })
  }
  options.assertCurrent()
  return postJson(urlValue, payload, options)
}

function isDurableMaxWebhookAcknowledgement(result) {
  if (!result || !Number.isInteger(result.status) || result.status < 200 || result.status >= 300) return false
  if (result.skipped) return false
  const body = result.json
  return Boolean(
    body && typeof body === 'object'
    && body.success === true
    && typeof body.messageId === 'string' && body.messageId.length > 0
    && typeof body.chatInternalId === 'string' && body.chatInternalId.length > 0
  )
}

function requireDurableMaxWebhookAcknowledgement(result) {
  if (isDurableMaxWebhookAcknowledgement(result)) {
    return {
      durable: true,
      messageId: result.json.messageId,
      chatInternalId: result.json.chatInternalId,
      deduped: result.json.deduped === true,
    }
  }
  const error = new Error(result?.skipped
    ? `CRM webhook skipped inbound persistence: ${result.skipped}`
    : `CRM webhook did not acknowledge durable inbound persistence (status ${result?.status ?? 'unknown'})`)
  error.code = result?.skipped ? 'CRM_WEBHOOK_SKIPPED' : 'CRM_WEBHOOK_NOT_DURABLE'
  throw error
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  isDurableMaxWebhookAcknowledgement,
  postJson,
  postJsonAfterSynchronousFence,
  requireDurableMaxWebhookAcknowledgement,
}
