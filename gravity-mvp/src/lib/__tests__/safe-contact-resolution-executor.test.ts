import { ChatChannel, ContactPhoneSource } from '@prisma/client'
import { describe, expect, test, vi } from 'vitest'

import { ContactService } from '../ContactService'
import { ContactResolutionService } from '../contacts/ContactResolutionService'
import {
  createPrismaContactResolutionExecutionTransactionV1,
  ProviderIdentityAliasCollisionError,
  SafeContactResolutionExecutor,
  type ContactResolutionExecutionTransaction,
  type ContactResolutionUnitOfWork,
} from '../contacts/SafeContactResolutionExecutor'
import type { ContactResolutionInput, ContactResolutionResult } from '../contacts/contact-resolution.types'

const PHONE = '+79990000000'
const INPUT: ContactResolutionInput = {
  channel: 'telegram',
  externalUserId: 'tg-1',
  normalizedPhone: PHONE,
  phoneEvidence: { source: 'provider_profile', trustedForAutomaticResolution: true },
  chatKind: 'private',
}

type PlanWithoutWarnings = ContactResolutionResult extends infer Result
  ? Result extends { warnings: unknown }
    ? Omit<Result, 'warnings'>
    : never
  : never

function plan(result: PlanWithoutWarnings): ContactResolutionResult {
  return { ...result, warnings: [] }
}

function transaction(revalidatedPlan: ContactResolutionResult) {
  const tx: ContactResolutionExecutionTransaction = {
    lockResolutionState: vi.fn(async () => undefined),
    plan: vi.fn(async () => revalidatedPlan),
    findIdentity: vi.fn(async () => null),
    findContact: vi.fn(async contactId => ({
      id: contactId,
      displayName: `Contact ${contactId}`,
      isArchived: false,
      primaryPhoneId: 'phone-1',
    })),
    findContactPhone: vi.fn(async contactId => contactId === 'created-contact'
      ? null
      : { id: 'phone-1', contactId, isActive: true, isPrimary: true }),
    createContact: vi.fn(async displayName => ({
      id: 'created-contact', displayName, isArchived: false, primaryPhoneId: null,
    })),
    createPhone: vi.fn(async input => ({
      id: 'created-phone', contactId: input.contactId, isActive: true, isPrimary: input.isPrimary,
    })),
    reactivatePhone: vi.fn(async input => ({
      id: input.phoneId, contactId: 'contact-1', isActive: true, isPrimary: input.isPrimary,
    })),
    promotePhone: vi.fn(async input => ({
      id: input.phoneId, contactId: 'contact-1', isActive: true, isPrimary: true,
    })),
    setPrimaryPhone: vi.fn(async () => undefined),
    createIdentity: vi.fn(async input => ({
      id: 'created-identity', contactId: input.contactId, channel: input.channel,
      externalId: input.externalId, providerAccountId: input.providerAccountId, phoneId: input.phoneId,
    })),
    updateIdentity: vi.fn(async input => ({
      id: input.identityId, contactId: input.contactId, channel: ChatChannel.telegram,
      externalId: 'tg-1', providerAccountId: 'legacy', phoneId: input.phoneId,
    })),
    recordConflict: vi.fn(async () => undefined),
  }
  return tx
}

function executor(initialPlan: ContactResolutionResult, tx: ContactResolutionExecutionTransaction) {
  const planner = { resolve: vi.fn(async () => initialPlan) } as unknown as ContactResolutionService
  const unitOfWork: ContactResolutionUnitOfWork = { run: vi.fn(work => work(tx)) }
  return { executor: new SafeContactResolutionExecutor(planner, unitOfWork), planner, unitOfWork }
}

function expectNoMutation(tx: ContactResolutionExecutionTransaction) {
  expect(tx.createContact).not.toHaveBeenCalled()
  expect(tx.createPhone).not.toHaveBeenCalled()
  expect(tx.reactivatePhone).not.toHaveBeenCalled()
  expect(tx.promotePhone).not.toHaveBeenCalled()
  expect(tx.createIdentity).not.toHaveBeenCalled()
  expect(tx.updateIdentity).not.toHaveBeenCalled()
  expect(tx.setPrimaryPhone).not.toHaveBeenCalled()
  expect(tx.recordConflict).not.toHaveBeenCalled()
}

