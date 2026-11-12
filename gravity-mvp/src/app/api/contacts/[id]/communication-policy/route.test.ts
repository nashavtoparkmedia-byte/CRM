import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, test, vi } from 'vitest'

/**
 * «Ограничения связи» route (V2 Q4, Security W1/W3/W4): the write authority
 * first, the actor only from its answer, a required reason, 409 on a stale
 * version, and no-store on every answer of the card's reads.
 */
const mocks = vi.hoisted(() => ({
  writer: vi.fn(),
  reader: vi.fn(),
  set: vi.fn(),
  read: vi.fn(),
}))

vi.mock('@/modules/contacts/public/v1', () => ({
  resolveContactWriteAuthorityV1: mocks.writer,
  resolveContactReadAuthorityV1: mocks.reader,
}))
vi.mock('@/modules/contacts/application/contact-operations', () => ({
  setContactCommunicationPolicyV1: mocks.set,
  readContactCommunicationRestrictionV1: mocks.read,
}))

import { GET, POST } from './route'

const context = { params: Promise.resolve({ id: 'contact-1' }) }
const STAFF = { decision: 'allow', principal: { kind: 'staff_session', userId: 'u1', role: 'Менеджер' }, actor: 'staff:u1', policyVersion: 'contacts.write-authority.v1' }
const VOICE = { denyAll: false, denyMessage: false, denyVoice: true }
const NONE = { denyAll: false, denyMessage: false, denyVoice: false }

