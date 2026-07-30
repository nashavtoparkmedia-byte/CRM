import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const root = process.cwd()
const maxActions = readFileSync(resolve(root, 'src/app/max-actions.ts'), 'utf8')
const gatewayClient = readFileSync(resolve(root, 'src/lib/PersonalMaxGatewayClient.ts'), 'utf8')
const gatewayService = readFileSync(resolve(root, '..', 'max-personal-gateway', 'src', 'sender', 'TextCanaryService.ts'), 'utf8')
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
    expect(gatewayClient).toContain('text: input.text')
    expect(gatewayClient).not.toMatch(/input\.text\.split\s*\(/)
    expect(gatewayService).toContain('text: (command.commandPayload as any).text')
  })

  test('stores inbound text separately from attachments and reply metadata', () => {
    expect(webhook).toContain("const content = text || contentFallbacks[effectiveMessageTypeKey] || ''")
    expect(webhook).toContain('attachments: attachments || []')
    expect(webhook).toContain('replyToExternalId')
    expect(webhook).toContain('metadata:  { senderId')
    expect(scraper).toContain('forwardToWebhook({')
    expect(scraper).toContain('replyToExternalId: latest._replyToExternalId')
    expect(scraper).toContain('let payload = MessageParser.toCrmPayload(msg)')
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
    expect(transport).toContain('UTF8_FATAL_DECODER')
    expect(transport).toContain("new TextDecoder('utf-8', { fatal: true })")
  })

  test('keeps the historical DB runner read-only', () => {
    expect(dryRun).toContain("where: { channel: 'max' }")
    expect(dryRun).toContain('findMany')
    expect(dryRun).not.toMatch(/\.(?:create|update|upsert|delete|deleteMany|updateMany)\s*\(/)
    expect(dryRun).not.toMatch(/\$(?:executeRaw|executeRawUnsafe)\b/)
  })
})
