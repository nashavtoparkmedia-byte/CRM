'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')

const {
  isDurableMaxWebhookAcknowledgement,
  postJson,
  postJsonAfterSynchronousFence,
  requireDurableMaxWebhookAcknowledgement,
} = require('../inbound/CrmWebhookDelivery')

async function withServer(response, operation) {
  const server = http.createServer((request, reply) => {
    let body = ''
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      response(request, reply, body)
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  try {
    return await operation(`http://127.0.0.1:${address.port}/api/webhooks/max`)
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
}

test('accepts only a durable CRM Message acknowledgement', async () => {
  const result = await withServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({
      success: true,
      chatInternalId: 'chat-internal-1',
      messageId: 'message-1',
      deduped: true,
    }))
  }, url => postJson(url, { externalId: 'd3010000000000000001', text: 'у' }))

  assert.equal(isDurableMaxWebhookAcknowledgement(result), true)
  assert.deepEqual(requireDurableMaxWebhookAcknowledgement(result), {
    durable: true,
    messageId: 'message-1',
    chatInternalId: 'chat-internal-1',
    deduped: true,
  })
})

test('a 2xx skipped response is not a durable acknowledgement', async () => {
  const result = await withServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ ok: true, skipped: 'empty_text' }))
  }, url => postJson(url, { externalId: 'd3010000000000000002', text: '' }))

  assert.equal(isDurableMaxWebhookAcknowledgement(result), false)
  assert.throws(
    () => requireDurableMaxWebhookAcknowledgement(result),
    error => error.code === 'CRM_WEBHOOK_SKIPPED',
  )
})

test('a non-2xx or incomplete success body is not a durable acknowledgement', () => {
  for (const result of [
    { status: 500, json: { success: true, messageId: 'm', chatInternalId: 'c' }, skipped: null },
    { status: 200, json: { success: true, messageId: 'm' }, skipped: null },
    { status: 200, json: { ok: true }, skipped: null },
  ]) {
    assert.equal(isDurableMaxWebhookAcknowledgement(result), false)
    assert.throws(
      () => requireDurableMaxWebhookAcknowledgement(result),
      error => error.code === 'CRM_WEBHOOK_NOT_DURABLE',
    )
  }
})

test('a stale pre-POST fence performs zero network requests', async () => {
  let requests = 0
  await withServer((_request, response) => {
    requests += 1
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ success: true, messageId: 'm', chatInternalId: 'c' }))
  }, async url => {
    await assert.rejects(
      async () => postJsonAfterSynchronousFence(url, { externalId: 'd3010000000000000003' }, {
        assertCurrent() {
          throw Object.assign(new Error('socket generation changed'), {
            code: 'OPCODE19_RUNTIME_FENCE_CHANGED',
          })
        },
      }),
      error => error.code === 'OPCODE19_RUNTIME_FENCE_CHANGED',
    )
  })
  assert.equal(requests, 0)
})

test('the synchronous pre-POST fence runs exactly once before the request', async () => {
  const order = []
  await withServer((_request, response) => {
    order.push('request')
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ success: true, messageId: 'm', chatInternalId: 'c' }))
  }, url => postJsonAfterSynchronousFence(url, { externalId: 'd3010000000000000004' }, {
    assertCurrent() { order.push('fence') },
  }))
  assert.deepEqual(order, ['fence', 'request'])
})
