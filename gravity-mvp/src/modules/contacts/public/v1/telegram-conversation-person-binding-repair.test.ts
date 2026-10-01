import { describe, expect, it, vi } from 'vitest'
import {
  createRepairTelegramConversationPersonBindingV1,
  RepairTelegramConversationPersonBindingRefusalV1,
  type RepairFleetEvidenceV1,
  type RepairPreconditionStateV1,
  type RepairTelegramConversationPersonBindingDependenciesV1,
} from './telegram-conversation-person-binding-repair'

const CANONICAL = 'contact-canonical'
const DUPLICATE = 'contact-duplicate'
const DRIVER = 'driver-representative'
const TELEGRAM_ID = '316425068'
const PHONE = '79222155750'
const CHAT = 'chat-telegram'
const IDENTITY = 'identity-telegram'
const ACTOR = 'operator-1'
const CLUSTER_KEY = 'vu:9923715223'

function state(overrides: Partial<RepairPreconditionStateV1> = {}): RepairPreconditionStateV1 {
  return {
    canonicalContact: {
      id: CANONICAL,
      isArchived: false,
      mergedIntoContactId: null,
      yandexDriverId: 'yandex-a',
      verifiedPrimaryPhoneDigits: PHONE,
      canonicalPinnedAt: null,
    },
    duplicateContact: {
      id: DUPLICATE,
      isArchived: false,
      mergedIntoContactId: null,
      canonicalPinnedAt: null,
    },
    representativeDriver: { id: DRIVER, phoneDigits: PHONE },
    telegramIdentity: {
      id: IDENTITY,
      contactId: DUPLICATE,
      channel: 'telegram',
      externalId: TELEGRAM_ID,
      isActive: true,
    },
    telegramChat: {
      id: CHAT,
      channel: 'telegram',
      chatType: 'private',
      externalChatId: `telegram:${TELEGRAM_ID}`,
      contactId: DUPLICATE,
      contactIdentityId: IDENTITY,
      driverId: 'driver-stale-other-person',
    },
    driverTelegram: { driverId: DRIVER, activeParkId: 'park-a', phoneVerified: false },
    hasMergeRelation: false,
    ...overrides,
  }
}

function fleet(overrides: Partial<RepairFleetEvidenceV1> = {}): RepairFleetEvidenceV1 {
  return {
    checkedParks: 6,
    errors: [],
    clusters: [{
      profileClusterKey: CLUSTER_KEY,
      profiles: [
        { driverId: DRIVER, sourceFreshness: 'fresh', externalParkId: 'park-a', normalizedVu: '9923715223' },
        { driverId: 'driver-other-park', sourceFreshness: 'fresh', externalParkId: 'park-c', normalizedVu: '9923715223' },
      ],
      warnings: [],
    }],
    ...overrides,
  }
}

function harness(options: {
  state?: RepairPreconditionStateV1
  fleet?: RepairFleetEvidenceV1
  fleetThrows?: Error
  mergeResult?: { status: string; survivorId?: string; mergedId?: string }
  mergeThrows?: Error
  pinThrows?: Error
  pinResult?: { status: string }
  confirmResult?: { status: string; confirmationId?: string }
  confirmThrows?: Error
  alreadyConfirmed?: boolean
  onMerge?: () => Promise<void>
} = {}) {
  const calls: string[] = []
  let confirmed = options.alreadyConfirmed ?? false

  const dependencies: RepairTelegramConversationPersonBindingDependenciesV1 = {
    readState: vi.fn(async () => options.state ?? state()),
    readFleetEvidence: vi.fn(async () => {
      calls.push('fleet')
      if (options.fleetThrows) throw options.fleetThrows
      return options.fleet ?? fleet()
    }),
    pinCanonicalContact: vi.fn(async () => {
      calls.push('pin')
      if (options.pinThrows) throw options.pinThrows
      return options.pinResult ?? { status: 'pinned' }
    }),
    mergeDuplicateIntoCanonical: vi.fn(async () => {
      calls.push('merge')
      await options.onMerge?.()
      if (options.mergeThrows) throw options.mergeThrows
      return options.mergeResult
        ?? { status: 'contact_merged', survivorId: CANONICAL, mergedId: DUPLICATE }
    }),
    confirmRepresentativeDriver: vi.fn(async () => {
      calls.push('confirm')
      if (options.confirmThrows) throw options.confirmThrows
      confirmed = true
      return options.confirmResult ?? { status: 'confirmed', confirmationId: 'confirmation-1' }
    }),
    isContactConfirmedMainDriver: vi.fn(async () => confirmed),
    log: () => {},
  }

  return {
    calls,
    dependencies,
    repair: createRepairTelegramConversationPersonBindingV1(dependencies),
  }
}

