import { describe, expect, it, vi } from 'vitest'
import type {
  ContactCommunicationPermissionResultV1,
  ContactPersonCardPhoneV1,
  ContactPersonCardResultV1,
  ContactPersonCardV1,
} from '@/contracts/contacts/v1'
import {
  CANCEL_MANUAL_CALL_COMMAND_V1,
  MANUAL_CALL_AVAILABILITY_QUERY_V1,
  ManualCallContractError,
  START_MANUAL_CALL_COMMAND_V1,
} from '@/contracts/calling/v1/manual-call'
import {
  createManualCallOperations,
  manualCallIdentityV1,
  ManualDialOutcomeUnknownError,
  ManualDialRejectedError,
  ManualDialUnavailableError,
  type ManualCallClaimResult,
  type ManualCallDispatchState,
  type ManualCallPorts,
  type ManualCallRecord,
} from './manual-call'

const CONTACT = 'contact-anna'
const PHONE_ID = 'phone-anna-1'
const E164 = '+79161110001'

function phone(overrides: Partial<ContactPersonCardPhoneV1> = {}): ContactPersonCardPhoneV1 {
  return {
    phoneId: PHONE_ID, phone: E164, isPrimary: true, isActive: true, lifecycle: 'current', trust: 'unknown',
    freshness: 'unknown', resolutionState: 'unique', verifiedAt: null, lastSeenAt: null, ...overrides,
  }
}

function card(overrides: Partial<ContactPersonCardV1> = {}): ContactPersonCardV1 {
  return {
    contactId: CONTACT, displayName: 'Анна', displayTitle: 'Анна', primaryPhone: E164, displayNameSource: 'manual',
    source: 'manual',
    personConfirmation: { status: 'unconfirmed' } as unknown as ContactPersonCardV1['personConfirmation'],
    mainDriverId: null, legacyYandexDriverId: null, phones: [phone()], channels: [],
    lineage: { canonicalContactId: CONTACT, contactIds: [CONTACT], mergedFromCount: 0, mergeHistory: [] },
    conflicts: [], hasOpenConflict: false, hasPersonBlockingConflict: false, candidates: [],
    automation: { doNotMerge: false, canonicalPinned: false, mergeRecoveryState: null }, isArchived: false, ...overrides,
  }
}

const confirmed = (value: ContactPersonCardV1 = card()): ContactPersonCardResultV1 =>
  ({ contract: 'contacts.ContactPersonCardResult.v1', status: 'confirmed', card: value } as unknown as ContactPersonCardResultV1)

function permission(overrides: Partial<ContactCommunicationPermissionResultV1> = {}): ContactCommunicationPermissionResultV1 {
  return {
    contract: 'contacts.ContactCommunicationPermissionResult.v1', decision: 'allow', retryable: false, reason: 'no_restriction',
    requestedContactId: CONTACT, communicationClass: 'voice', canonicalContactId: CONTACT, policyVersion: 0, ...overrides,
  } as ContactCommunicationPermissionResultV1
}

/** A store with the real claim semantics: replay by id, busy per Contact or employee while a call is live. */
function memoryStore() {
  const rows = new Map<string, ManualCallRecord & { dispatch: ManualCallDispatchState; live: boolean }>()
  const store = {
    rows,
    claim: vi.fn(async (record: ManualCallRecord): Promise<ManualCallClaimResult> => {
      const existing = rows.get(record.callId)
      if (existing) return { kind: 'existing', payloadDigest: existing.payloadDigest, dispatch: existing.dispatch }
      for (const row of rows.values()) {
        if (row.live && (row.contactId === record.contactId || row.staffUserId === record.staffUserId)) return { kind: 'busy' }
      }
      rows.set(record.callId, { ...record, dispatch: 'claimed', live: true })
      return { kind: 'claimed' }
    }),
    settle: vi.fn(async (callId: string, dispatch: Exclude<ManualCallDispatchState, 'claimed'>) => {
      const row = rows.get(callId)
      if (row) { row.dispatch = dispatch; if (dispatch === 'rejected' || dispatch === 'unavailable') row.live = false }
    }),
    findByFsUuid: vi.fn(async (fsUuid: string) => {
      for (const row of rows.values()) if (row.fsUuid === fsUuid) return { callId: row.callId, staffUserId: row.staffUserId, active: row.live }
      return null
    }),
  }
  return store
}

