import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, test, vi } from 'vitest'

/**
 * «Проверить» (V2 W5; MSR criteria): the write authority first, ids only, the
 * number resolved by Contacts, and an answer that never carries the number.
 */
const mocks = vi.hoisted(() => ({ writer: vi.fn(), target: vi.fn(), check: vi.fn() }))
vi.mock('@/modules/contacts/public/v1', () => ({
  resolveContactWriteAuthorityV1: mocks.writer,
  readContactReachabilityTargetV1: mocks.target,
}))
vi.mock('@/modules/messaging/public/v1/channel-reachability', async importOriginal => ({
  ...await importOriginal<typeof import('@/modules/messaging/public/v1/channel-reachability')>(),
  checkChannelReachabilityV1: mocks.check,
}))

import { POST } from './route'

const context = { params: Promise.resolve({ id: 'contact-1' }) }
const STAFF = { decision: 'allow', principal: { kind: 'staff_session', userId: 'u1', role: 'Менеджер' }, actor: 'staff:u1', policyVersion: 'contacts.write-authority.v1' }
const BINDING = { identityId: 'identity-1', contactId: 'contact-1', providerAccountId: 'wa-account-1' }

function post(body: unknown, { origin = 'https://crm.example', type = 'application/json' } = {}) {
  return new NextRequest('https://crm.example/contacts/contact-1/reachability', {
    method: 'POST',
    headers: { 'content-type': type, host: 'crm.example', origin },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

describe('POST /contacts/:id/reachability', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.writer.mockResolvedValue(STAFF)
    mocks.target.mockResolvedValue({ status: 'found', phone: '+79991000101', exactBinding: BINDING })
    mocks.check.mockResolvedValue({
      status: 'confirmed', reachable: true, confirmed: true, retryable: false, channel: 'whatsapp',
      providerAccountId: 'wa-account-1', providerTargetId: '79991000101@s.whatsapp.net', source: 'whatsapp', error: 'note +79991000101',
    })
  })

  test('cross-site and non-JSON requests are refused before the authority is asked', async () => {
    expect((await POST(post({ channel: 'whatsapp', phoneId: 'p1' }, { origin: 'https://evil.example' }), context)).status).toBe(403)
    expect((await POST(post('channel=whatsapp', { type: 'application/x-www-form-urlencoded' }), context)).status).toBe(403)
    expect(mocks.writer).not.toHaveBeenCalled()
  })

  test('a denied writer (no session, a mobile session, ENFORCE) is 401 and nothing is resolved or checked', async () => {
    for (const reason of ['no_session', 'staff_session_refused', 'transitional_admin_write_disabled']) {
      mocks.writer.mockResolvedValueOnce({ decision: 'deny', reason })
      expect((await POST(post({ channel: 'whatsapp', phoneId: 'p1' }), context)).status).toBe(401)
    }
    expect(mocks.target).not.toHaveBeenCalled()
    expect(mocks.check).not.toHaveBeenCalled()
  })

  test('a raw phone in the body is refused, even beside ids', async () => {
    for (const body of [{ channel: 'whatsapp', phone: '+79991000101' }, { channel: 'whatsapp', phoneId: 'p1', phone: '+79990000000' }]) {
      const response = await POST(post(body), context)
      expect(response.status).toBe(400)
      expect((await response.json()).code).toBe('RAW_PHONE_REFUSED')
    }
    expect(mocks.target).not.toHaveBeenCalled()
  })

  test('an unknown channel, no id or a malformed id is 400', async () => {
    for (const body of [{ channel: 'sms', phoneId: 'p1' }, { channel: 'whatsapp' }, { channel: 'whatsapp', phoneId: '' }, { channel: 'whatsapp', identityId: 7 }, [], 'nope']) {
      expect((await POST(post(body), context)).status).toBe(400)
    }
    expect(mocks.target).not.toHaveBeenCalled()
  })

  test('the number comes from Contacts for this Contact\'s own ids, and a phone or account of someone else is 404', async () => {
    await POST(post({ channel: 'whatsapp', phoneId: 'p1', identityId: 'identity-1' }), context)
    expect(mocks.target).toHaveBeenCalledWith({ contactId: 'contact-1', channel: 'whatsapp', phoneId: 'p1', identityId: 'identity-1' })
    expect(mocks.check).toHaveBeenCalledWith('whatsapp', '+79991000101', BINDING)
    mocks.target.mockResolvedValueOnce({ status: 'not_found' })
    expect((await POST(post({ channel: 'whatsapp', phoneId: 'someone-elses' }), context)).status).toBe(404)
  })

  test('the answer is reachability only: no number, no provider target, no provider text', async () => {
    const response = await POST(post({ channel: 'whatsapp', phoneId: 'p1' }), context)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const body = await response.json()
    expect(body).toEqual({ channel: 'whatsapp', status: 'confirmed', reachable: true, confirmed: true, retryable: false })
    expect(JSON.stringify(body)).not.toMatch(/7999100|whatsapp\.net/u)
  })

  test('a failed check answers «checking» and logs no number', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    mocks.check.mockRejectedValueOnce(new Error('provider down for +79991000101'))
    const response = await POST(post({ channel: 'telegram', phoneId: 'p1' }), context)
    expect(await response.json()).toMatchObject({ channel: 'telegram', status: 'checking', retryable: true })
    expect(JSON.stringify(log.mock.calls)).not.toContain('79991000101')
    log.mockRestore()
  })
})
