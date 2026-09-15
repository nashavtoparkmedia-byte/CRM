import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  recordExact: vi.fn(),
  telegramCheck: vi.fn(),
  whatsappCheck: vi.fn(),
  principal: vi.fn(),
}))

vi.mock('@/modules/contacts/public/v1/contact-reachability', () => ({
  contactReachabilityV1: {
    recordExactProviderReachability: mocks.recordExact,
  },
}))
vi.mock('@/infrastructure/telegram/operational-capabilities', () => ({
  checkOperationalTelegramReachabilityV1: mocks.telegramCheck,
}))
vi.mock('@/infrastructure/whatsapp/operational-capabilities', () => ({
  checkOperationalWhatsAppReachabilityV1: mocks.whatsappCheck,
}))
vi.mock('@/modules/identity-access/public/v1', async importOriginal => ({
  ...await importOriginal<typeof import('@/modules/identity-access/public/v1')>(),
  getIntegrationAdminPrincipal: mocks.principal,
}))

import { POST } from './route'

function request(body: Record<string, unknown>, origin = 'https://crm.example') {
  return new NextRequest('https://crm.example/api/channels/check-reachability', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', host: 'crm.example', origin },
    body: JSON.stringify(body),
  })
}

function exactBody(overrides: Record<string, unknown> = {}) {
  return {
    phone: '+7 999 000-00-01',
    channel: 'telegram',
    identityId: 'identity-b',
    contactId: 'contact-b',
    providerAccountId: 'telegram-account-b',
    ...overrides,
  }
}

