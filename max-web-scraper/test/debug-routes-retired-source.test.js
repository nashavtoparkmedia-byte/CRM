'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { resolve } = require('node:path')

test('all legacy debug provider routes are intercepted by static 404 first', () => {
  const source = readFileSync(resolve(__dirname, '../index.js'), 'utf8')
  const retired = source.indexOf("app.use('/debug'")
  assert.ok(retired >= 0)
  assert.match(source.slice(retired, source.indexOf("app.get('/debug/resolve'")), /status\(404\)/)
  for (const route of [
    "app.get('/debug/resolve'",
    "app.get('/debug/contacts'",
    "app.get('/debug/chats'",
    "app.post('/debug/op71'",
    "app.post('/debug/dom-fallback'",
    "app.post('/debug/dom-identity'",
  ]) {
    assert.ok(source.indexOf(route) > retired, `${route} must remain unreachable behind retirement middleware`)
  }
})