function setup(overrides: Partial<ManualCallPorts> = {}) {
  const store = memoryStore()
  const dial = { originate: vi.fn(async () => {}), cancel: vi.fn(async () => {}) }
  const ports: ManualCallPorts = {
    principal: vi.fn(async () => ({ userId: 'u1', role: 'Менеджер' })),
    extensionFor: vi.fn(() => '101'),
    readPerson: vi.fn(async () => confirmed()),
    voicePermission: vi.fn(async () => permission()),
    store,
    dial,
    now: () => new Date('2026-11-11T09:00:00.000Z'),
    ...overrides,
  }
  return { ops: createManualCallOperations(ports), ports, store, dial }
}

const start = (requestId = 'request-0001', extra: Record<string, unknown> = {}) =>
  ({ contract: START_MANUAL_CALL_COMMAND_V1, requestId, contactId: CONTACT, phoneId: PHONE_ID, ...extra })

describe('manual call: admitted only through the whole verified-destination policy', () => {
  it('dials the Contact’s own number from Contacts, with the server-side extension of the signed employee', async () => {
    const { ops, dial } = setup()
    const result = await ops.start(start())
    const identity = manualCallIdentityV1('request-0001')
    expect(result).toEqual({ contract: 'calling.StartManualCallResult.v1', status: 'admitted', callId: identity.callId, fsUuid: identity.fsUuid, replay: false })
    expect(dial.originate).toHaveBeenCalledTimes(1)
    expect(dial.originate).toHaveBeenCalledWith({ fsUuid: identity.fsUuid, e164: E164, extension: '101', staffUserId: 'u1' })
  })

  it('an ordinary call does not need «Личность подтверждена» (Owner Q2), only the canonical Contact and its unique number', async () => {
    const { ops, dial } = setup()
    await expect(ops.start(start())).resolves.toMatchObject({ status: 'admitted' })
    expect(dial.originate).toHaveBeenCalledTimes(1)
  })

  it.each(['Менеджер', 'Руководитель', 'Администратор'])('role %s may call (Owner Q3)', async role => {
    const { ops, dial } = setup({ principal: async () => ({ userId: 'u1', role }) })
    await expect(ops.start(start())).resolves.toMatchObject({ status: 'admitted' })
    expect(dial.originate).toHaveBeenCalledTimes(1)
  })

  it('records the claim before it dials, and settles it as accepted after', async () => {
    const order: string[] = []
    const { ops, store, dial } = setup()
    store.claim.mockImplementationOnce(async () => { order.push('claim'); return { kind: 'claimed' } })
    dial.originate.mockImplementationOnce(async () => { order.push('dial') })
    store.settle.mockImplementationOnce(async () => { order.push('settle') })
    await ops.start(start())
    expect(order).toEqual(['claim', 'dial', 'settle'])
    expect(store.settle).toHaveBeenCalledWith(manualCallIdentityV1('request-0001').callId, 'accepted')
  })

  it('reads the voice permission after the Contact and before the claim', async () => {
    const order: string[] = []
    const { ops, ports, store } = setup()
    vi.mocked(ports.readPerson).mockImplementation(async () => { order.push('person'); return confirmed() })
    vi.mocked(ports.voicePermission).mockImplementation(async () => { order.push('permission'); return permission() })
    store.claim.mockImplementationOnce(async () => { order.push('claim'); return { kind: 'claimed' } })
    await ops.start(start())
    expect(order).toEqual(['person', 'permission', 'claim'])
  })
})