const input = {
  canonicalContactId: CANONICAL,
  duplicateContactId: DUPLICATE,
  representativeDriverId: DRIVER,
  telegramExternalId: TELEGRAM_ID,
  actorId: ACTOR,
}

function expectZeroMutation(h: ReturnType<typeof harness>) {
  expect(h.dependencies.pinCanonicalContact).not.toHaveBeenCalled()
  expect(h.dependencies.mergeDuplicateIntoCanonical).not.toHaveBeenCalled()
  expect(h.dependencies.confirmRepresentativeDriver).not.toHaveBeenCalled()
}

async function expectRefusal(h: ReturnType<typeof harness>, reason: string, overrides = {}) {
  await expect(h.repair({ ...input, ...overrides })).rejects.toMatchObject({
    name: 'RepairTelegramConversationPersonBindingRefusalV1',
    reason,
  })
  expectZeroMutation(h)
}

describe('repairTelegramConversationPersonBindingV1 — positive', () => {
  it('obtains Fleet evidence before mutating, then merges and confirms in order', async () => {
    const h = harness()
    const result = await h.repair(input)

    expect(result).toEqual({
      status: 'repaired',
      survivorContactId: CANONICAL,
      mergedContactId: DUPLICATE,
      chatId: CHAT,
      driverId: DRIVER,
      confirmationId: 'confirmation-1',
    })
    // Fleet evidence strictly precedes the first DB mutation, and the canonical
    // pin strictly precedes the merge it has to decide.
    expect(h.calls).toEqual(['fleet', 'pin', 'merge', 'confirm'])
    expect(h.dependencies.pinCanonicalContact).toHaveBeenCalledWith({
      contactId: CANONICAL,
      actorId: ACTOR,
    })
    expect(h.dependencies.mergeDuplicateIntoCanonical).toHaveBeenCalledWith({
      duplicateContactId: DUPLICATE,
      canonicalContactId: CANONICAL,
      actorId: ACTOR,
    })
    expect(h.dependencies.confirmRepresentativeDriver).toHaveBeenCalledWith({
      contactId: CANONICAL,
      profileClusterKey: CLUSTER_KEY,
      representativeDriverId: DRIVER,
      actorId: ACTOR,
      searchInput: PHONE,
      // The authoritative cluster is forwarded verbatim: ConfirmDriverPersonCommand.v1
      // refuses an empty or non-fresh snapshot.
      evidenceProfiles: [
        { driverId: DRIVER, sourceFreshness: 'fresh', externalParkId: 'park-a', normalizedVu: '9923715223' },
        { driverId: 'driver-other-park', sourceFreshness: 'fresh', externalParkId: 'park-c', normalizedVu: '9923715223' },
      ],
      evidenceWarnings: [],
    })
  })

  it('treats an already_confirmed confirmation as a successful repair', async () => {
    const h = harness({ confirmResult: { status: 'already_confirmed', confirmationId: 'existing' } })
    await expect(h.repair(input)).resolves.toMatchObject({ status: 'repaired', confirmationId: 'existing' })
  })
})

