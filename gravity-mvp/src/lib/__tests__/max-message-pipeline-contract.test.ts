import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const root = process.cwd()
const maxActions = readFileSync(resolve(root, 'src/app/max-actions.ts'), 'utf8')
const webhook = readFileSync(resolve(root, 'src/app/api/webhooks/max/route.ts'), 'utf8')
const feed = readFileSync(resolve(root, 'src/app/messages/components/MessageFeed.tsx'), 'utf8')
const scraper = readFileSync(resolve(root, '..', 'max-web-scraper', 'index.js'), 'utf8')
const envelope = readFileSync(resolve(root, '..', 'max-web-scraper', 'pipeline', 'MessageEnvelope.js'), 'utf8')
const transport = readFileSync(resolve(root, '..', 'max-web-scraper', 'transport', 'TransportInterceptor.js'), 'utf8')
const dryRun = readFileSync(resolve(root, 'scripts', 'max-message-text-dry-run.ts'), 'utf8')

describe('MAX text pipeline contract', () => {
  test('passes outbound CRM text to the scraper as one message field', () => {
    expect(maxActions).toContain('body: JSON.stringify({')
    expect(maxActions).toContain('message,')
    expect(maxActions).not.toMatch(/message\.split\s*\(/)
    expect(scraper).toContain('buildMaxTextMessage(text, replyToMessageId, cid)')
    expect(envelope).toContain("text: String(text ?? '')")
    expect(envelope).not.toMatch(/\.split\s*\(/)
  })

  test('stores inbound text separately from attachments and reply metadata', () => {
    expect(webhook).toContain("const content = text || contentFallbacks[effectiveMessageTypeKey] || ''")
    expect(webhook).toContain('attachments: attachments || []')
    expect(webhook).toContain('replyToExternalId')
    expect(webhook).toContain('metadata:  { senderId')
    expect(scraper).toContain('withForwardingMetadata(payload, msg')
    expect(scraper).not.toMatch(/text:\s*payload\.text\s*\?\s*`\$\{prefix\}/)
    expect(envelope).toContain('forwardedFrom:')
    expect(envelope).not.toContain('`${prefix}')
  })

  test('renders the message body from content and structured media separately', () => {
    expect(feed).toContain('msg.content')
    expect(feed).toContain("msg.type === 'image'")
    expect(feed).toContain('msg.attachments')
    expect(feed).toContain('getRenderedMessageText(msg)')
  })

  test('records invalid UTF-8 diagnostics without claiming a repair', () => {
    expect(transport).toContain("kind: 'invalid_utf8_string'")
    expect(transport).toContain("MAX_UTF8_DIAGNOSTIC_PREFIX")
    expect(transport).toContain("Buffer.from(s).toString('utf8')")
  })

  test('keeps the historical DB runner read-only', () => {
    expect(dryRun).toContain("where: { channel: 'max' }")
    expect(dryRun).toContain('findMany')
    expect(dryRun).not.toMatch(/\.(?:create|update|upsert|delete|deleteMany|updateMany)\s*\(/)
    expect(dryRun).not.toMatch(/\$(?:executeRaw|executeRawUnsafe)\b/)
  })
})
