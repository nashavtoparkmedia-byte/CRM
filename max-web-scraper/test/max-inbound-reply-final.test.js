'use strict'

const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const assert = require('node:assert/strict')
const {
  isProviderBackedDomReplyCandidate,
  splitMaxDomReplyText,
} = require('../lib/MaxDomReply')

const fixture = JSON.parse(fs.readFileSync(
  path.join(__dirname, 'fixtures/max-inbound-reply-dom.json'),
  'utf8',
))

test('sanitized real MAX DOM reply separates body from quote labels', () => {
  const parts = splitMaxDomReplyText(fixture.rawText)
  assert.deepEqual(parts, {
    ...fixture.expected,
    leafText: fixture.expected.bodyText,
  })
  assert.equal(isProviderBackedDomReplyCandidate(parts, {
    hasReplyQuote: fixture.hasReplyQuote,
    providerMessageId: fixture.providerMessageId,
  }), true)
})

test('ordinary two-line and provider-unbacked multiline text are not trusted as replies', () => {
  assert.equal(splitMaxDomReplyText('Первая строка\nВторая строка'), null)
  assert.equal(isProviderBackedDomReplyCandidate(
    splitMaxDomReplyText('Обычный заголовок\nОбычная строка\nФинальная строка'),
    { hasReplyQuote: false, providerMessageId: null },
  ), false)
})

test('DOM recovery sends raw text plus structured reply candidates to CRM', () => {
  const source = fs.readFileSync(require.resolve('../index'), 'utf8')
  assert.match(source, /_replyBodyText: replyParts\.bodyText/)
  assert.match(source, /replyBodyText: latest\._replyBodyText/)
  assert.match(source, /replyQuoteText: latest\._replyQuoteText/)
  assert.match(source, /providerIdentityMatches/)
})
