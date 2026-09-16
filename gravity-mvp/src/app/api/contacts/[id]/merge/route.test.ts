import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ mergeContactToDriver: vi.fn() }))

vi.mock('@/lib/ContactMergeService', () => ({
  ContactMergeService: { mergeContactToDriver: mocks.mergeContactToDriver },
}))

import { POST } from './route'

describe('POST /api/contacts/[id]/merge', () => {
  it('retires proof-free Driver attachment without invoking the legacy mutation', async () => {
    const response = await POST(
      new Request('http://localhost/api/contacts/contact-1/merge', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ driverId: 'driver-1', mergedBy: 'manager-1' }),
      }) as never,
      { params: Promise.resolve({ id: 'contact-1' }) },
    )

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      code: 'DRIVER_PERSON_CONFIRMATION_REQUIRED',
    })
    expect(mocks.mergeContactToDriver).not.toHaveBeenCalled()
  })
})