describe('exact reachability route persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.recordExact.mockResolvedValue({
      outcome: 'updated',
      identityId: 'identity-b',
      status: 'confirmed',
    })
    mocks.telegramCheck.mockResolvedValue({
      reachable: true,
      telegramId: 'opaque-user-b',
      providerAccountId: 'telegram-account-b',
    })
    mocks.whatsappCheck.mockResolvedValue({
      reachable: true,
      confirmed: true,
      providerAccountId: 'wa-account-b',
      providerTargetId: '79990000001@c.us',
    })
    mocks.principal.mockResolvedValue({
      id: 'identity-access:integration-admin-session',
      kind: 'integration_admin_session',
    })
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  test('rejects unsigned and cross-origin checks before providers or persistence', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    mocks.principal.mockResolvedValueOnce(null)

    const unauthorized = await POST(request(exactBody()))
    const crossOrigin = await POST(request(exactBody(), 'https://attacker.example'))

    expect(unauthorized.status).toBe(401)
    expect(crossOrigin.status).toBe(403)
    expect(mocks.principal).toHaveBeenCalledTimes(1)
    expect(mocks.telegramCheck).not.toHaveBeenCalled()
    expect(mocks.whatsappCheck).not.toHaveBeenCalled()
    expect(mocks.recordExact).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('persists a same-phone check only through the explicitly selected identity and Contact owner', async () => {
    const response = await POST(request(exactBody()))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toMatchObject({
      status: 'confirmed',
      providerAccountId: 'telegram-account-b',
      providerTargetId: 'opaque-user-b',
    })
    expect(mocks.telegramCheck).toHaveBeenCalledWith('+79990000001', 'telegram-account-b')
    expect(mocks.recordExact).toHaveBeenCalledWith({
      identityId: 'identity-b',
      contactId: 'contact-b',
      channel: 'telegram',
      providerAccountId: 'telegram-account-b',
      providerTargetId: 'opaque-user-b',
      status: 'confirmed',
    })
  })

  test('keeps phone-only discovery non-authorizing', async () => {
    const response = await POST(request({
      phone: '+79990000001',
      channel: 'telegram',
    }))

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ status: 'confirmed', telegramId: 'opaque-user-b' })
    expect(mocks.telegramCheck).toHaveBeenCalledWith('+79990000001', undefined)
    expect(mocks.recordExact).not.toHaveBeenCalled()
  })

  test('rejects partial identity authority before contacting a provider', async () => {
    const response = await POST(request({
      phone: '+79990000001',
      channel: 'telegram',
      identityId: 'identity-b',
    }))

    expect(response.status).toBe(400)
    expect(mocks.telegramCheck).not.toHaveBeenCalled()
    expect(mocks.recordExact).not.toHaveBeenCalled()
  })

  test('uses the provider-returned opaque target, never the shared phone, for persistence', async () => {
    mocks.telegramCheck.mockResolvedValueOnce({
      reachable: true,
      telegramId: 'provider-returned-user-id',
      providerAccountId: 'telegram-account-b',
    })

    await POST(request(exactBody()))

    expect(mocks.recordExact).toHaveBeenCalledWith(expect.objectContaining({
      providerTargetId: 'provider-returned-user-id',
    }))
    expect(mocks.recordExact).not.toHaveBeenCalledWith(expect.objectContaining({
      providerTargetId: '+79990000001',
    }))
  })

  test('fails closed when the answering provider account differs from the requested binding', async () => {
    mocks.telegramCheck.mockResolvedValueOnce({
      reachable: true,
      telegramId: 'opaque-user-b',
      providerAccountId: 'telegram-account-a',
    })

    const response = await POST(request(exactBody()))

    expect(await response.json()).toMatchObject({
      status: 'checking',
      retryable: false,
      errorCode: 'provider_account_mismatch',
    })
    expect(mocks.recordExact).not.toHaveBeenCalled()
  })

  test('fails closed when Telegram returns a target without live account attestation', async () => {
    mocks.telegramCheck.mockResolvedValueOnce({
      reachable: true,
      telegramId: 'opaque-user-b',
    })

    const response = await POST(request(exactBody()))

    expect(await response.json()).toMatchObject({
      status: 'checking',
      retryable: false,
      errorCode: 'exact_provider_binding_unproven',
    })
    expect(mocks.recordExact).not.toHaveBeenCalled()
  })

  test('fails closed when WhatsApp does not return the exact checked JID', async () => {
    mocks.whatsappCheck.mockResolvedValueOnce({ reachable: true, confirmed: true })

    const response = await POST(request(exactBody({
      channel: 'whatsapp',
      providerAccountId: 'wa-account-b',
    })))

    expect(await response.json()).toMatchObject({
      status: 'checking',
      retryable: false,
      errorCode: 'exact_provider_binding_unproven',
    })
    expect(mocks.whatsappCheck).toHaveBeenCalledWith('+79990000001', 'wa-account-b')
    expect(mocks.recordExact).not.toHaveBeenCalled()
  })

  test('fails closed when WhatsApp does not return the exact answering account', async () => {
    mocks.whatsappCheck.mockResolvedValueOnce({
      reachable: true,
      confirmed: true,
      providerTargetId: '79990000001@c.us',
    })

    const response = await POST(request(exactBody({
      channel: 'whatsapp',
      providerAccountId: 'wa-account-b',
    })))

    expect(await response.json()).toMatchObject({
      status: 'checking',
      retryable: false,
      errorCode: 'exact_provider_binding_unproven',
    })
    expect(mocks.recordExact).not.toHaveBeenCalled()
  })

  test('persists the exact WhatsApp account and provider-returned JID', async () => {
    const response = await POST(request(exactBody({
      channel: 'whatsapp',
      providerAccountId: 'wa-account-b',
    })))

    expect(await response.json()).toMatchObject({ status: 'confirmed' })
    expect(mocks.recordExact).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'whatsapp',
      providerAccountId: 'wa-account-b',
      providerTargetId: '79990000001@c.us',
    }))
  })

  test('persists MAX only from its live-attested account and provider-returned opaque target', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      status: 'confirmed',
      chatId: 'opaque-max-user-b',
      providerAccountId: 'max-account-b',
      source: 'live_lookup',
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    const response = await POST(request(exactBody({
      channel: 'max',
      providerAccountId: 'max-account-b',
    })))

    expect(await response.json()).toMatchObject({ status: 'confirmed' })
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/check-reachability'),
      expect.objectContaining({
        body: JSON.stringify({ phone: '+79990000001', providerAccountId: 'max-account-b' }),
      }),
    )
    expect(mocks.recordExact).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'max',
      providerAccountId: 'max-account-b',
      providerTargetId: 'opaque-max-user-b',
    }))
  })

  test('refuses a MAX response attested by another live account', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      status: 'confirmed',
      chatId: 'opaque-max-user-a',
      providerAccountId: 'max-account-a',
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    const response = await POST(request(exactBody({
      channel: 'max',
      providerAccountId: 'max-account-b',
    })))

    expect(await response.json()).toMatchObject({
      status: 'checking',
      retryable: false,
      errorCode: 'provider_account_mismatch',
    })
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(mocks.recordExact).not.toHaveBeenCalled()
  })

  test('surfaces a live scraper account mismatch as non-retryable', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      code: 'MAX_PROVIDER_ACCOUNT_MISMATCH',
      error: 'Requested account does not match live session',
    }), {
      status: 409,
      headers: { 'Content-Type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    const response = await POST(request(exactBody({
      channel: 'max',
      providerAccountId: 'max-account-b',
    })))

    expect(await response.json()).toMatchObject({
      status: 'checking',
      retryable: false,
      errorCode: 'provider_account_mismatch',
    })
    expect(mocks.recordExact).not.toHaveBeenCalled()
  })

  test('requires a concrete MAX account before scraper access', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const response = await POST(request({
      phone: '+79990000001',
      channel: 'max',
    }))

    expect(await response.json()).toMatchObject({
      status: 'checking',
      retryable: false,
      errorCode: 'provider_account_unproven',
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('does not trust a definitive MAX response without live account proof', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      status: 'confirmed',
      chatId: 'opaque-max-user-b',
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    const response = await POST(request(exactBody({
      channel: 'max',
      providerAccountId: 'max-account-b',
    })))

    expect(await response.json()).toMatchObject({
      status: 'checking',
      retryable: false,
      errorCode: 'exact_provider_binding_unproven',
    })
    expect(mocks.recordExact).not.toHaveBeenCalled()
  })

  test('returns the stronger persisted confirmation after an exact negative check', async () => {
    mocks.whatsappCheck.mockResolvedValueOnce({
      reachable: false,
      providerAccountId: 'wa-account-b',
      providerTargetId: '79990000001@c.us',
    })
    mocks.recordExact.mockResolvedValueOnce({
      outcome: 'confirmed_preserved',
      identityId: 'identity-b',
      status: 'confirmed',
    })

    const response = await POST(request(exactBody({
      channel: 'whatsapp',
      providerAccountId: 'wa-account-b',
    })))

    expect(await response.json()).toMatchObject({
      status: 'confirmed',
      confirmed: true,
      source: 'persisted',
    })
    expect(mocks.recordExact).toHaveBeenCalledWith(expect.objectContaining({ status: 'unreachable' }))
  })

  test('turns owner rejection into a non-authorizing operational response', async () => {
    mocks.recordExact.mockResolvedValueOnce({
      outcome: 'rejected',
      reason: 'provider_target_mismatch',
    })

    const response = await POST(request(exactBody()))

    expect(await response.json()).toMatchObject({
      status: 'checking',
      confirmed: false,
      retryable: false,
      errorCode: 'provider_target_mismatch',
    })
  })
})
