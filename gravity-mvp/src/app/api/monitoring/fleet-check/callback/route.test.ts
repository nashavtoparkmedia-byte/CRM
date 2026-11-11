import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const prismaMock = vi.hoisted(() => ({
  driver: { findUnique: vi.fn(), update: vi.fn() },
  driverEvent: { create: vi.fn() },
  $transaction: vi.fn(),
}))
vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }))

import { POST } from './route'

const SECRET = 'q7Rk2Zp9Lm4Xv8Tn3Wb6Yc1Hd5Fg0Js2Ue7Ia9Ko3'
const URL = 'http://crm.local/api/monitoring/fleet-check/callback'
const body = { checkId: 'check-1', driverId: 'driver-1', status: 'SUCCESS', result: { otherParks: [] } }

function request(headers: Record<string, string>, payload: unknown = body): NextRequest {
  return new NextRequest(URL, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof payload === 'string' ? payload : JSON.stringify(payload) })
}

describe('POST /api/monitoring/fleet-check/callback', () => {
  let before: string | undefined
  beforeEach(() => {
    before = process.env.FLEET_CHECK_CALLBACK_SECRET
    vi.clearAllMocks()
    prismaMock.driver.findUnique.mockResolvedValue({ id: 'driver-1', lastFleetCheckId: 'check-1' })
    prismaMock.$transaction.mockImplementation(async (work: (tx: typeof prismaMock) => Promise<unknown>) => work(prismaMock))
  })
  afterEach(() => {
    if (before === undefined) delete process.env.FLEET_CHECK_CALLBACK_SECRET
    else process.env.FLEET_CHECK_CALLBACK_SECRET = before
  })

  it('answers 503 and reads nothing while the CRM has no secret', async () => {
    delete process.env.FLEET_CHECK_CALLBACK_SECRET
    const response = await POST(request({ 'x-fleet-check-secret': SECRET }))
    expect(response.status).toBe(503)
    expect(JSON.stringify(await response.json())).not.toContain(SECRET)
    expect(prismaMock.driver.findUnique).not.toHaveBeenCalled()
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
  })

  it('answers 401 and reads nothing without the right secret', async () => {
    process.env.FLEET_CHECK_CALLBACK_SECRET = SECRET
    for (const headers of [{}, { 'x-fleet-check-secret': '' }, { 'x-fleet-check-secret': `${SECRET}x` }, { authorization: `Bearer ${SECRET}` }]) {
      const response = await POST(request(headers))
      expect(response.status).toBe(401)
      expect(await response.json()).toEqual({ error: 'unauthorized' })
    }
    expect(prismaMock.driver.findUnique).not.toHaveBeenCalled()
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
  })

  it('refuses before reading the body: an unauthorized malformed body is still 401', async () => {
    process.env.FLEET_CHECK_CALLBACK_SECRET = SECRET
    expect((await POST(request({}, '{not json'))).status).toBe(401)
    expect((await POST(request({ 'x-fleet-check-secret': SECRET }, '{not json'))).status).toBe(400)
  })

  it('records the result with the right secret, as before', async () => {
    process.env.FLEET_CHECK_CALLBACK_SECRET = SECRET
    const response = await POST(request({ 'x-fleet-check-secret': SECRET }))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, status: 'completed' })
    expect(prismaMock.driver.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'driver-1' } }))
    expect(prismaMock.driverEvent.create).toHaveBeenCalledTimes(1)
  })
})