function post(body: unknown, { origin = 'https://crm.example', type = 'application/json' } = {}) {
  return new NextRequest('https://crm.example/api/contacts/contact-1/communication-policy', {
    method: 'POST',
    headers: { 'content-type': type, host: 'crm.example', origin, 'x-crm-user-id': 'forged-header-actor', cookie: 'crm_user_id=forged-cookie-actor' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

const valid = (overrides: Record<string, unknown> = {}) => ({
  requestId: 'req-1', expectedVersion: 0, restriction: VOICE, reason: 'просил не звонить', ...overrides,
})

describe('POST /api/contacts/:id/communication-policy', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.writer.mockResolvedValue(STAFF)
    mocks.set.mockResolvedValue({ contract: 'contacts.SetContactCommunicationPolicyResult.v1', status: 'applied', contactId: 'contact-1', version: 1, restriction: VOICE })
  })

  test('a cross-site or non-JSON request is refused before the authority is asked', async () => {
    expect((await POST(post(valid(), { origin: 'https://evil.example' }), context)).status).toBe(403)
    expect((await POST(post('requestId=x', { type: 'application/x-www-form-urlencoded' }), context)).status).toBe(403)
    expect(mocks.writer).not.toHaveBeenCalled()
    expect(mocks.set).not.toHaveBeenCalled()
  })

  test('a request the write authority denies answers 401 and changes nothing', async () => {
    for (const reason of ['no_session', 'staff_session_refused', 'transitional_admin_write_disabled']) {
      mocks.writer.mockResolvedValueOnce({ decision: 'deny', reason })
      const response = await POST(post(valid()), context)
      expect(response.status).toBe(401)
      expect(await response.json()).toEqual({ error: 'Unauthorized' })
    }
    expect(mocks.set).not.toHaveBeenCalled()
  })

  test('the recorded actor is the authority\'s answer; an actor in the body, a header or crm_user_id is ignored', async () => {
    const response = await POST(post(valid({ actor: 'forged-body-actor', mergedBy: 'x', contactId: 'other-contact' })), context)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({ status: 'applied', version: 1, restriction: VOICE })
    expect(mocks.set).toHaveBeenCalledTimes(1)
    expect(mocks.set).toHaveBeenCalledWith({
      contract: 'contacts.SetContactCommunicationPolicyCommand.v1',
      requestId: 'req-1',
      contactId: 'contact-1',
      expectedVersion: 0,
      restriction: VOICE,
      actor: 'staff:u1',
      reason: 'просил не звонить',
    })
  })

  test('a lift is the same command with the flags off', async () => {
    mocks.set.mockResolvedValueOnce({ contract: 'contacts.SetContactCommunicationPolicyResult.v1', status: 'applied', contactId: 'contact-1', version: 2, restriction: NONE })
    const response = await POST(post(valid({ requestId: 'req-2', expectedVersion: 1, restriction: NONE, reason: 'разрешил снова' })), context)
    expect(response.status).toBe(200)
    expect(mocks.set).toHaveBeenCalledWith(expect.objectContaining({ expectedVersion: 1, restriction: NONE, actor: 'staff:u1', reason: 'разрешил снова' }))
  })

  test('a missing or blank reason, a partial state or a bad version is 400 and never reaches Contacts', async () => {
    for (const body of [
      valid({ reason: '' }), valid({ reason: '   ' }), { ...valid(), reason: undefined },
      valid({ restriction: { denyAll: true } }), valid({ restriction: { ...VOICE, denyAll: 'yes' } }),
      valid({ expectedVersion: -1 }), valid({ expectedVersion: 1.5 }), valid({ requestId: 7 }), 'not json', [],
    ]) {
      const response = await POST(post(body), context)
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ error: 'Bad Request', code: 'INVALID_RESTRICTION_REQUEST' })
    }
    expect(mocks.set).not.toHaveBeenCalled()
  })

  test('a stale version is 409 with the current version; a reused request id and a merged Contact are 409 too', async () => {
    mocks.set.mockResolvedValueOnce({ contract: 'x', status: 'version_conflict', contactId: 'contact-1', expectedVersion: 0, currentVersion: 3 })
    let response = await POST(post(valid()), context)
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: 'Conflict', code: 'VERSION_CONFLICT', currentVersion: 3 })
    mocks.set.mockResolvedValueOnce({ contract: 'x', status: 'idempotency_conflict', contactId: 'contact-1', requestId: 'req-1' })
    response = await POST(post(valid()), context)
    expect([response.status, (await response.json()).code]).toEqual([409, 'REQUEST_ID_REUSED'])
    mocks.set.mockResolvedValueOnce({ contract: 'x', status: 'contact_not_canonical', contactId: 'contact-1', canonicalContactId: 'contact-2' })
    response = await POST(post(valid()), context)
    expect(await response.json()).toEqual({ error: 'Conflict', code: 'CONTACT_MERGED', canonicalContactId: 'contact-2' })
    mocks.set.mockResolvedValueOnce({ contract: 'x', status: 'contact_not_found', contactId: 'contact-1' })
    expect((await POST(post(valid()), context)).status).toBe(404)
  })

  test('a failure answers 503 and logs no reason text', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    mocks.set.mockRejectedValueOnce(new Error('db down: просил не звонить'))
    expect((await POST(post(valid()), context)).status).toBe(503)
    expect(JSON.stringify(log.mock.calls)).not.toContain('просил')
    log.mockRestore()
  })
})

describe('GET /api/contacts/:id/communication-policy', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.reader.mockResolvedValue({ decision: 'allow', principal: { kind: 'staff_session', userId: 'u1', role: 'Менеджер' }, licenceView: 'full', policyVersion: 'x' })
  })

  test('a reader sees the current state and version, never cached', async () => {
    mocks.read.mockResolvedValueOnce({ status: 'found', canonicalContactId: 'contact-1', isArchived: false, version: 2, restriction: VOICE })
    const response = await GET(new NextRequest('https://crm.example/api/contacts/contact-1/communication-policy'), context)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({ status: 'found', canonicalContactId: 'contact-1', isArchived: false, version: 2, restriction: VOICE })
  })

  test('no reader: 401 without reading; unknown Contact: 404', async () => {
    mocks.reader.mockResolvedValueOnce({ decision: 'deny', reason: 'no_session' })
    const denied = await GET(new NextRequest('https://crm.example/api/contacts/contact-1/communication-policy'), context)
    expect([denied.status, denied.headers.get('cache-control')]).toEqual([401, 'no-store'])
    expect(mocks.read).not.toHaveBeenCalled()
    mocks.read.mockResolvedValueOnce({ status: 'unknown' })
    expect((await GET(new NextRequest('https://crm.example/api/contacts/contact-1/communication-policy'), context)).status).toBe(404)
  })
})