describe('manual call: every refusal reaches neither the claim nor the dialler', () => {
  type Case = [name: string, overrides: () => Partial<ManualCallPorts>, reason: string, retryable: boolean]
  const cases: Case[] = [
    ['no signed Staff Session (legacy cookie only)', () => ({ principal: async () => null }), 'staff_not_authenticated', false],
    ['a role that may not call', () => ({ principal: async () => ({ userId: 'u1', role: 'Стажёр' }) }), 'staff_not_authorized', false],
    ['no extension assigned to the employee', () => ({ extensionFor: () => null }), 'no_extension', false],
    ['an extension that is not a plain number', () => ({ extensionFor: () => '101,crm_user_id=u9' }), 'no_extension', false],
    ['an unknown Contact', () => ({ readPerson: async () => ({ status: 'missing' } as ContactPersonCardResultV1) }), 'contact_unknown', false],
    ['a forbidden Contact', () => ({ readPerson: async () => ({ status: 'forbidden' } as ContactPersonCardResultV1) }), 'contact_unknown', false],
    ['a merged-away Contact', () => ({ readPerson: async () => ({ status: 'redirected', canonicalContactId: 'other' } as ContactPersonCardResultV1) }), 'contact_redirected', false],
    ['a card for another Contact id', () => ({ readPerson: async () => confirmed(card({ contactId: 'other' })) }), 'contact_unknown', false],
    ['an archived Contact', () => ({ readPerson: async () => confirmed(card({ isArchived: true })) }), 'contact_archived', false],
    ['Contacts unavailable', () => ({ readPerson: async () => { throw new Error('db down') } }), 'contact_unavailable', true],
    ['a phone id that is not this Contact’s (number substitution)', () => ({ readPerson: async () => confirmed(card({ phones: [phone({ phoneId: 'someone-else' })] })) }), 'no_verified_number', false],
    ['a shared number', () => ({ readPerson: async () => confirmed(card({ phones: [phone({ resolutionState: 'shared' })] })) }), 'no_verified_number', false],
    ['a disputed number', () => ({ readPerson: async () => confirmed(card({ phones: [phone({ resolutionState: 'disputed' })] })) }), 'no_verified_number', false],
    ['a number of unknown ownership', () => ({ readPerson: async () => confirmed(card({ phones: [phone({ resolutionState: 'unknown' })] })) }), 'no_verified_number', false],
    ['a superseded number', () => ({ readPerson: async () => confirmed(card({ phones: [phone({ lifecycle: 'superseded' })] })) }), 'no_verified_number', false],
    ['an inactive number', () => ({ readPerson: async () => confirmed(card({ phones: [phone({ isActive: false })] })) }), 'no_verified_number', false],
    ['a stored number that is not strict E.164', () => ({ readPerson: async () => confirmed(card({ phones: [phone({ phone: '+7 916 111-00-01' })] })) }), 'no_verified_number', false],
    ['denyVoice', () => ({ voicePermission: async () => permission({ decision: 'deny', reason: 'restricted_voice' }) }), 'voice_denied', false],
    ['denyAll', () => ({ voicePermission: async () => permission({ decision: 'deny', reason: 'restricted_all' }) }), 'all_denied', false],
    ['the permission store unavailable', () => ({ voicePermission: async () => permission({ decision: 'deny', reason: 'policy_unavailable', retryable: true, canonicalContactId: null }) }), 'permission_unavailable', true],
    ['the permission service throwing', () => ({ voicePermission: async () => { throw new Error('timeout') } }), 'permission_unavailable', true],
    ['unsafe Contact lineage', () => ({ voicePermission: async () => permission({ decision: 'deny', reason: 'lineage_unsafe' }) }), 'contact_unknown', false],
    ['an allow decided for another canonical Contact', () => ({ voicePermission: async () => permission({ canonicalContactId: 'other' }) }), 'contact_unknown', false],
  ]

  it.each(cases)('%s', async (_name, overrides, reason, retryable) => {
    const { ops, store, dial } = setup(overrides())
    await expect(ops.start(start())).resolves.toEqual({ contract: 'calling.StartManualCallResult.v1', status: 'refused', reason, retryable })
    expect(store.claim).not.toHaveBeenCalled()
    expect(dial.originate).not.toHaveBeenCalled()
  })

  it('a raw phone number in the command is rejected by the contract before anything is read', async () => {
    const { ops, ports, store, dial } = setup()
    await expect(ops.start(start('request-0001', { phoneNumber: '+79990000000' }))).rejects.toBeInstanceOf(ManualCallContractError)
    expect(ports.principal).not.toHaveBeenCalled()
    expect(store.claim).not.toHaveBeenCalled()
    expect(dial.originate).not.toHaveBeenCalled()
  })
})