describe('repairTelegramConversationPersonBindingV1 — required negative cases', () => {
  it('refuses a missing canonical Contact', async () => {
    await expectRefusal(harness({ state: state({ canonicalContact: null }) }), 'CANONICAL_CONTACT_NOT_FOUND')
  })

  it('refuses a missing duplicate Contact', async () => {
    await expectRefusal(harness({ state: state({ duplicateContact: null }) }), 'DUPLICATE_CONTACT_NOT_FOUND')
  })

  it('refuses a missing representative Driver', async () => {
    await expectRefusal(harness({ state: state({ representativeDriver: null }) }), 'REPRESENTATIVE_DRIVER_NOT_FOUND')
  })

  it('refuses when the representative Driver phone differs from the canonical verified phone', async () => {
    await expectRefusal(
      harness({ state: state({ representativeDriver: { id: DRIVER, phoneDigits: '70000000000' } }) }),
      'REPRESENTATIVE_DRIVER_PHONE_MISMATCH',
    )
  })

  it('refuses when the canonical Contact has no verified primary phone', async () => {
    await expectRefusal(
      harness({
        state: state({
          canonicalContact: {
            id: CANONICAL, isArchived: false, mergedIntoContactId: null,
            yandexDriverId: 'yandex-a', verifiedPrimaryPhoneDigits: null,
            canonicalPinnedAt: null,
          },
        }),
      }),
      'CANONICAL_VERIFIED_PHONE_MISSING',
    )
  })

  it('refuses a Telegram identity owned by another Contact', async () => {
    await expectRefusal(
      harness({
        state: state({
          telegramIdentity: {
            id: IDENTITY, contactId: 'contact-someone-else', channel: 'telegram',
            externalId: TELEGRAM_ID, isActive: true,
          },
        }),
      }),
      'TELEGRAM_IDENTITY_NOT_OWNED_BY_DUPLICATE',
    )
  })

  it('refuses an inactive Telegram identity', async () => {
    await expectRefusal(
      harness({
        state: state({
          telegramIdentity: {
            id: IDENTITY, contactId: DUPLICATE, channel: 'telegram',
            externalId: TELEGRAM_ID, isActive: false,
          },
        }),
      }),
      'TELEGRAM_IDENTITY_NOT_OWNED_BY_DUPLICATE',
    )
  })

  it('refuses a conversation owned by another Contact', async () => {
    const base = state()
    await expectRefusal(
      harness({ state: state({ telegramChat: { ...base.telegramChat!, contactId: 'contact-someone-else' } }) }),
      'TELEGRAM_CHAT_NOT_OWNED_BY_DUPLICATE',
    )
  })

  it('refuses conversation before-state drift on chatType, key or identity', async () => {
    const base = state().telegramChat!
    for (const drift of [
      { chatType: 'group' },
      { externalChatId: 'telegram:999' },
      { contactIdentityId: 'identity-other' },
      { channel: 'whatsapp' },
    ]) {
      await expectRefusal(
        harness({ state: state({ telegramChat: { ...base, ...drift } }) }),
        'TELEGRAM_CHAT_STATE_DRIFT',
      )
    }
  })

  it('refuses when the conversation already names the representative Driver', async () => {
    const base = state().telegramChat!
    await expectRefusal(
      harness({ state: state({ telegramChat: { ...base, driverId: DRIVER } }) }),
      'TELEGRAM_CHAT_STATE_DRIFT',
    )
  })

  it('refuses DriverTelegram before-state drift', async () => {
    for (const driverTelegram of [
      null,
      { driverId: 'driver-other', activeParkId: 'park-a', phoneVerified: false },
      { driverId: null, activeParkId: 'park-a', phoneVerified: false },
    ]) {
      await expectRefusal(harness({ state: state({ driverTelegram }) }), 'DRIVER_TELEGRAM_STATE_DRIFT')
    }
  })

  it('refuses an archived canonical Contact', async () => {
    await expectRefusal(
      harness({
        state: state({
          canonicalContact: {
            id: CANONICAL, isArchived: true, mergedIntoContactId: null,
            yandexDriverId: 'yandex-a', verifiedPrimaryPhoneDigits: PHONE,
            canonicalPinnedAt: null,
          },
        }),
      }),
      'CANONICAL_CONTACT_ARCHIVED',
    )
  })

  it('refuses an archived duplicate Contact', async () => {
    await expectRefusal(
      harness({
        state: state({
          duplicateContact: {
            id: DUPLICATE, isArchived: true, mergedIntoContactId: null, canonicalPinnedAt: null,
          },
        }),
      }),
      'DUPLICATE_CONTACT_ARCHIVED',
    )
  })

  it('refuses a Contact that already redirects into another Contact', async () => {
    await expectRefusal(
      harness({
        state: state({
          duplicateContact: {
            id: DUPLICATE, isArchived: false, mergedIntoContactId: 'contact-x', canonicalPinnedAt: null,
          },
        }),
      }),
      'CONTACT_ALREADY_MERGED',
    )
  })

  it('refuses a duplicate Contact that carries its own canonical pin', async () => {
    // Both sides pinned ties `manual_canonical_pin`, so a later heuristic reason
    // would silently decide the survivor. The repair refuses instead.
    const h = harness({
      state: state({
        duplicateContact: {
          id: DUPLICATE,
          isArchived: false,
          mergedIntoContactId: null,
          canonicalPinnedAt: '2026-09-01T00:00:00.000Z',
        },
      }),
    })
    await expectRefusal(h, 'DUPLICATE_CONTACT_CANONICALLY_PINNED')
    expectZeroMutation(h)
  })

  it('refuses an existing merge relation whose end state does not match the target', async () => {
    const base = state().telegramChat!
    await expectRefusal(
      harness({
        state: state({ hasMergeRelation: true, telegramChat: { ...base, contactId: 'contact-elsewhere' } }),
      }),
      'EXISTING_MERGE_RELATION',
    )
  })

  it('refuses when Fleet evidence is unavailable', async () => {
    await expectRefusal(harness({ fleetThrows: new Error('upstream down') }), 'FLEET_EVIDENCE_UNAVAILABLE')
  })

  it('refuses Fleet errors and zero checked parks', async () => {
    await expectRefusal(harness({ fleet: fleet({ errors: [{ parkId: 'p' }] }) }), 'FLEET_EVIDENCE_INCOMPLETE')
    await expectRefusal(harness({ fleet: fleet({ checkedParks: 0 }) }), 'FLEET_EVIDENCE_INCOMPLETE')
  })

  it('refuses a stale Fleet cluster', async () => {
    await expectRefusal(
      harness({
        fleet: fleet({
          clusters: [{
            profileClusterKey: CLUSTER_KEY,
            profiles: [
              { driverId: DRIVER, sourceFreshness: 'fresh' },
              { driverId: 'driver-other-park', sourceFreshness: 'stale' },
            ],
          }],
        }),
      }),
      'FLEET_CLUSTER_STALE',
    )
  })

  it('refuses Fleet evidence that does not name the representative Driver exactly once', async () => {
    await expectRefusal(harness({ fleet: fleet({ clusters: [] }) }), 'FLEET_CLUSTER_MISSING_REPRESENTATIVE')
    await expectRefusal(
      harness({
        fleet: fleet({
          clusters: [
            { profileClusterKey: 'vu:1', profiles: [{ driverId: DRIVER, sourceFreshness: 'fresh' }] },
            { profileClusterKey: 'vu:2', profiles: [{ driverId: DRIVER, sourceFreshness: 'fresh' }] },
          ],
        }),
      }),
      'FLEET_CLUSTER_MISSING_REPRESENTATIVE',
    )
  })

  it('refuses an unproven actor', async () => {
    const h = harness()
    await expect(h.repair({ ...input, actorId: '' })).rejects.toMatchObject({ reason: 'ACTOR_NOT_PROVEN' })
    expectZeroMutation(h)
  })

  it('refuses malformed input', async () => {
    for (const overrides of [
      { canonicalContactId: '' },
      { duplicateContactId: '' },
      { representativeDriverId: '' },
      { telegramExternalId: '' },
      { telegramExternalId: 'not-numeric' },
      { canonicalContactId: CANONICAL, duplicateContactId: CANONICAL },
    ]) {
      const h = harness()
      await expect(h.repair({ ...input, ...overrides })).rejects.toMatchObject({ reason: 'INPUT_INVALID' })
      expectZeroMutation(h)
    }
  })

  it('refuses a merge that does not elect the canonical Contact, and never confirms', async () => {
    const h = harness({ mergeResult: { status: 'contact_merged', survivorId: DUPLICATE, mergedId: CANONICAL } })
    await expect(h.repair(input)).rejects.toMatchObject({ reason: 'MERGE_DID_NOT_ELECT_CANONICAL' })
    expect(h.dependencies.confirmRepresentativeDriver).not.toHaveBeenCalled()
  })

  it('refuses an unexpected merge status, and never confirms', async () => {
    const h = harness({ mergeResult: { status: 'automatic_merge_blocked' } })
    await expect(h.repair(input)).rejects.toMatchObject({ reason: 'MERGE_OUTCOME_UNEXPECTED' })
    expect(h.dependencies.confirmRepresentativeDriver).not.toHaveBeenCalled()
  })
})

