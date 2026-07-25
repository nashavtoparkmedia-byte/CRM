'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { MaxOutboundQueue } = require('../lib/MaxOutboundQueue')

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'max-outbound-'))
  return path.join(dir, 'queue.json')
}

function command(message, extra = {}) {
  return {
    crmMessageId: `crm-${message}`,
    clientMessageId: `client-${message}`,
    chatId: '902454841098',
    message,
    ...extra,
  }
}

function delivered(message) {
  return {
    deliveryConfirmed: true,
    externalId: `d301${Buffer.from(message).toString('hex').padEnd(16, '0')}`,
    source: 'test_ack',
  }
}

async function until(predicate, timeoutMs = 1000) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('condition timeout')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

test('rapid 1/2/3 are delivered in FIFO order with one active sender', async () => {
  const order = []
  let active = 0
  let maxActive = 0
  const queue = new MaxOutboundQueue({
    filePath: tempFile(),
    execute: async item => {
      active += 1
      maxActive = Math.max(maxActive, active)
      order.push(item.message)
      await new Promise(resolve => setTimeout(resolve, 5))
      active -= 1
      return delivered(item.message)
    },
  })
  queue.start()
  queue.enqueue(command('1'))
  queue.enqueue(command('2'))
  queue.enqueue(command('3'))
  await queue.waitForIdle()
  queue.stop()

  assert.deepEqual(order, ['1', '2', '3'])
  assert.equal(maxActive, 1)
  assert.deepEqual(queue.list().map(item => item.status), ['delivered', 'delivered', 'delivered'])
})

test('delayed confirmation of first item preserves FIFO', async () => {
  const order = []
  let releaseFirst
  const firstGate = new Promise(resolve => { releaseFirst = resolve })
  const queue = new MaxOutboundQueue({
    filePath: tempFile(),
    execute: async item => {
      order.push(`start:${item.message}`)
      if (item.message === '1') await firstGate
      order.push(`done:${item.message}`)
      return delivered(item.message)
    },
  })
  queue.start()
  queue.enqueue(command('1'))
  queue.enqueue(command('2'))
  await until(() => order.includes('start:1'))
  assert.deepEqual(order, ['start:1'])
  releaseFirst()
  await queue.waitForIdle()
  queue.stop()

  assert.deepEqual(order, ['start:1', 'done:1', 'start:2', 'done:2'])
})

test('missing confirmation for second item fails it and third continues without inbound event', async () => {
  const order = []
  const queue = new MaxOutboundQueue({
    filePath: tempFile(),
    execute: async item => {
      order.push(item.message)
      if (item.message === '2') return { deliveryConfirmed: false }
      return delivered(item.message)
    },
  })
  queue.start()
  queue.enqueue(command('1'))
  queue.enqueue(command('2'))
  queue.enqueue(command('3'))
  await queue.waitForIdle()
  queue.stop()

  assert.deepEqual(order, ['1', '2', '3'])
  assert.deepEqual(queue.list().map(item => item.status), ['delivered', 'failed', 'delivered'])
})

test('retry reuses the same queue item and client identity', async () => {
  let calls = 0
  const filePath = tempFile()
  const queue = new MaxOutboundQueue({
    filePath,
    execute: async item => {
      calls += 1
      if (calls === 1) throw Object.assign(new Error('temporary disconnect'), { retryable: true })
      return delivered(item.message)
    },
  })
  queue.start()
  const first = queue.enqueue(command('retry'))
  await queue.waitForIdle()
  assert.equal(queue.get(command('retry')).status, 'failed')
  const retried = queue.enqueue(command('retry'))
  await queue.waitForIdle()
  queue.stop()

  assert.equal(retried.queueId, first.queueId)
  assert.equal(queue.list().length, 1)
  assert.equal(queue.list()[0].attempt, 2)
  assert.equal(queue.list()[0].status, 'delivered')
})

test('reconnect failure between second and third does not stop the queue', async () => {
  const order = []
  const queue = new MaxOutboundQueue({
    filePath: tempFile(),
    execute: async item => {
      order.push(item.message)
      if (item.message === 'disconnect') {
        throw Object.assign(new Error('WS disconnected'), { code: 'MAX_WS_DISCONNECTED', retryable: true })
      }
      return delivered(item.message)
    },
  })
  queue.start()
  queue.enqueue(command('before'))
  queue.enqueue(command('disconnect'))
  queue.enqueue(command('after'))
  await queue.waitForIdle()
  queue.stop()

  assert.deepEqual(order, ['before', 'disconnect', 'after'])
  assert.equal(queue.get(command('after')).status, 'delivered')
})

