'use strict'
// Sends a fake inbound MAX message to the CRM webhook to test if SSE push works
const https = require('https')
const http = require('http')

const CRM_WEBHOOK_URL = process.env.CRM_WEBHOOK_URL || 'http://crm-gravity-mvp:3000/api/webhooks/max'

const payload = JSON.stringify({
  externalId: `test-${Date.now()}`,
  chatId: 201482140,       // same chatId as the real chat
  senderId: 27403452,
  senderName: 'Тест',
  text: '[SSE-TEST] Пробное сообщение - если видишь в CRM значит SSE работает',
  timestamp: Date.now(),
  messageType: 'text',
  isOutgoing: false,
})

const url = new URL(CRM_WEBHOOK_URL)
const mod = url.protocol === 'https:' ? https : http

const req = mod.request({
  hostname: url.hostname,
  port: url.port || (url.protocol === 'https:' ? 443 : 80),
  path: url.pathname + url.search,
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
}, res => {
  let data = ''
  res.on('data', c => { data += c })
  res.on('end', () => console.log(`Status: ${res.statusCode} → ${data}`))
})
req.on('error', e => console.error('Error:', e.message))
req.write(payload)
req.end()
