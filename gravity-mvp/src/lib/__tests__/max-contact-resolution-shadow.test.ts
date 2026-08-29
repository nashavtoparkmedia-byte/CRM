import { readFileSync } from 'fs'
import path from 'path'
import { describe, expect, test, vi } from 'vitest'

import {
  compareContactResolution,
  isMaxContactResolutionShadowEnabled,
  startMaxContactResolutionShadow,
} from '../contacts/max-contact-resolution-shadow'
import type { ContactResolutionResult } from '../contacts/contact-resolution.types'
import type {
  LegacyContactResolutionOutcome,
  MaxContactResolutionShadowDependencies,
  MaxContactResolutionShadowInput,
} from '../contacts/contact-resolution-shadow.types'

function plan(
  status: ContactResolutionResult['status'],
  contactId = 'contact-A',
): ContactResolutionResult {
  const warnings = ['provider_account_scope_not_persisted', 'global_message_key'] as const
  switch (status) {
    case 'identity_found':
    case 'phone_matched':
      return { status, contactId, canonicalContactId: contactId, warnings: [...warnings] }
    case 'merged_contact':
      return { status, originalContactId: 'source-A', canonicalContactId: contactId, warnings: [...warnings] }
    case 'ambiguous_phone':
      return { status, candidateContactIds: ['contact-A', 'contact-B'], warnings: [...warnings] }
    case 'identity_phone_conflict':
      return { status, identityContactId: contactId, phoneContactIds: ['contact-B'], warnings: [...warnings] }
    case 'archived_without_merge':
      return { status, contactId, warnings: [...warnings] }
    case 'merge_cycle':
      return { status, contactIds: ['contact-A', 'contact-B'], warnings: [...warnings] }
    case 'merge_ambiguous':
    case 'merge_depth_exceeded':
      return { status, contactIds: ['contact-A', 'contact-B'], warnings: [...warnings] }
    case 'create_required':
    case 'skipped_group':
    case 'untrusted_phone':
    case 'invalid_input':
      return { status, warnings: [...warnings] }
  }
}

function input(overrides: Partial<MaxContactResolutionShadowInput> = {}): MaxContactResolutionShadowInput {
  return {
    resolutionInput: {
      channel: 'max',
      externalUserId: 'max-user-1',
      externalChatId: 'max-chat-1',
      channelDisplayName: 'Not used as identity',
      chatKind: 'private',
    },
    isOutgoing: false,
    eventSource: 'live',
    ...overrides,
  }
}

function dependencies(
  plannerResult: ContactResolutionResult = plan('identity_found'),
  overrides: Partial<MaxContactResolutionShadowDependencies> = {},
) {
  let tick = 0
  const logs: unknown[] = []
  const deps: MaxContactResolutionShadowDependencies = {
    enabled: true,
    planner: { resolve: vi.fn(async () => plannerResult) },
    compare: compareContactResolution,
    log: vi.fn(record => logs.push(record)),
    now: () => ++tick,
    plannerTimeoutMs: 100,
    ...overrides,
  }
  return { deps, logs }
}

const reusedA: LegacyContactResolutionOutcome = {
  status: 'contact_reused', contactId: 'contact-A', source: 'unknown',
}