describe('repairTelegramConversationPersonBindingV1 — idempotency', () => {
  it('reports already_repaired and mutates nothing once the end state holds', async () => {
    const base = state().telegramChat!
    const h = harness({
      state: state({
        hasMergeRelation: true,
        telegramChat: { ...base, contactId: CANONICAL, driverId: DRIVER },
      }),
      alreadyConfirmed: true,
    })
    await expect(h.repair(input)).resolves.toEqual({
      status: 'already_repaired',
      survivorContactId: CANONICAL,
      chatId: CHAT,
      driverId: DRIVER,
    })
    expectZeroMutation(h)
  })

  it('resumes at phase 3 without a second pin or merge when only confirmation is missing', async () => {
    const base = state().telegramChat!
    const h = harness({
      state: state({
        hasMergeRelation: true,
        telegramChat: { ...base, contactId: CANONICAL, driverId: DRIVER },
      }),
      alreadyConfirmed: false,
    })
    await expect(h.repair(input)).resolves.toMatchObject({ status: 'repaired' })
    expect(h.dependencies.pinCanonicalContact).not.toHaveBeenCalled()
    expect(h.dependencies.mergeDuplicateIntoCanonical).not.toHaveBeenCalled()
    expect(h.dependencies.confirmRepresentativeDriver).toHaveBeenCalledTimes(1)
  })

  it('a second full run after success performs no further mutation', async () => {
    const h = harness()
    await h.repair(input)
    expect(h.dependencies.mergeDuplicateIntoCanonical).toHaveBeenCalledTimes(1)
    expect(h.dependencies.confirmRepresentativeDriver).toHaveBeenCalledTimes(1)

    // The end state now holds; the same inputs must be a no-op.
    const base = state().telegramChat!
    const second = harness({
      state: state({
        hasMergeRelation: true,
        telegramChat: { ...base, contactId: CANONICAL, driverId: DRIVER },
      }),
      alreadyConfirmed: true,
    })
    await expect(second.repair(input)).resolves.toMatchObject({ status: 'already_repaired' })
    expectZeroMutation(second)
  })
})

