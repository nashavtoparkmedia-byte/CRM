import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ recover: vi.fn() }))

vi.mock('@/infrastructure/contact-merge-composition', () => ({
  mergeContactsV1: { recover: mocks.recover },
}))

import { POST } from './route'

describe('automated Contact merge recovery route', () => {
  beforeEach(() => vi.clearAllMocks())

  test('reports an idempotent recovery replay as successful', async () => {
    mocks.recover.mockResolvedValue({
      status: 'already_recovered',
      mergeId: 'merge-1',
    })
    const response = await POST(
      new NextRequest('https://crm.example/api/contact-merges/merge-1/recover', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ requestedBy: 'operator:test' }),
      }),
      { params: Promise.resolve({ id: 'merge-1' }) },
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      status: 'already_recovered',
      mergeId: 'merge-1',
    })
  })
})