describe('manual call: one requestId, one call; no redial after an unknown outcome', () => {
  it('a replay of the same request returns the same call and never dials twice', async () => {
    const { ops, dial } = setup()
    await ops.start(start())
    await expect(ops.start(start())).resolves.toMatchObject({ status: 'admitted', replay: true })
    expect(dial.originate).toHaveBeenCalledTimes(1)
  })

  it('the same requestId with a different payload conflicts and dials nothing', async () => {
    const { ops, ports, dial } = setup()
    await ops.start(start())
    vi.mocked(ports.readPerson).mockResolvedValue(confirmed(card({ phones: [phone(), phone({ phoneId: 'phone-anna-2', phone: '+79161110009', isPrimary: false })] })))
    await expect(ops.start(start('request-0001', { phoneId: 'phone-anna-2' }))).resolves.toMatchObject({ status: 'refused', reason: 'request_conflict' })
    expect(dial.originate).toHaveBeenCalledTimes(1)
  })

  it('another employee reusing a requestId conflicts instead of replaying someone else’s call', async () => {
    const { ops, ports, dial } = setup()
    await ops.start(start())
    vi.mocked(ports.principal).mockResolvedValue({ userId: 'u2', role: 'Менеджер' })
    await expect(ops.start(start())).resolves.toMatchObject({ status: 'refused', reason: 'request_conflict' })
    expect(dial.originate).toHaveBeenCalledTimes(1)
  })

  it('two concurrent presses with one requestId place exactly one call', async () => {
    const { ops, dial } = setup()
    const results = await Promise.all([ops.start(start()), ops.start(start())])
    expect(dial.originate).toHaveBeenCalledTimes(1)
    expect(results.map(result => result.status).sort()).toEqual(['admitted', 'indeterminate'])
  })

  it('a second call to the same Contact while the first is live is refused as busy', async () => {
    const { ops, dial } = setup()
    await ops.start(start('request-0001'))
    await expect(ops.start(start('request-0002'))).resolves.toEqual({ contract: 'calling.StartManualCallResult.v1', status: 'refused', reason: 'busy', retryable: true })
    expect(dial.originate).toHaveBeenCalledTimes(1)
  })

  it('an unknown dial outcome is indeterminate and is never redialled, not even on replay', async () => {
    const { ops, store, dial } = setup()
    dial.originate.mockRejectedValueOnce(new ManualDialOutcomeUnknownError('socket closed'))
    await expect(ops.start(start())).resolves.toMatchObject({ status: 'indeterminate' })
    expect(store.settle).toHaveBeenCalledWith(manualCallIdentityV1('request-0001').callId, 'outcome_unknown')
    await expect(ops.start(start())).resolves.toMatchObject({ status: 'indeterminate' })
    await expect(ops.start(start('request-0002'))).resolves.toMatchObject({ status: 'refused', reason: 'busy' })
    expect(dial.originate).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['unavailable', new ManualDialUnavailableError('no switch')],
    ['rejected', new ManualDialRejectedError('-ERR')],
  ] as const)('a %s switch refuses with provider_unavailable and frees the Contact', async (dispatch, error) => {
    const { ops, store, dial } = setup()
    dial.originate.mockRejectedValueOnce(error)
    await expect(ops.start(start())).resolves.toEqual({ contract: 'calling.StartManualCallResult.v1', status: 'refused', reason: 'provider_unavailable', retryable: true })
    expect(store.settle).toHaveBeenCalledWith(manualCallIdentityV1('request-0001').callId, dispatch)
    await expect(ops.start(start())).resolves.toMatchObject({ status: 'refused', reason: 'provider_unavailable' })
    expect(dial.originate).toHaveBeenCalledTimes(1)
  })

  it('derives a stable call id and a version-5 shaped channel uuid from the requestId', () => {
    const one = manualCallIdentityV1('request-0001')
    expect(manualCallIdentityV1('request-0001')).toEqual(one)
    expect(manualCallIdentityV1('request-0002').fsUuid).not.toBe(one.fsUuid)
    expect(one.callId).toMatch(/^manual_[0-9a-f]{32}$/)
    expect(one.fsUuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })
})

describe('manual call availability: the button and tel: links are offered only when a call is allowed', () => {
  const query = { contract: MANUAL_CALL_AVAILABILITY_QUERY_V1, contactId: CONTACT }

  it('lists only diallable phones, the primary first and preferred', async () => {
    const phones = [
      phone({ phoneId: 'secondary', phone: '+79161110002', isPrimary: false }),
      phone({ phoneId: 'shared', phone: '+79161110003', isPrimary: false, resolutionState: 'shared' }),
      phone(),
    ]
    const { ops, dial } = setup({ readPerson: async () => confirmed(card({ phones })) })
    await expect(ops.availability(query)).resolves.toEqual({
      contract: 'calling.ManualCallAvailabilityResult.v1', status: 'available', contactId: CONTACT,
      phones: [
        { phoneId: PHONE_ID, phone: E164, preferred: true },
        { phoneId: 'secondary', phone: '+79161110002', preferred: false },
      ],
    })
    expect(dial.originate).not.toHaveBeenCalled()
  })

  it.each([
    ['denyVoice', { voicePermission: async () => permission({ decision: 'deny', reason: 'restricted_voice' }) }, 'voice_denied'],
    ['denyAll', { voicePermission: async () => permission({ decision: 'deny', reason: 'restricted_all' }) }, 'all_denied'],
    ['no Staff Session', { principal: async () => null }, 'staff_not_authenticated'],
    ['no verified number', { readPerson: async () => confirmed(card({ phones: [phone({ resolutionState: 'unknown' })] })) }, 'no_verified_number'],
  ] as const)('%s → unavailable', async (_name, overrides, reason) => {
    const { ops } = setup(overrides as Partial<ManualCallPorts>)
    await expect(ops.availability(query)).resolves.toEqual({ contract: 'calling.ManualCallAvailabilityResult.v1', status: 'unavailable', reason })
  })
})

describe('manual call cancel: only the caller or an administrator, only an active call', () => {
  const cancel = (fsUuid: string) => ({ contract: CANCEL_MANUAL_CALL_COMMAND_V1, fsUuid })

  async function live() {
    const context = setup()
    await context.ops.start(start())
    return { ...context, fsUuid: manualCallIdentityV1('request-0001').fsUuid }
  }

  it('the employee who started it may cancel it', async () => {
    const { ops, dial, fsUuid } = await live()
    await expect(ops.cancel(cancel(fsUuid))).resolves.toEqual({ contract: 'calling.CancelManualCallResult.v1', status: 'cancelled' })
    expect(dial.cancel).toHaveBeenCalledWith(fsUuid)
  })

  it('another manager may not cancel it; an administrator may', async () => {
    const { ops, ports, dial, fsUuid } = await live()
    vi.mocked(ports.principal).mockResolvedValue({ userId: 'u2', role: 'Менеджер' })
    await expect(ops.cancel(cancel(fsUuid))).resolves.toMatchObject({ status: 'refused', reason: 'staff_not_authorized' })
    expect(dial.cancel).not.toHaveBeenCalled()
    vi.mocked(ports.principal).mockResolvedValue({ userId: 'u3', role: 'Администратор' })
    await expect(ops.cancel(cancel(fsUuid))).resolves.toMatchObject({ status: 'cancelled' })
  })

  it('refuses without a Staff Session, for an unknown or finished call, and rejects a malformed uuid', async () => {
    const { ops, ports, store, dial, fsUuid } = await live()
    await expect(ops.cancel(cancel('00000000-0000-5000-8000-000000000000'))).resolves.toMatchObject({ reason: 'call_not_found' })
    store.rows.forEach(row => { row.live = false })
    await expect(ops.cancel(cancel(fsUuid))).resolves.toMatchObject({ reason: 'call_not_active' })
    vi.mocked(ports.principal).mockResolvedValue(null)
    await expect(ops.cancel(cancel(fsUuid))).resolves.toMatchObject({ reason: 'staff_not_authenticated' })
    await expect(ops.cancel(cancel(`${fsUuid} ORIGINATOR_CANCEL`))).rejects.toBeInstanceOf(ManualCallContractError)
    expect(dial.cancel).not.toHaveBeenCalled()
  })
})
