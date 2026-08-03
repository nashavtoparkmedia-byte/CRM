import { beforeEach, describe, expect, test, vi } from 'vitest'

const prismaMock = vi.hoisted(() => ({
  $queryRaw: vi.fn(),
  $executeRaw: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }))

import { ConversationWorkflowService } from '@/lib/ConversationWorkflowService'

function renderedSql(call: unknown[]): string {
  const [strings] = call as [TemplateStringsArray, ...unknown[]]
  return Array.from(strings).join('?').replace(/\s+/g, ' ').trim()
}

describe('ConversationWorkflowService monotonic inbound timestamps', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    prismaMock.$queryRaw.mockResolvedValue([{ status: 'open' }])
    prismaMock.$executeRaw.mockResolvedValue(1)
  })

  test('private inbound uses an atomic max expression without changing workflow fields', async () => {
    const sentAt = new Date('2026-08-03T18:17:50.051Z')

    await ConversationWorkflowService.onInboundMessage('chat-1', sentAt)

    const call = prismaMock.$executeRaw.mock.calls[0]
    const sql = renderedSql(call)
    expect(sql).toContain('"unreadCount" = "unreadCount" + 1')
    expect(sql).toContain('"requiresResponse" = true')
    expect(sql).toContain('"lastInboundAt" = CASE')
    expect(sql).toContain('WHEN "lastInboundAt" IS NULL OR "lastInboundAt" < ? THEN ?')
    expect(sql).toContain('ELSE "lastInboundAt" END')
    expect(sql).toContain('status = ?')
    expect(call.slice(1)).toEqual([sentAt, sentAt, 'open', 'chat-1'])
  })

  test('delayed old inbound stays below the stored max while a newer inbound advances it', async () => {
    let storedLastInboundAt = new Date('2026-08-03T18:17:52.281Z')
    prismaMock.$executeRaw.mockImplementation(async (_strings, incoming: Date) => {
      if (storedLastInboundAt < incoming) storedLastInboundAt = incoming
      return 1
    })

    await ConversationWorkflowService.onInboundMessage(
      'chat-1',
      new Date('2026-08-03T18:17:50.051Z'),
    )
    expect(storedLastInboundAt.toISOString()).toBe('2026-08-03T18:17:52.281Z')

    await ConversationWorkflowService.onInboundMessage(
      'chat-1',
      new Date('2026-08-03T18:17:53.000Z'),
    )
    expect(storedLastInboundAt.toISOString()).toBe('2026-08-03T18:17:53.000Z')
  })

  test('group inbound uses the same monotonic expression without private workflow mutations', async () => {
    const sentAt = new Date('2026-08-03T18:17:50.051Z')

    await ConversationWorkflowService.onGroupInboundMessage('chat-group', sentAt)

    const call = prismaMock.$executeRaw.mock.calls[0]
    const sql = renderedSql(call)
    expect(sql).toContain('"unreadCount" = "unreadCount" + 1')
    expect(sql).toContain('"lastInboundAt" = CASE')
    expect(sql).toContain('WHEN "lastInboundAt" IS NULL OR "lastInboundAt" < ? THEN ?')
    expect(sql).not.toContain('"requiresResponse"')
    expect(sql).not.toContain('status =')
    expect(call.slice(1)).toEqual([sentAt, sentAt, 'chat-group'])
  })
})
