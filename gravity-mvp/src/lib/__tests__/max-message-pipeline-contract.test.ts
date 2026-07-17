import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const root = process.cwd()
const maxActions = readFileSync(resolve(root, 'src/app/max-actions.ts'), 'utf8')
const webhook = readFileSync(resolve(root, 'src/app/api/webhooks/max/route.ts'), 'utf8')
const feed = readFileSync(resolve(root, 'src/app/messages/components/MessageFeed.tsx'), 'utf8')

describe('MAX text pipeline contract', () => {
  test('passes outbound CRM text to the scraper as one message field', () => {
    expect(maxActions).toContain('body: JSON.stringify({')
    expect(maxActions).toContain('message,')
    expect(maxActions).not.toMatch(/message\.split\s*\(/)
  })

  test('stores inbound text separately from attachments and reply metadata', () => {
    expect(webhook).toContain("const content = text || contentFallbacks[effectiveMessageTypeKey] || ''")
    expect(webhook).toContain('attachments: attachments || []')
    expect(webhook).toContain('replyToExternalId')
    expect(webhook).toContain('metadata:  { senderId')
  })

  test('renders the message body from content and structured media separately', () => {
    expect(feed).toContain('msg.content')
    expect(feed).toContain("msg.type === 'image'")
    expect(feed).toContain('msg.attachments')
  })
})
