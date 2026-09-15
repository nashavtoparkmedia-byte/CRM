import { describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ settingsRead: vi.fn() }))
vi.mock('@/lib/prisma', () => ({
  prisma: { avito_app_settings: { findMany: mocks.settingsRead } },
}))

import { POST } from './route'

describe('Avito Telegram settings test send', () => {
  test('is retired before credential reads or provider mutation', async () => {
    const providerFetch = vi.fn()
    vi.stubGlobal('fetch', providerFetch)

    const response = await POST()

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      code: 'CONTACT_CONVERSATION_IDENTITY_REQUIRED',
    })
    expect(mocks.settingsRead).not.toHaveBeenCalled()
    expect(providerFetch).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})
