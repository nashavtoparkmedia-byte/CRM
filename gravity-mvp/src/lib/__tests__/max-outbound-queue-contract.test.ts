import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(process.cwd(), '..')
const scraper = readFileSync(resolve(root, 'max-web-scraper/index.js'), 'utf8')
const queue = readFileSync(resolve(root, 'max-web-scraper/lib/MaxOutboundQueue.js'), 'utf8')
const maxActions = readFileSync(resolve(process.cwd(), 'src/app/max-actions.ts'), 'utf8')
const messageService = readFileSync(resolve(process.cwd(), 'src/lib/MessageService.ts'), 'utf8')
const callback = readFileSync(
  resolve(process.cwd(), 'src/app/api/webhook/max/delivery-status/route.ts'),
  'utf8',
)

describe('MAX outbound persistent queue contract', () => {
  it('stores the queue inside the persistent MAX user_data volume', () => {
    expect(scraper).toContain("path.join(USER_DATA_DIR, 'max_outbound_queue.json')")
    expect(scraper).toContain('new MaxOutboundQueue')
    expect(queue).toContain('fs.renameSync(temp, this.filePath)')
  })

  it('returns queued HTTP state instead of holding CRM requests behind provider ack', () => {
    expect(scraper).toContain('const queued = maxOutboundQueue.enqueue({')
    expect(scraper).toContain('res.status(delivered ? 200 : 202).json({')
    expect(scraper).toContain("deliveryStatus: delivered ? 'delivered' : 'queued'")
  })

  it('uses the CRM message id as durable provider queue identity', () => {
    expect(maxActions).toContain('crmMessageId')
    expect(maxActions).toContain('queueId')
    expect(messageService).toContain('crmMessageId: messageId')
    expect(messageService).toContain('crmMessageId: message.id')
  })

  it('correlates exact provider echoes before the normal inbound webhook', () => {
    const confirmation = scraper.indexOf('await maxOutboundQueue.confirmEcho({')
    const webhookPayload = scraper.indexOf('let payload = MessageParser.toCrmPayload(msg)')
    expect(confirmation).toBeGreaterThan(0)
    expect(webhookPayload).toBeGreaterThan(confirmation)
    expect(scraper).toContain('provider echo confirmed queueId=')
    expect(scraper).toContain("source: 'provider_dom_echo'")
    expect(scraper).toContain("skipped: 'outbound_queue_echo'")
  })

  it('updates the same outbound MAX Message row through the callback', () => {
    expect(callback).toContain('body.crmMessageId')
    expect(callback).toContain('body.clientMessageId')
    expect(callback).toContain("message.direction !== 'outbound'")
    expect(callback).toContain('broadcastChatMessage(message.chatId, updated)')
  })

  it('does not let the initial enqueue response overwrite a callback result', () => {
    expect(messageService).toContain("status: { in: deliveryStatus === 'queued' ? ['queued'] : ['queued', 'sent'] }")
    expect(messageService).toContain("status: channel === 'max' ? 'queued' : 'sent'")
  })

  it('keeps ordinary text and reply on the same serialized executor', () => {
    expect(scraper).toContain('item.quotedMsgId')
    expect(scraper).toContain('return normalizeTextSendResult(await enqueueSend(() => sendText(')
    expect(queue).toContain('.sort((a, b) => a.sequence - b.sequence)[0]')
  })
})