describe('MAX ContactResolution shadow comparison', () => {
  test('flag parser is disabled for absent, false, zero, and blank values', () => {
    expect(isMaxContactResolutionShadowEnabled(undefined)).toBe(false)
    expect(isMaxContactResolutionShadowEnabled('false')).toBe(false)
    expect(isMaxContactResolutionShadowEnabled('0')).toBe(false)
    expect(isMaxContactResolutionShadowEnabled('')).toBe(false)
    expect(isMaxContactResolutionShadowEnabled('true')).toBe(true)
  })

  test('disabled flag does not call planner or emit a shadow log', async () => {
    const { deps } = dependencies(plan('identity_found'), { enabled: false })

    const started = await startMaxContactResolutionShadow(input(), deps)

    expect(started.session).toBeNull()
    expect(started.skipReason).toBe('disabled')
    expect(deps.planner.resolve).not.toHaveBeenCalled()
    expect(deps.log).not.toHaveBeenCalled()
  })

  test('enabled private inbound event calls planner exactly once', async () => {
    const { deps } = dependencies()

    const started = await startMaxContactResolutionShadow(input(), deps)
    await started.session?.complete(reusedA)

    expect(deps.planner.resolve).toHaveBeenCalledTimes(1)
    expect(deps.log).toHaveBeenCalledTimes(1)
  })

  test('planner completes before a legacy mutation begins', async () => {
    const order: string[] = []
    const { deps } = dependencies(plan('identity_found'), {
      planner: { resolve: vi.fn(async () => { order.push('planner'); return plan('identity_found') }) },
    })

    const started = await startMaxContactResolutionShadow(input(), deps)
    order.push('legacy-mutation')
    await started.session?.complete(reusedA)

    expect(order).toEqual(['planner', 'legacy-mutation'])
  })

  test('identity_found A and legacy reused A agree on existing Contact', () => {
    expect(compareContactResolution(plan('identity_found'), reusedA).comparisonStatus)
      .toBe('agreement_existing_contact')
  })

  test('phone_matched A and legacy reused A agree on existing Contact', () => {
    expect(compareContactResolution(plan('phone_matched'), reusedA).comparisonStatus)
      .toBe('agreement_existing_contact')
  })

  test('create_required and legacy created Contact agree on new Contact', () => {
    expect(compareContactResolution(plan('create_required'), { status: 'contact_created', contactId: 'contact-B' }).comparisonStatus)
      .toBe('agreement_new_contact')
  })

  test('ambiguous phone reused by legacy is classified specifically', () => {
    expect(compareContactResolution(plan('ambiguous_phone'), reusedA).comparisonStatus)
      .toBe('ambiguous_phone_ignored_by_legacy')
  })

  test('identity and phone conflict reused by legacy is classified specifically', () => {
    expect(compareContactResolution(plan('identity_phone_conflict'), reusedA).comparisonStatus)
      .toBe('identity_phone_conflict_ignored_by_legacy')
  })

  test('different canonical and legacy Contacts are a mismatch', () => {
    expect(compareContactResolution(plan('identity_found', 'contact-A'), {
      status: 'contact_reused', contactId: 'contact-B', source: 'unknown',
    }).comparisonStatus).toBe('contact_mismatch')
  })

  test('planner match and legacy created Contact are legacy_more_cautious', () => {
    expect(compareContactResolution(plan('phone_matched'), { status: 'contact_created', contactId: 'contact-B' }).comparisonStatus)
      .toBe('legacy_more_cautious')
  })

  test('legacy reuse of an archived Contact is classified separately', () => {
    expect(compareContactResolution(plan('archived_without_merge'), reusedA).comparisonStatus)
      .toBe('archived_contact_used_by_legacy')
  })

  test('merge cycle is classified without changing legacy outcome', () => {
    const outcome = { ...reusedA }
    expect(compareContactResolution(plan('merge_cycle'), outcome).comparisonStatus).toBe('merge_cycle_detected')
    expect(outcome).toEqual(reusedA)
  })

  test('planner failure leaves legacy flow and response value intact', async () => {
    const { deps, logs } = dependencies(plan('identity_found'), {
      planner: { resolve: vi.fn(async () => { throw new Error('planner unavailable') }) },
    })
    const response = { success: true }

    const started = await startMaxContactResolutionShadow(input(), deps)
    await started.session?.complete(reusedA)

    expect(response).toEqual({ success: true })
    expect(logs[0]).toMatchObject({ comparisonStatus: 'planner_error', legacyStatus: 'contact_reused' })
  })

  test('comparator failure leaves legacy flow intact', async () => {
    const { deps, logs } = dependencies(plan('identity_found'), {
      compare: () => { throw new Error('compare failed') },
    })

    const started = await startMaxContactResolutionShadow(input(), deps)
    await started.session?.complete(reusedA)

    expect(logs[0]).toMatchObject({ comparisonStatus: 'planner_error', legacyStatus: 'contact_reused' })
  })

  test('logger failure is contained after legacy flow', async () => {
    const { deps } = dependencies(plan('identity_found'), {
      log: () => { throw new Error('logger unavailable') },
    })

    const started = await startMaxContactResolutionShadow(input(), deps)
    await expect(started.session?.complete(reusedA)).resolves.toBeUndefined()
  })

  test('outgoing MAX event never starts the planner', async () => {
    const { deps } = dependencies()
    const started = await startMaxContactResolutionShadow(input({ isOutgoing: true }), deps)

    expect(started.skipReason).toBe('outgoing_or_unknown_direction')
    expect(deps.planner.resolve).not.toHaveBeenCalled()
  })

  test('group chat never starts the planner', async () => {
    const { deps } = dependencies()
    const started = await startMaxContactResolutionShadow(input({
      resolutionInput: { ...input().resolutionInput, chatKind: 'group' },
    }), deps)

    expect(started.skipReason).toBe('group_or_unknown_chat_kind')
    expect(deps.planner.resolve).not.toHaveBeenCalled()
  })

  test('missing senderId is a controlled skip', async () => {
    const { deps } = dependencies()
    const started = await startMaxContactResolutionShadow(input({
      resolutionInput: { ...input().resolutionInput, externalUserId: null },
    }), deps)

    expect(started.skipReason).toBe('missing_sender_identity')
    expect(deps.planner.resolve).not.toHaveBeenCalled()
  })

  test('senderName is never substituted for externalUserId', async () => {
    const { deps } = dependencies()
    const started = await startMaxContactResolutionShadow(input({
      resolutionInput: { ...input().resolutionInput, externalUserId: null, channelDisplayName: 'Driver Name' },
    }), deps)

    expect(started.skipReason).toBe('missing_sender_identity')
    expect(deps.planner.resolve).not.toHaveBeenCalled()
  })

  test('externalChatId is never substituted for externalUserId', async () => {
    const { deps } = dependencies()
    const started = await startMaxContactResolutionShadow(input({
      resolutionInput: { ...input().resolutionInput, externalUserId: null, externalChatId: 'chat-only-id' },
    }), deps)

    expect(started.skipReason).toBe('missing_sender_identity')
    expect(deps.planner.resolve).not.toHaveBeenCalled()
  })

  test('untrusted MAX phone evidence is passed without automatic phone trust', async () => {
    const { deps } = dependencies()
    const shadowInput = input({
      resolutionInput: {
        ...input().resolutionInput,
        normalizedPhone: '+79990000000',
        phoneEvidence: { source: 'unknown', trustedForAutomaticResolution: false },
      },
    })

    await startMaxContactResolutionShadow(shadowInput, deps)

    expect(deps.planner.resolve).toHaveBeenCalledWith(expect.objectContaining({
      phoneEvidence: { source: 'unknown', trustedForAutomaticResolution: false },
    }))
  })

  test('trusted MAX provider mapping evidence is passed through unchanged', async () => {
    const { deps } = dependencies()
    const shadowInput = input({
      resolutionInput: {
        ...input().resolutionInput,
        normalizedPhone: '+79990000000',
        phoneEvidence: { source: 'provider_profile', trustedForAutomaticResolution: true },
      },
    })

    await startMaxContactResolutionShadow(shadowInput, deps)

    expect(deps.planner.resolve).toHaveBeenCalledWith(expect.objectContaining({
      phoneEvidence: { source: 'provider_profile', trustedForAutomaticResolution: true },
    }))
  })

  test('structured log excludes raw phone, message text, sender name, and provider ids', async () => {
    const { deps, logs } = dependencies()
    const shadowInput = input({
      resolutionInput: {
        ...input().resolutionInput,
        externalUserId: 'private-provider-id',
        normalizedPhone: '+79990000000',
        channelDisplayName: 'Private Sender',
      },
    })

    const started = await startMaxContactResolutionShadow(shadowInput, deps)
    await started.session?.complete(reusedA)

    const serialized = JSON.stringify(logs[0])
    expect(serialized).not.toContain('79990000000')
    expect(serialized).not.toContain('Private Sender')
    expect(serialized).not.toContain('private-provider-id')
    expect(serialized).not.toContain('message text')
  })

  test('legacy outcome remains source of truth even when comparison is a mismatch', async () => {
    const { deps } = dependencies(plan('identity_found', 'contact-A'))
    const legacyOutcome: LegacyContactResolutionOutcome = {
      status: 'contact_reused', contactId: 'contact-B', source: 'unknown',
    }
    const started = await startMaxContactResolutionShadow(input(), deps)
    await started.session?.complete(legacyOutcome)

    expect(legacyOutcome).toEqual({ status: 'contact_reused', contactId: 'contact-B', source: 'unknown' })
  })

  test('shadow module contains no CRM write calls', () => {
    const source = readFileSync(path.join(process.cwd(), 'src/lib/contacts/max-contact-resolution-shadow.ts'), 'utf8')
    expect(source).not.toMatch(/\.(create|update|upsert|delete|deleteMany|updateMany)\(/)
  })

  test('repeated provider events add no shadow DB writes', async () => {
    const mutations = vi.fn()
    const { deps } = dependencies(plan('identity_found'), {
      planner: { resolve: vi.fn(async () => plan('identity_found')) },
    })

    for (let index = 0; index < 2; index += 1) {
      const started = await startMaxContactResolutionShadow(input(), deps)
      await started.session?.complete(reusedA)
    }

    expect(mutations).not.toHaveBeenCalled()
    expect(deps.planner.resolve).toHaveBeenCalledTimes(2)
  })

  test('structured log includes planner and total duration', async () => {
    const { deps, logs } = dependencies()
    const started = await startMaxContactResolutionShadow(input(), deps)
    await started.session?.complete(reusedA)

    expect(logs[0]).toMatchObject({ plannerDurationMs: expect.any(Number), totalShadowDurationMs: expect.any(Number) })
  })

  test('planner warnings are carried into structured comparison log', async () => {
    const { deps, logs } = dependencies(plan('identity_found'))
    const started = await startMaxContactResolutionShadow(input(), deps)
    await started.session?.complete(reusedA)

    expect(logs[0]).toMatchObject({ warnings: expect.arrayContaining(['provider_account_scope_not_persisted']) })
  })

  test('canonical route starts shadow before owner-routed Chat mutation and captures legacy outcome after Contacts resolution', () => {
    const route = readFileSync(path.join(process.cwd(), 'src/app/api/webhooks/max/route.ts'), 'utf8')
    const shadowStart = route.indexOf('const maxContactResolutionShadow = await startMaxContactResolutionShadowV1')
    const ownerMutationIndexes = [
      route.indexOf('await patchExternalConversationV1'),
      route.indexOf('await createExternalConversationV1'),
    ].filter(index => index >= 0)
    const firstChatMutation = Math.min(...ownerMutationIndexes)
    const legacyCapture = route.indexOf('legacyContactResolution = contactResult.isNew')
    const contactResolve = route.indexOf('resolveChannelContactOperationV1')

    expect(shadowStart).toBeGreaterThan(-1)
    expect(ownerMutationIndexes).toHaveLength(2)
    expect(shadowStart).toBeLessThan(firstChatMutation)
    expect(legacyCapture).toBeGreaterThan(contactResolve)
  })
})
