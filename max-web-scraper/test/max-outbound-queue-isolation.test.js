'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { SerializedOutboundQueue } = require('../lib/SerializedOutboundQueue')

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

test('serializes interleaved contacts without route leakage', async () => {
  const queue = new SerializedOutboundQueue()
  const sent = []
  let activeRoute = null

  const send = (route, message, delay = 0) => queue.enqueue(async () => {
    assert.equal(activeRoute, null)
    activeRoute = route
    await wait(delay)
    sent.push(`${route}:${message}`)
    activeRoute = null
  })

  await Promise.all([
    send('contact-a', 'A1', 10),
    send('contact-b', 'B1'),
    send('contact-a', 'A2'),
    send('contact-b', 'B2'),
  ])

  assert.deepEqual(sent, [
    'contact-a:A1',
    'contact-b:B1',
    'contact-a:A2',
    'contact-b:B2',
  ])
  assert.equal(queue.size, 0)
})

test('a failed contact does not block following contacts or messages', async () => {
  const queue = new SerializedOutboundQueue()
  const sent = []

  const a1 = queue.enqueue(async () => sent.push('A1'))
  const b1 = queue.enqueue(async () => {
    sent.push('B1-failed')
    throw new Error('route_load_timeout')
  })
  const a2 = queue.enqueue(async () => sent.push('A2'))
  const b2 = queue.enqueue(async () => sent.push('B2'))

  await a1
  await assert.rejects(b1, /route_load_timeout/)
  await Promise.all([a2, b2])

  assert.deepEqual(sent, ['A1', 'B1-failed', 'A2', 'B2'])
  assert.equal(queue.size, 0)
})

test('delayed confirmation keeps one browser action active', async () => {
  const queue = new SerializedOutboundQueue()
  const events = []
  let releaseConfirmation
  const confirmation = new Promise(resolve => { releaseConfirmation = resolve })

  const first = queue.enqueue(async () => {
    events.push('send-1')
    await confirmation
    events.push('confirm-1')
  })
  const second = queue.enqueue(async () => events.push('send-2'))

  await wait(0)
  assert.deepEqual(events, ['send-1'])
  assert.equal(queue.size, 2)

  releaseConfirmation()
  await Promise.all([first, second])
  assert.deepEqual(events, ['send-1', 'confirm-1', 'send-2'])
  assert.equal(queue.size, 0)
})

test('equal text remains two distinct queue items', async () => {
  const queue = new SerializedOutboundQueue()
  const sent = []

  await Promise.all([
    queue.enqueue(async () => sent.push('same')),
    queue.enqueue(async () => sent.push('same')),
  ])

  assert.deepEqual(sent, ['same', 'same'])
})