describe('SafeContactResolutionExecutor', () => {
  test('scopes provider aliases by account before limiting candidates', async () => {
    const aliases = [
      {
        id: 'identity-account-1',
        contactId: 'contact-1',
        channel: ChatChannel.whatsapp,
        externalId: 'opaque-1@lid',
        phoneId: 'phone-1',
        metadata: {
          providerAccountId: 'wa-account-1',
          providerAliasValues: ['79990000000@c.us'],
        },
      },
      {
        id: 'identity-account-2',
        contactId: 'contact-2',
        channel: ChatChannel.whatsapp,
        externalId: 'opaque-2@lid',
        phoneId: 'phone-2',
        metadata: {
          providerAccountId: 'wa-account-2',
          providerAliasValues: ['79990000000@c.us'],
        },
      },
      {
        id: 'identity-account-3',
        contactId: 'contact-3',
        channel: ChatChannel.whatsapp,
        externalId: 'opaque-3@lid',
        phoneId: 'phone-3',
        metadata: {
          providerAccountId: 'wa-account-3',
          providerAliasValues: ['79990000000@c.us'],
        },
      },
    ]
    const contactIdentity = {
      findUnique: vi.fn(async () => null),
      findMany: vi.fn(async ({ where, take }: {
        where: { AND?: Array<{ metadata?: { path: string[]; equals?: string } }> }
        take: number
      }) => {
        const providerAccountId = where.AND
          ?.find(filter => filter.metadata?.path[0] === 'providerAccountId')
          ?.metadata?.equals
        return aliases
          .filter(candidate => (
            !providerAccountId || candidate.metadata.providerAccountId === providerAccountId
          ))
          .slice(0, take)
      }),
    }
    const tx = createPrismaContactResolutionExecutionTransactionV1({
      contactIdentity,
    } as never)

    await expect(tx.findIdentity(
      ChatChannel.whatsapp,
      'wa-account-3',
      '79990000000@c.us',
    )).resolves.toMatchObject({
      id: 'identity-account-3',
      contactId: 'contact-3',
      externalId: 'opaque-3@lid',
      providerAccountId: 'wa-account-3',
    })
    expect(contactIdentity.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        channel: ChatChannel.whatsapp,
        AND: expect.arrayContaining([
          { metadata: { path: ['providerAliasValues'], array_contains: ['79990000000@c.us'] } },
          { metadata: { path: ['providerAccountId'], equals: 'wa-account-3' } },
        ]),
      }),
      take: 2,
    }))
  })

  test('persists same-account alias multiplicity and never creates a third identity', async () => {
    const decision = plan({ status: 'create_required' })
    const tx = transaction(decision)
    vi.mocked(tx.findIdentity).mockRejectedValue(new ProviderIdentityAliasCollisionError([
      {
        id: 'identity-a', contactId: 'contact-a', channel: ChatChannel.whatsapp,
        externalId: 'opaque-a@lid', providerAccountId: 'wa-account', phoneId: null,
      },
      {
        id: 'identity-b', contactId: 'contact-b', channel: ChatChannel.whatsapp,
        externalId: 'opaque-b@lid', providerAccountId: 'wa-account', phoneId: null,
      },
    ]))

    await expect(executor(decision, tx).executor.execute({
      channel: 'whatsapp',
      externalUserId: '79990000000@c.us',
      providerAccountId: 'wa-account',
      chatKind: 'private',
    })).resolves.toMatchObject({
      status: 'error',
      reason: 'provider_identity_alias_collision',
      contactIds: ['contact-a', 'contact-b'],
    })
    expect(tx.recordConflict).toHaveBeenCalledTimes(2)
    expect(tx.recordConflict).toHaveBeenCalledWith(expect.objectContaining({
      contactId: 'contact-a',
      identityId: 'identity-a',
      conflictType: 'provider_identity_alias_collision',
      otherContactIds: ['contact-b'],
    }))
    expect(tx.createContact).not.toHaveBeenCalled()
    expect(tx.createIdentity).not.toHaveBeenCalled()
  })

  test('locks authoritative resolution state before revalidation', async () => {
    const decision = plan({
      status: 'phone_matched', contactId: 'contact-1', canonicalContactId: 'contact-1',
    })
    const tx = transaction(decision)

    await executor(decision, tx).executor.execute(INPUT)

    expect(tx.lockResolutionState).toHaveBeenCalledOnce()
    expect(vi.mocked(tx.lockResolutionState).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(tx.plan).mock.invocationCallOrder[0])
  })

  test('does not mutate a non-phone channel without an exact sender identity', async () => {
    const decision = plan({ status: 'create_required' })
    const tx = transaction(decision)
    const { executor: resolver } = executor(decision, tx)

    await expect(resolver.execute({ ...INPUT, externalUserId: null })).resolves.toMatchObject({
      status: 'error', reason: 'identity_required',
    })
    expectNoMutation(tx)
  })

  test('reuses an existing exact identity', async () => {
    const decision = plan({ status: 'identity_found', contactId: 'contact-1', canonicalContactId: 'contact-1' })
    const tx = transaction(decision)
    vi.mocked(tx.findIdentity).mockResolvedValue({
      id: 'identity-1', contactId: 'contact-1', channel: ChatChannel.telegram,
      externalId: 'tg-1', providerAccountId: 'legacy', phoneId: 'phone-1',
    })
    const { executor: resolver } = executor(decision, tx)

    await expect(resolver.execute(INPUT)).resolves.toMatchObject({
      status: 'identity_reused', contact: { id: 'contact-1' }, identity: { id: 'identity-1' },
    })
    expect(tx.createIdentity).not.toHaveBeenCalled()
  })

  test('creates an identity-only Contact for a private identity without phone', async () => {
    const decision = plan({ status: 'create_required' })
    const tx = transaction(decision)
    const { executor: resolver } = executor(decision, tx)

    await expect(resolver.execute({
      channel: 'telegram', externalUserId: 'tg-1', chatKind: 'private',
    })).resolves.toMatchObject({
      status: 'created', contact: { id: 'created-contact' },
      identity: { id: 'created-identity' }, phoneId: null,
    })
    expect(tx.createPhone).not.toHaveBeenCalled()
  })

  test('creates Contact, canonical phone and identity when trusted phone owners are zero', async () => {
    const decision = plan({ status: 'create_required' })
    const tx = transaction(decision)
    const { executor: resolver } = executor(decision, tx)

    await expect(resolver.execute(INPUT)).resolves.toMatchObject({
      status: 'created', phoneId: 'created-phone', identity: { id: 'created-identity' },
    })
    expect(tx.createPhone).toHaveBeenCalledWith(expect.objectContaining({
      phone: PHONE, source: ContactPhoneSource.telegram,
    }))
    expect(tx.createIdentity).toHaveBeenCalledWith(expect.objectContaining({ phoneId: 'created-phone' }))
  })

  test('attaches a new identity to one canonical phone owner', async () => {
    const decision = plan({ status: 'phone_matched', contactId: 'contact-1', canonicalContactId: 'contact-1' })
    const tx = transaction(decision)
    const { executor: resolver } = executor(decision, tx)

    await expect(resolver.execute(INPUT)).resolves.toMatchObject({
      status: 'resolved', contact: { id: 'contact-1' }, identity: { id: 'created-identity' },
    })
    expect(tx.createContact).not.toHaveBeenCalled()
    expect(tx.reactivatePhone).not.toHaveBeenCalled()
    expect(tx.promotePhone).not.toHaveBeenCalled()
  })

  test('does no write when phone ownership is ambiguous', async () => {
    const decision = plan({ status: 'ambiguous_phone', candidateContactIds: ['A', 'B'] })
    const tx = transaction(decision)
    const { executor: resolver, unitOfWork } = executor(decision, tx)

    await expect(resolver.execute(INPUT)).resolves.toMatchObject({
      status: 'ambiguous', candidateCount: 2, candidateContactIds: ['A', 'B'],
    })
    expect(unitOfWork.run).toHaveBeenCalledOnce()
    expectNoMutation(tx)
  })

  test('records a durable conflict without changing ownership on identity/phone conflict', async () => {
    const decision = plan({
      status: 'identity_phone_conflict', identityContactId: 'A', phoneContactIds: ['B'],
    })
    const tx = transaction(decision)
    const { executor: resolver } = executor(decision, tx)

    await expect(resolver.execute(INPUT)).resolves.toMatchObject({ status: 'identity_phone_conflict' })
    expect(tx.recordConflict).toHaveBeenCalledWith(expect.objectContaining({
      contactId: 'A',
      otherContactIds: ['B'],
      conflictType: 'stable_identity_phone_contradiction',
    }))
    expect(tx.createContact).not.toHaveBeenCalled()
    expect(tx.createPhone).not.toHaveBeenCalled()
    expect(tx.reactivatePhone).not.toHaveBeenCalled()
    expect(tx.promotePhone).not.toHaveBeenCalled()
    expect(tx.createIdentity).not.toHaveBeenCalled()
    expect(tx.updateIdentity).not.toHaveBeenCalled()
    expect(tx.setPrimaryPhone).not.toHaveBeenCalled()
  })

  test('persists a provider-account key collision and never cross-links its Contact', async () => {
    const decision = plan({ status: 'create_required' })
    const tx = transaction(decision)
    vi.mocked(tx.findIdentity).mockResolvedValue({
      id: 'identity-account-a',
      contactId: 'contact-account-a',
      channel: ChatChannel.max,
      externalId: 'opaque-user',
      providerAccountId: 'account-a',
      phoneId: null,
    })

    await expect(executor(decision, tx).executor.execute({
      channel: 'max',
      providerAccountId: 'account-b',
      externalUserId: 'opaque-user',
      chatKind: 'private',
    })).resolves.toMatchObject({
      status: 'identity_phone_conflict',
      identityContactId: 'contact-account-a',
    })
    expect(tx.recordConflict).toHaveBeenCalledWith(expect.objectContaining({
      contactId: 'contact-account-a',
      identityId: 'identity-account-a',
      conflictType: 'provider_account_identity_collision',
    }))
    expect(tx.createContact).not.toHaveBeenCalled()
    expect(tx.createIdentity).not.toHaveBeenCalled()
    expect(tx.updateIdentity).not.toHaveBeenCalled()
  })

  test('rejects a concrete provider account colliding with a legacy-scoped identity', async () => {
    const decision = plan({ status: 'create_required' })
    const tx = transaction(decision)
    vi.mocked(tx.findIdentity).mockResolvedValue({
      id: 'identity-legacy',
      contactId: 'contact-legacy',
      channel: ChatChannel.max,
      externalId: 'opaque-user',
      providerAccountId: 'legacy',
      phoneId: null,
    })

    await expect(executor(decision, tx).executor.execute({
      channel: 'max',
      providerAccountId: 'account-b',
      externalUserId: 'opaque-user',
      chatKind: 'private',
    })).resolves.toMatchObject({
      status: 'identity_phone_conflict',
      identityContactId: 'contact-legacy',
    })
    expect(tx.recordConflict).toHaveBeenCalledWith(expect.objectContaining({
      identityId: 'identity-legacy',
      conflictType: 'provider_account_identity_collision',
      details: expect.objectContaining({
        storedProviderAccountId: 'legacy',
        requestedProviderAccountId: 'account-b',
      }),
    }))
    expect(tx.createContact).not.toHaveBeenCalled()
    expect(tx.createIdentity).not.toHaveBeenCalled()
    expect(tx.updateIdentity).not.toHaveBeenCalled()
  })

  test.each([
    plan({ status: 'archived_without_merge', contactId: 'A' }),
    plan({ status: 'merge_cycle', contactIds: ['A', 'B'] }),
    plan({ status: 'skipped_group' }),
  ])('does no write for terminal planner result $status', async decision => {
    const tx = transaction(decision)
    await executor(decision, tx).executor.execute(INPUT)
    expectNoMutation(tx)
  })

  test('private MAX with an untrusted phone creates identity-only', async () => {
    const decision = plan({ status: 'untrusted_phone' })
    const tx = transaction(decision)

    await expect(executor(decision, tx).executor.execute({
      channel: 'max', externalUserId: 'max-1', normalizedPhone: PHONE,
      phoneEvidence: { source: 'unknown', trustedForAutomaticResolution: false },
      chatKind: 'private',
    })).resolves.toMatchObject({ status: 'created', phoneId: null })
    expect(tx.createPhone).not.toHaveBeenCalled()
    expect(tx.createIdentity).toHaveBeenCalledWith(expect.objectContaining({ phoneId: null }))
  })

  test('moves an approved merged identity to the canonical survivor', async () => {
    const decision = plan({ status: 'merged_contact', originalContactId: 'A', canonicalContactId: 'C' })
    const tx = transaction(decision)
    vi.mocked(tx.findIdentity).mockResolvedValue({
      id: 'identity-1', contactId: 'A', channel: ChatChannel.telegram,
      externalId: 'tg-1', providerAccountId: 'legacy', phoneId: null,
    })

    await expect(executor(decision, tx).executor.execute({
      channel: 'telegram', externalUserId: 'tg-1', chatKind: 'private',
    })).resolves.toMatchObject({ status: 'identity_reused', contact: { id: 'C' } })
    expect(tx.updateIdentity).toHaveBeenCalledWith({
      identityId: 'identity-1', contactId: 'C', phoneId: null,
    })
  })

  test('ignores a stale outside planner and decides only from admitted state', async () => {
    const admitted = plan({ status: 'ambiguous_phone', candidateContactIds: ['A', 'B'] })
    const initial = plan({ status: 'create_required' })
    const tx = transaction(admitted)
    const { executor: resolver, planner } = executor(initial, tx)

    await expect(resolver.execute(INPUT)).resolves.toMatchObject({
      status: 'ambiguous', candidateContactIds: ['A', 'B'],
    })
    expect(planner.resolve).not.toHaveBeenCalled()
    expectNoMutation(tx)
  })

  test('unknown chat kind reuses exact identity but does not create without one', async () => {
    const exact = plan({ status: 'identity_found', contactId: 'A', canonicalContactId: 'A' })
    const exactTx = transaction(exact)
    vi.mocked(exactTx.findIdentity).mockResolvedValue({
      id: 'identity-1', contactId: 'A', channel: ChatChannel.max, externalId: 'max-1', phoneId: null,
      providerAccountId: 'legacy',
    })
    await expect(executor(exact, exactTx).executor.execute({
      channel: 'max', externalUserId: 'max-1', chatKind: 'unknown', normalizedPhone: PHONE,
      phoneEvidence: { source: 'provider_profile', trustedForAutomaticResolution: true },
    })).resolves.toMatchObject({ status: 'identity_reused', contact: { id: 'A' } })
    expect(exactTx.createPhone).not.toHaveBeenCalled()
    expect(exactTx.reactivatePhone).not.toHaveBeenCalled()

    const limited = plan({ status: 'unknown_kind_limited' })
    const limitedTx = transaction(limited)
    await expect(executor(limited, limitedTx).executor.execute({
      channel: 'max', externalUserId: 'max-2', chatKind: 'unknown',
    })).resolves.toMatchObject({ status: 'unknown_kind_limited' })
    expectNoMutation(limitedTx)
  })

  test('ContactService retries an idempotency race with a fresh executor', async () => {
    const resolved = {
      status: 'identity_reused' as const,
      contact: { id: 'A', displayName: 'A' },
      identity: { id: 'I', channel: ChatChannel.telegram, externalId: '1' },
      phoneId: null,
      isNew: false,
      warnings: [],
    }
    const execute = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('serialization'), { code: 'P2034' }))
      .mockResolvedValueOnce(resolved)
    const factory = vi.spyOn(SafeContactResolutionExecutor, 'fromPrisma')
      .mockReturnValue({ execute } as unknown as SafeContactResolutionExecutor)

    await expect(ContactService.resolveContact('telegram', '1', null, null))
      .resolves.toMatchObject({ status: 'identity_reused', contact: { id: 'A' } })
    expect(factory).toHaveBeenCalledTimes(2)
    expect(execute).toHaveBeenCalledTimes(2)
    factory.mockRestore()
  })
})
