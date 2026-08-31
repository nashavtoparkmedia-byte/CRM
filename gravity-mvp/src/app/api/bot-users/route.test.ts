import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { hasIntegrationAdminAccess } from '@/modules/identity-access/public/v1'
import { PendingBotLinkRequestNotFoundError, deleteDriverTelegramLinkV1, dismissBotLinkRequestV1 } from '@/modules/telegram-channel/public/v1'

import { DELETE, GET } from './route'

vi.mock('@/lib/prisma', () => ({ prisma: {} }))
vi.mock('@/modules/identity-access/public/v1', () => ({ hasIntegrationAdminAccess: vi.fn() }))
vi.mock('@/modules/telegram-channel/public/v1', () => ({
  PendingBotLinkRequestNotFoundError: class PendingBotLinkRequestNotFoundError extends Error {},
  buildPendingBotLinkRequests: vi.fn(),
  deleteDriverTelegramLinkV1: vi.fn(),
  dismissBotLinkRequestV1: vi.fn(),
}))

const hasAdminAccess = vi.mocked(hasIntegrationAdminAccess)
const deleteLink = vi.mocked(deleteDriverTelegramLinkV1)
const dismissRequest = vi.mocked(dismissBotLinkRequestV1)

function deleteRequest(
  body: unknown,
  origin = 'https://crm.example',
  contentType: string | null = 'application/json',
) {
  const headers = new Headers({ host: 'crm.example', origin })
  if (contentType) headers.set('content-type', contentType)
  return new NextRequest('https://crm.example/api/bot-users', {
    method: 'DELETE',
    headers,
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  hasAdminAccess.mockResolvedValue(false)
})

describe('Telegram bot user administration authorization', () => {
  it('rejects queue reads without an integration-admin session', async () => {
    const response = await GET()

    expect(response.status).toBe(403)
  })

  it.each([
    { action: 'unlink', telegramId: '42' },
    { action: 'dismiss', requestId: 'request-1' },
  ])('rejects mutation $action before unlinking or dismissing', async body => {
    const response = await DELETE(deleteRequest(body))

    expect(response.status).toBe(403)
    expect(deleteLink).not.toHaveBeenCalled()
    expect(dismissRequest).not.toHaveBeenCalled()
  })

  it.each([
    { action: 'unlink', telegramId: 'not-a-number' },
    { action: 'unlink', telegramId: '9223372036854775808' },
    { action: 'dismiss', requestId: 'x'.repeat(201) },
  ])('rejects invalid bounded mutation identity for $action', async body => {
    hasAdminAccess.mockResolvedValue(true)

    const response = await DELETE(deleteRequest(body))

    expect(response.status).toBe(400)
    expect(deleteLink).not.toHaveBeenCalled()
    expect(dismissRequest).not.toHaveBeenCalled()
  })

  it('rejects a cross-origin mutation before authorization or side effects', async () => {
    hasAdminAccess.mockResolvedValue(true)

    const response = await DELETE(deleteRequest(
      { action: 'unlink', telegramId: '42' },
      'https://evil.example',
    ))

    expect(response.status).toBe(403)
    expect(hasAdminAccess).not.toHaveBeenCalled()
    expect(deleteLink).not.toHaveBeenCalled()
    expect(dismissRequest).not.toHaveBeenCalled()
  })

  it.each([null, 'text/plain'])('rejects a mutation with unsupported content type %s', async contentType => {
    hasAdminAccess.mockResolvedValue(true)

    const response = await DELETE(deleteRequest(
      { action: 'unlink', telegramId: '42' },
      'https://crm.example',
      contentType,
    ))

    expect(response.status).toBe(415)
    expect(deleteLink).not.toHaveBeenCalled()
    expect(dismissRequest).not.toHaveBeenCalled()
  })

  it.each([null, 'invalid'])('rejects a non-object JSON mutation body', async body => {
    hasAdminAccess.mockResolvedValue(true)

    const response = await DELETE(deleteRequest(body))

    expect(response.status).toBe(400)
    expect(deleteLink).not.toHaveBeenCalled()
    expect(dismissRequest).not.toHaveBeenCalled()
  })

  it('unlinks a valid Telegram link from an authenticated same-origin JSON request', async () => {
    hasAdminAccess.mockResolvedValue(true)

    const response = await DELETE(deleteRequest({ action: 'unlink', telegramId: '42' }))

    expect(response.status).toBe(200)
    expect(deleteLink).toHaveBeenCalledWith(expect.objectContaining({ telegramId: 42n }))
    expect(dismissRequest).not.toHaveBeenCalled()
  })

  it('dismisses a valid request from an authenticated same-origin JSON request', async () => {
    hasAdminAccess.mockResolvedValue(true)

    const response = await DELETE(deleteRequest({ action: 'dismiss', requestId: 'request-1' }))

    expect(response.status).toBe(200)
    expect(dismissRequest).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'request-1' }))
    expect(deleteLink).not.toHaveBeenCalled()
  })

  it('reports a non-request message ID without claiming deletion', async () => {
    hasAdminAccess.mockResolvedValue(true)
    dismissRequest.mockRejectedValue(new PendingBotLinkRequestNotFoundError())

    const response = await DELETE(deleteRequest({ action: 'dismiss', requestId: 'ordinary-message' }))

    expect(response.status).toBe(404)
    expect(dismissRequest).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'ordinary-message' }))
    expect(deleteLink).not.toHaveBeenCalled()
  })
})