test('ordinary text, reply and ordinary text share one FIFO lifecycle', async () => {
  const seen = []
  const queue = new MaxOutboundQueue({
    filePath: tempFile(),
    execute: async item => {
      seen.push([item.message, item.quotedMsgId])
      return delivered(item.message)
    },
  })
  queue.start()
  queue.enqueue(command('plain-1'))
  queue.enqueue(command('reply', { quotedMsgId: 'd301quoted00000001' }))
  queue.enqueue(command('plain-2'))
  await queue.waitForIdle()
  queue.stop()

  assert.deepEqual(seen, [
    ['plain-1', null],
    ['reply', 'd301quoted00000001'],
    ['plain-2', null],
  ])
})

test('failed reply does not block following ordinary text', async () => {
  const seen = []
  const queue = new MaxOutboundQueue({
    filePath: tempFile(),
    execute: async item => {
      seen.push(item.message)
      if (item.quotedMsgId) throw Object.assign(new Error('reply target unavailable'), { retryable: false })
      return delivered(item.message)
    },
  })
  queue.start()
  queue.enqueue(command('reply-fail', { quotedMsgId: 'd301quoted00000002' }))
  queue.enqueue(command('next-text'))
  await queue.waitForIdle()
  queue.stop()

  assert.deepEqual(seen, ['reply-fail', 'next-text'])
  assert.equal(queue.get(command('next-text')).status, 'delivered')
})

test('duplicate worker kicks never create parallel senders', async () => {
  let active = 0
  let maxActive = 0
  const queue = new MaxOutboundQueue({
    filePath: tempFile(),
    execute: async item => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise(resolve => setTimeout(resolve, 8))
      active -= 1
      return delivered(item.message)
    },
  })
  queue.start()
  for (let index = 0; index < 8; index += 1) {
    queue.enqueue(command(`worker-${index}`))
    queue.kick()
    queue.kick()
  }
  await queue.waitForIdle()
  queue.stop()

  assert.equal(maxActive, 1)
})

test('duplicate provider echo is idempotent', async () => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  const queue = new MaxOutboundQueue({
    filePath: tempFile(),
    execute: async () => {
      await gate
      return { deliveryConfirmed: false }
    },
  })
  queue.start()
  queue.enqueue(command('echo'))
  await until(() => queue.get(command('echo')).status === 'sending')
  const echo = {
    chatId: '902454841098',
    message: 'echo',
    externalId: 'd301echo000000000001',
  }
  const first = await queue.confirmEcho(echo)
  const second = await queue.confirmEcho(echo)
  release()
  await queue.waitForIdle()
  queue.stop()

  assert.equal(first.queueId, second.queueId)
  assert.equal(queue.list().length, 1)
  assert.equal(queue.list()[0].status, 'delivered')
})

test('late provider echo upgrades retryable failure without resending', async () => {
  let calls = 0
  const queue = new MaxOutboundQueue({
    filePath: tempFile(),
    execute: async () => {
      calls += 1
      return { deliveryConfirmed: false }
    },
  })
  queue.start()
  queue.enqueue(command('late'))
  await queue.waitForIdle()
  assert.equal(queue.get(command('late')).status, 'failed')
  await queue.confirmEcho({
    chatId: '902454841098',
    message: 'late',
    externalId: 'd301late000000000001',
  })
  queue.stop()

  assert.equal(calls, 1)
  assert.equal(queue.get(command('late')).status, 'delivered')
})

test('queued FIFO survives reload and sending item is recovered after restart', async () => {
  const filePath = tempFile()
  const first = new MaxOutboundQueue({
    filePath,
    execute: async item => delivered(item.message),
  })
  first.enqueue(command('restart-1'))
  first.enqueue(command('restart-2'))
  const state = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  state.items[0].status = 'sending'
  fs.writeFileSync(filePath, JSON.stringify(state))

  const order = []
  const recovered = new MaxOutboundQueue({
    filePath,
    execute: async item => {
      order.push(item.message)
      return delivered(item.message)
    },
  })
  assert.equal(recovered.get(command('restart-1')).status, 'queued')
  recovered.start()
  await recovered.waitForIdle()
  recovered.stop()

  assert.deepEqual(order, ['restart-1', 'restart-2'])
  assert.deepEqual(recovered.list().map(item => item.status), ['delivered', 'delivered'])
})

test('failed CRM callback remains durable and is flushed after restart', async () => {
  const filePath = tempFile()
  const first = new MaxOutboundQueue({
    filePath,
    execute: async item => delivered(item.message),
    report: async () => {
      throw new Error('CRM temporarily unavailable')
    },
  })
  first.start()
  first.enqueue(command('callback-restart'))
  await first.waitForIdle()
  first.stop()
  assert.equal(first.get(command('callback-restart')).reportPending, true)

  const reports = []
  const recovered = new MaxOutboundQueue({
    filePath,
    execute: async item => delivered(item.message),
    report: async item => reports.push(item.status),
  })
  recovered.start()
  await until(() => recovered.get(command('callback-restart')).reportPending === false)
  recovered.stop()

  assert.deepEqual(reports, ['delivered'])
  assert.equal(recovered.get(command('callback-restart')).status, 'delivered')
})