describe('repairTelegramConversationPersonBindingV1 — concurrency', () => {
  it('serializes behind the merge owner so only one attempt mutates', async () => {
    // The Contacts ownership lock lives inside the merge unit of work. Model it
    // here: the second attempt cannot enter the merge until the first leaves,
    // and by then the end state holds, so it observes already_repaired.
    let mergeCount = 0
    let endStateReached = false
    let release: (() => void) | null = null
    const gate = new Promise<void>(resolve => { release = resolve })

    function build() {
      const base = state().telegramChat!
      const dependencies: RepairTelegramConversationPersonBindingDependenciesV1 = {
        readState: async () => (endStateReached
          ? state({ hasMergeRelation: true, telegramChat: { ...base, contactId: CANONICAL, driverId: DRIVER } })
          : state()),
        readFleetEvidence: async () => fleet(),
        pinCanonicalContact: async () => ({ status: 'pinned' }),
        mergeDuplicateIntoCanonical: async () => {
          mergeCount += 1
          await gate
          endStateReached = true
          return { status: 'contact_merged', survivorId: CANONICAL, mergedId: DUPLICATE }
        },
        confirmRepresentativeDriver: async () => ({ status: 'confirmed', confirmationId: 'c1' }),
        isContactConfirmedMainDriver: async () => endStateReached,
        log: () => {},
      }
      return createRepairTelegramConversationPersonBindingV1(dependencies)
    }

    const first = build()(input)
    release!()
    await first
    const second = await build()(input)

    expect(mergeCount).toBe(1)
    expect(second).toMatchObject({ status: 'already_repaired' })
  })
})

