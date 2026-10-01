import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, test, vi } from 'vitest'

/**
 * Security and mapping proof for the bounded repair entry point.
 *
 * These tests exercise the real route, not the capability directly, so the
 * authenticated integration-admin requirement, the same-origin requirement, the
 * request mapping and the fail-closed behaviour are all proven at the surface a
 * future production execution will actually call.
 */

const mocks = vi.hoisted(() => {
  // Declared inside the hoisted block: `vi.mock` factories are lifted above
  // module-level declarations, so a top-level class would not yet exist.
  class RefusalV1 extends Error {
    readonly reason: string
    constructor(reason: string, message: string) {
      super(message)
      this.name = 'RepairTelegramConversationPersonBindingRefusalV1'
      this.reason = reason
    }
  }
  return {
    principal: vi.fn(),
    sameOrigin: vi.fn(),
    run: vi.fn(),
    before: vi.fn(),
    resolveTelegramId: vi.fn(),
    RefusalV1,
  }
})

const RefusalV1 = mocks.RefusalV1

vi.mock('@/modules/contacts/public/v1', () => ({
  RepairTelegramConversationPersonBindingRefusalV1: mocks.RefusalV1,
}))
vi.mock('@/modules/identity-access/public/v1', () => ({
  getIntegrationAdminPrincipal: mocks.principal,
  isExactSameOriginMutationRequest: mocks.sameOrigin,
}))
vi.mock('@/infrastructure/telegram-conversation-person-binding-repair-composition', () => ({
  runTelegramConversationPersonBindingRepairV1: mocks.run,
  readTelegramPersonBindingRepairBeforeStateV1: mocks.before,
  resolveDuplicateTelegramExternalIdV1: mocks.resolveTelegramId,
}))

import { POST } from './route'

const CANONICAL = 'contact-canonical'
const DUPLICATE = 'contact-duplicate'
const DRIVER = 'driver-representative'

function post(body: unknown, id = CANONICAL) {
  const request = new NextRequest('https://crm.test/api/contacts/x/telegram-person-binding-repair', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  })
  return POST(request, { params: Promise.resolve({ id }) })
}

const validBody = { duplicateContactId: DUPLICATE, representativeDriverId: DRIVER }

beforeEach(() => {
  vi.clearAllMocks()
  mocks.sameOrigin.mockReturnValue(true)
  mocks.principal.mockResolvedValue({ id: 'operator-1' })
  mocks.resolveTelegramId.mockResolvedValue({ externalId: '316425068' })
  mocks.before.mockResolvedValue({ canonicalContact: { id: CANONICAL }, hasMergeRelation: false })
  mocks.run.mockResolvedValue({
    status: 'repaired',
    survivorContactId: CANONICAL,
    mergedContactId: DUPLICATE,
    chatId: 'chat-1',
    driverId: DRIVER,
    confirmationId: 'confirmation-1',
  })
})

function expectZeroMutation() {
  expect(mocks.run).not.toHaveBeenCalled()
}

describe('POST /api/contacts/:id/telegram-person-binding-repair — security', () => {
  test('refuses a cross-origin mutation with zero mutation', async () => {
    mocks.sameOrigin.mockReturnValue(false)
    const response = await post(validBody)
    expect(response.status).toBe(403)
    expectZeroMutation()
  })

  test('refuses an unauthenticated caller with zero mutation', async () => {
    mocks.principal.mockResolvedValue(null)
    const response = await post(validBody)
    expect(response.status).toBe(401)
    expectZeroMutation()
  })

  test('checks origin before identity, so an unauthenticated cross-origin call never reaches auth', async () => {
    mocks.sameOrigin.mockReturnValue(false)
    mocks.principal.mockResolvedValue(null)
    const response = await post(validBody)
    expect(response.status).toBe(403)
    expect(mocks.principal).not.toHaveBeenCalled()
    expectZeroMutation()
  })
})

