import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const root = process.cwd()
const webhook = readFileSync(resolve(root, 'src/app/api/webhooks/max/route.ts'), 'utf8')
const feed = readFileSync(resolve(root, 'src/app/messages/components/MessageFeed.tsx'), 'utf8')

describe('MAX reply metadata and UI contract', () => {
  test('stores an unresolved provider quote as metadata without changing the message body', () => {
    expect(webhook).toContain('const replyBodyTextString =')
    expect(webhook).toContain('const replyQuoteTextString =')
    expect(webhook).toContain('resolveMaxReplyStorage')
    expect(webhook).toContain('const content = replyStorage.content')
    expect(webhook).toContain('metadata: {')
    expect(webhook).toContain('...providerReplyMetadata')
  })

  test('stores a resolved reply target separately from its body', () => {
    expect(webhook).toContain('replyToExternalId: params.replyToExternalId')
    expect(webhook).toContain('quotedMsgId')
    expect(webhook).toContain('reconcileDelayedMaxReplyTargets')
    expect(webhook).toContain('replyEnriched: Boolean(replyStorage.target)')
  })

  test('renders unresolved quote metadata as a compact MAX quote preview', () => {
    expect(feed).toContain("typeof msg.metadata?.unresolvedReplyQuoteText === 'string'")
    expect(feed).toContain('msg.metadata.unresolvedReplyQuoteText.trim()')
    expect(feed).toContain("unresolvedQuote ? 'MAX'")
    expect(feed).toContain('unresolvedQuote.substring(0, 80)')
    expect(feed).not.toMatch(/msg\.content\s*=\s*.*unresolvedReplyQuoteText/)
  })
})
