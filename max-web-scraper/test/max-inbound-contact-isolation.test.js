'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { PerKeyTaskQueue } = require('../lib/PerKeyTaskQueue')

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

test('keeps text-image-image-text-text ordered inside one MAX chat', async () => {
  const queue = new PerKeyTaskQueue()
  const stored = []
  const events = [
    ['text-1', 2],
    ['image-1', 15],
    ['image-2', 1],
    ['text-2', 0],
    ['text-3', 0],
  ]

  await Promise.all(events.map(([name, delay]) =>
    queue.enqueue('901967525678', async () => {
      await wait(delay)
      stored.push(name)
    })
  ))

  assert.deepEqual(stored, events.map(([name]) => name))
  assert.equal(queue.size, 0)
})

test('isolates different contacts while preserving each contact FIFO', async () => {
  const queue = new PerKeyTaskQueue()
  const stored = []

  await Promise.all([
    queue.enqueue('902454841098', async () => {
      await wait(20)
      stored.push('A1')
    }),
    queue.enqueue('901967525678', async () => {
      stored.push('B1')
    }),
    queue.enqueue('902454841098', async () => {
      stored.push('A2')
    }),
    queue.enqueue('901967525678', async () => {
      stored.push('B2')
    }),
  ])

  assert.ok(stored.indexOf('A1') < stored.indexOf('A2'))
  assert.ok(stored.indexOf('B1') < stored.indexOf('B2'))
  assert.ok(stored.indexOf('B1') < stored.indexOf('A1'))
})

test('a failed image does not block following text in the same chat', async () => {
  const queue = new PerKeyTaskQueue()
  const stored = []

  const failedImage = queue.enqueue('901967525678', async () => {
    stored.push('image-retryable')
    throw new Error('image_download_failed')
  })
  const followingText = queue.enqueue('901967525678', async () => {
    stored.push('text-after-image')
  })

  await assert.rejects(failedImage, /image_download_failed/)
  await followingText
  await wait(0)

  assert.deepEqual(stored, ['image-retryable', 'text-after-image'])
  assert.equal(queue.size, 0)
})