describe('POST /api/contacts/:id/telegram-person-binding-repair — input mapping', () => {
  test('maps the three explicit ids and the proven actor into the capability', async () => {
    const response = await post(validBody)
    expect(response.status).toBe(200)
    expect(mocks.run).toHaveBeenCalledWith({
      canonicalContactId: CANONICAL,
      duplicateContactId: DUPLICATE,
      representativeDriverId: DRIVER,
      telegramExternalId: '316425068',
      actorId: 'operator-1',
    })
    await expect(response.json()).resolves.toMatchObject({ status: 'REPAIRED', irreversible: true })
  })

  test('derives the Telegram peer id rather than accepting it from the caller', async () => {
    await post({ ...validBody, telegramExternalId: '999999' })
    // Both ids are passed: before the repair the identity belongs to the
    // duplicate, and after phase 1 the merge has moved it to the canonical
    // Contact, which a resuming retry must still be able to resolve.
    expect(mocks.resolveTelegramId).toHaveBeenCalledWith(DUPLICATE, CANONICAL)
    expect(mocks.run).toHaveBeenCalledWith(expect.objectContaining({ telegramExternalId: '316425068' }))
  })

  test('refuses malformed input with zero mutation', async () => {
    for (const body of [
      {},
      { duplicateContactId: DUPLICATE },
      { representativeDriverId: DRIVER },
      { duplicateContactId: '', representativeDriverId: DRIVER },
      { duplicateContactId: DUPLICATE, representativeDriverId: '  ' },
    ]) {
      vi.clearAllMocks()
      mocks.sameOrigin.mockReturnValue(true)
      mocks.principal.mockResolvedValue({ id: 'operator-1' })
      const response = await post(body)
      expect(response.status).toBe(400)
      await expect(response.json()).resolves.toMatchObject({
        status: 'PRECONDITION_FAILED', reason: 'INPUT_INVALID',
      })
      expectZeroMutation()
    }
  })

  test('refuses a self merge with zero mutation', async () => {
    const response = await post({ duplicateContactId: CANONICAL, representativeDriverId: DRIVER })
    expect(response.status).toBe(400)
    expectZeroMutation()
  })

  test('refuses when the duplicate has no single active Telegram identity', async () => {
    for (const error of ['NO_TELEGRAM_IDENTITY', 'AMBIGUOUS_TELEGRAM_IDENTITY'] as const) {
      vi.clearAllMocks()
      mocks.sameOrigin.mockReturnValue(true)
      mocks.principal.mockResolvedValue({ id: 'operator-1' })
      mocks.resolveTelegramId.mockResolvedValue({ error })
      const response = await post(validBody)
      expect(response.status).toBe(409)
      await expect(response.json()).resolves.toMatchObject({ status: 'PRECONDITION_FAILED', reason: error })
      expectZeroMutation()
    }
  })
})

describe('POST /api/contacts/:id/telegram-person-binding-repair — two-phase states', () => {
  test('REPAIRED carries the audit snapshot and the irreversible marker', async () => {
    const response = await post(validBody)
    const payload = await response.json()
    expect(payload.status).toBe('REPAIRED')
    expect(payload.irreversible).toBe(true)
    expect(payload.before).toBeDefined()
  })

  test('ALREADY_REPAIRED is a 200 no-op', async () => {
    mocks.run.mockResolvedValue({
      status: 'already_repaired', survivorContactId: CANONICAL, chatId: 'chat-1', driverId: DRIVER,
    })
    const response = await post(validBody)
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ status: 'ALREADY_REPAIRED' })
  })

  test('PHASE_1_COMPLETE_CONFIRMATION_PENDING reports a resumable state, not a rollback', async () => {
    mocks.run.mockResolvedValue({
      status: 'merged_pending_confirmation',
      survivorContactId: CANONICAL,
      mergedContactId: DUPLICATE,
      chatId: 'chat-1',
      driverId: DRIVER,
      confirmationError: 'confirmation transaction aborted',
    })
    const response = await post(validBody)
    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      status: 'PHASE_1_COMPLETE_CONFIRMATION_PENDING',
      irreversible: true,
      retryResumesPhase2: true,
    })
  })

  test('a capability refusal becomes PRECONDITION_FAILED with the exact reason', async () => {
    mocks.run.mockRejectedValue(new RefusalV1('REPRESENTATIVE_DRIVER_PHONE_MISMATCH', 'phone mismatch'))
    const response = await post(validBody)
    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      status: 'PRECONDITION_FAILED', reason: 'REPRESENTATIVE_DRIVER_PHONE_MISMATCH',
    })
  })

  test('Fleet proof failure surfaces as a precondition failure, never a partial success', async () => {
    mocks.run.mockRejectedValue(new RefusalV1('FLEET_EVIDENCE_INCOMPLETE', 'fresh evidence required'))
    const response = await post(validBody)
    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({ reason: 'FLEET_EVIDENCE_INCOMPLETE' })
  })

  test('before-state drift surfaces as a precondition failure', async () => {
    for (const reason of ['TELEGRAM_CHAT_STATE_DRIFT', 'DRIVER_TELEGRAM_STATE_DRIFT']) {
      mocks.run.mockRejectedValue(new RefusalV1(reason, 'drift'))
      const response = await post(validBody)
      expect(response.status).toBe(409)
      await expect(response.json()).resolves.toMatchObject({ reason })
    }
  })

  test('an unexpected failure is a 500 and is not reported as a repair', async () => {
    mocks.run.mockRejectedValue(new Error('boom'))
    const response = await post(validBody)
    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toMatchObject({
      status: 'PRECONDITION_FAILED', reason: 'UNEXPECTED_FAILURE',
    })
  })
})

describe('POST /api/contacts/:id/telegram-person-binding-repair — no foreign-domain writes', () => {
  test('the route performs no persistence of its own', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/app/api/contacts/[id]/telegram-person-binding-repair/route.ts'),
      'utf8',
    )
    // Every mutation must be delegated: the route may not touch Prisma at all.
    expect(source).not.toMatch(/from '@\/lib\/prisma'/)
    expect(source).not.toMatch(/prisma\s*\./)
    expect(source).not.toMatch(/\$transaction/)
    // and it must not reach a generic merge surface directly
    expect(source).not.toMatch(/mergeContactsV1/)
    expect(source).not.toMatch(/ContactMergeService/)
  })
})