describe('repairTelegramConversationPersonBindingV1 — phase failure injection', () => {
  // These two refusals are raised after phase 1 was attempted, so they
  // deliberately do not use `expectRefusal`, which asserts zero mutation.
  it('refuses with CANONICAL_PIN_FAILED and never merges when phase 1 fails', async () => {
    const h = harness({ pinThrows: new Error('pin transaction aborted') })
    await expect(h.repair(input)).rejects.toMatchObject({
      name: 'RepairTelegramConversationPersonBindingRefusalV1',
      reason: 'CANONICAL_PIN_FAILED',
    })
    expect(h.dependencies.mergeDuplicateIntoCanonical).not.toHaveBeenCalled()
    expect(h.dependencies.confirmRepresentativeDriver).not.toHaveBeenCalled()
  })

  it('reports MERGE_FAILED_AFTER_CANONICAL_PIN, which is the one non-zero-mutation refusal', async () => {
    const h = harness({ mergeThrows: new Error('merge transaction aborted') })
    await expect(h.repair(input)).rejects.toMatchObject({
      name: 'RepairTelegramConversationPersonBindingRefusalV1',
      reason: 'MERGE_FAILED_AFTER_CANONICAL_PIN',
    })
    // The pin committed; nothing else did, and no authority was granted.
    expect(h.calls).toEqual(['fleet', 'pin', 'merge'])
    expect(h.dependencies.confirmRepresentativeDriver).not.toHaveBeenCalled()
  })

  it('accepts an already_pinned canonical Contact as a completed phase 1', async () => {
    const h = harness({
      pinResult: { status: 'already_pinned' },
      state: state({
        canonicalContact: {
          id: CANONICAL,
          isArchived: false,
          mergedIntoContactId: null,
          yandexDriverId: 'yandex-a',
          verifiedPrimaryPhoneDigits: PHONE,
          canonicalPinnedAt: '2026-09-01T00:00:00.000Z',
        },
      }),
    })
    await expect(h.repair(input)).resolves.toMatchObject({ status: 'repaired' })
    expect(h.calls).toEqual(['fleet', 'pin', 'merge', 'confirm'])
  })

  it('surfaces a documented recoverable state when phase 3 throws', async () => {
    const h = harness({ confirmThrows: new Error('confirmation transaction aborted') })
    const result = await h.repair(input)
    expect(result).toEqual({
      status: 'merged_pending_confirmation',
      survivorContactId: CANONICAL,
      mergedContactId: DUPLICATE,
      chatId: CHAT,
      driverId: DRIVER,
      confirmationError: 'confirmation transaction aborted',
    })
  })

  it('surfaces a documented recoverable state when phase 3 declines', async () => {
    const h = harness({ confirmResult: { status: 'needs_reconciliation' } })
    await expect(h.repair(input)).resolves.toMatchObject({
      status: 'merged_pending_confirmation',
      confirmationError: 'confirmation returned needs_reconciliation',
    })
  })

  it('never reaches any mutation phase when the proof phase refuses', async () => {
    const h = harness({ state: state({ representativeDriver: { id: DRIVER, phoneDigits: '70000000000' } }) })
    await expect(h.repair(input)).rejects.toBeInstanceOf(RepairTelegramConversationPersonBindingRefusalV1)
    expect(h.calls).toEqual([])
  })
})
