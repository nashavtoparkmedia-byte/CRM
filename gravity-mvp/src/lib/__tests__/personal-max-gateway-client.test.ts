import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sendPersonalMaxDurableText } from '../PersonalMaxGatewayClient'

const protocolChatId = '902454841098'

function stubDurableCrypto() {
  const bytes = (value: number) => Uint8Array.from({ length: 32 }, () => value).buffer
  vi.stubGlobal('crypto', {
    randomUUID: vi.fn(() => '00000000-0000-4000-8000-000000000000'),
    subtle: {
      digest: vi.fn(async () => bytes(0x11)),
      importKey: vi.fn(async () => ({}) as CryptoKey),
      sign: vi.fn(async () => bytes(0x22)),
    },
  })
}

function gatewayResponse(dispatchId: unknown): Response {
  return new Response(JSON.stringify({
    success: true,
    externalId: null,
    chatId: protocolChatId,
    deliveryConfirmed: false,
    deliveryStatus: 'queued',
    dispatchId,
    idempotent: false,
  }), { status: 200, headers: { 'content-type': 'application/json' } })
}

describe('Personal MAX durable gateway response contract', () => {
  beforeEach(() => {
    vi.stubEnv('MAX_PERSONAL_GATEWAY_URL', 'http://max-personal-gateway:8080')
    vi.stubEnv('MAX_PERSONAL_ACCOUNT_ID', 'account-a')
    vi.stubEnv('MAX_PERSONAL_TEXT_COMMAND_HMAC_SECRET', 'test-command-secret-000000000000000000000000')
    stubDurableCrypto()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('accepts queued work before or after a durable dispatch row is allocated', async () => {
    const responses = [gatewayResponse(null), gatewayResponse('dispatch-a')]
    vi.stubGlobal('fetch', vi.fn(async () => responses.shift()!))

    const beforeDispatch = await sendPersonalMaxDurableText({ protocolChatId, text: 'queued one', clientMessageId: 'client-one' })
    const afterDispatch = await sendPersonalMaxDurableText({ protocolChatId, text: 'queued two', clientMessageId: 'client-two' })

    expect(beforeDispatch.dispatchId).toBeNull()
    expect(afterDispatch.dispatchId).toBe('dispatch-a')
  })

  it('includes reply provider identity in the authenticated durable command body', async () => {
    let capturedBody: Record<string, unknown> | null = null
    vi.stubGlobal('fetch', vi.fn(async (_url, options: any) => {
      capturedBody = JSON.parse(String(options.body))
      return gatewayResponse('dispatch-reply')
    }))

    await sendPersonalMaxDurableText({
      protocolChatId,
      text: 'durable reply',
      clientMessageId: 'client-reply',
      replyToProviderMessageId: 'd301abcdef01234567',
    })

    expect(capturedBody).toMatchObject({
      protocolChatId,
      text: 'durable reply',
      clientMessageId: 'client-reply',
      replyToProviderMessageId: 'd301abcdef01234567',
    })
  })

  it('rejects malformed queued dispatch identity', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => gatewayResponse(42)))
    await expect(sendPersonalMaxDurableText({ protocolChatId, text: 'invalid queue', clientMessageId: 'client-invalid' }))
      .rejects.toThrow('returned an invalid response')
  })

  it('requires an exact provider identity for a confirmed result', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      success: true,
      externalId: 'd301short',
      chatId: protocolChatId,
      deliveryConfirmed: true,
      deliveryStatus: 'accepted_by_max',
      dispatchId: 'dispatch-confirmed',
      idempotent: false,
    }), { status: 200, headers: { 'content-type': 'application/json' } })))

    await expect(sendPersonalMaxDurableText({ protocolChatId, text: 'invalid confirmation', clientMessageId: 'client-invalid-confirmation' }))
      .rejects.toThrow('returned an invalid response')
  })

  it('rejects a claimed confirmed status when confirmation evidence is false', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      success: true,
      externalId: 'd301abcdef01234567',
      chatId: protocolChatId,
      deliveryConfirmed: false,
      deliveryStatus: 'accepted_by_max',
      dispatchId: 'dispatch-unconfirmed',
      idempotent: false,
    }), { status: 200, headers: { 'content-type': 'application/json' } })))

    await expect(sendPersonalMaxDurableText({ protocolChatId, text: 'unproven confirmation', clientMessageId: 'client-unproven-confirmation' }))
      .rejects.toThrow('returned an invalid response')
  })
})
