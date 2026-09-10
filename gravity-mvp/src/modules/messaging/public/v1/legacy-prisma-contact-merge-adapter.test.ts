import { describe, expect, test, vi } from 'vitest'

import type { AutomatedMergeRecoveryPlanV1 } from '@/modules/contacts/public/v1/automated-contact-merge-recovery'
import { makeMessagingAutomatedMergeRecoveryRepositoryV1 } from './legacy-prisma-contact-merge-adapter'

const plan: AutomatedMergeRecoveryPlanV1 = {
  mergeId: 'merge-1',
  mergedId: 'source-contact',
  survivorId: 'survivor-contact',
  identityIds: ['source-identity'],
  phoneIds: [],
  chatIds: ['source-chat'],
  taskIds: [],
  callIds: [],
  driverProfileIds: [],
}

describe('Messaging automated Contact merge recovery', () => {
  test('blocks a new survivor chat that references a source-origin identity', async () => {
    const transaction = {
      chat: {
        count: vi.fn(async () => 0),
        findMany: vi.fn(async () => [
          { id: 'source-chat', contactId: 'survivor-contact', contactIdentityId: 'source-identity' },
          { id: 'new-survivor-chat', contactId: 'survivor-contact', contactIdentityId: 'source-identity' },
        ]),
      },
    }
    const repository = makeMessagingAutomatedMergeRecoveryRepositoryV1(transaction as never)

    await expect(repository.canRestore(plan)).resolves.toBe(false)
  })

  test('blocks a planned source chat rebound to a survivor-owned identity', async () => {
    const transaction = {
      chat: {
        count: vi.fn(async () => 0),
        findMany: vi.fn(async () => [
          { id: 'source-chat', contactId: 'survivor-contact', contactIdentityId: 'survivor-identity' },
        ]),
      },
    }
    const repository = makeMessagingAutomatedMergeRecoveryRepositoryV1(transaction as never)

    await expect(repository.canRestore(plan)).resolves.toBe(false)
  })

  test('allows the exact planned chats to retain source-identity or null bindings', async () => {
    const exactPlan = { ...plan, chatIds: ['source-chat', 'source-chat-without-identity'] }
    const transaction = {
      chat: {
        count: vi.fn(async () => 0),
        findMany: vi.fn(async () => [
          { id: 'source-chat', contactId: 'survivor-contact', contactIdentityId: 'source-identity' },
          {
            id: 'source-chat-without-identity',
            contactId: 'survivor-contact',
            contactIdentityId: null,
          },
        ]),
      },
    }
    const repository = makeMessagingAutomatedMergeRecoveryRepositoryV1(transaction as never)

    await expect(repository.canRestore(exactPlan)).resolves.toBe(true)
  })

  test('blocks an unplanned third-Contact chat using a source identity', async () => {
    const findMany = vi.fn(async () => [
      { id: 'source-chat', contactId: 'survivor-contact', contactIdentityId: 'source-identity' },
      { id: 'third-contact-chat', contactId: 'third-contact', contactIdentityId: 'source-identity' },
    ])
    const repository = makeMessagingAutomatedMergeRecoveryRepositoryV1({
      chat: { count: vi.fn(async () => 0), findMany },
    } as never)

    await expect(repository.canRestore(plan)).resolves.toBe(false)
    expect(findMany).toHaveBeenCalledWith({
      where: {
        OR: [
          { id: { in: ['source-chat'] } },
          { contactIdentityId: { in: ['source-identity'] } },
        ],
      },
      select: { id: true, contactId: true, contactIdentityId: true },
    })
  })

  test('blocks recovery when a post-merge chat still references the archived Contact', async () => {
    const planWithoutOriginalChats = { ...plan, chatIds: [], identityIds: [] }
    const findMany = vi.fn()
    const count = vi.fn(async () => 1)
    const repository = makeMessagingAutomatedMergeRecoveryRepositoryV1({
      chat: { count, findMany },
    } as never)

    await expect(repository.canRestore(planWithoutOriginalChats)).resolves.toBe(false)
    expect(count).toHaveBeenCalledWith({ where: { contactId: plan.mergedId } })
    expect(findMany).not.toHaveBeenCalled()
  })

  test('allows unrelated new survivor chats while the planned binding remains intact', async () => {
    const repository = makeMessagingAutomatedMergeRecoveryRepositoryV1({
      chat: {
        count: vi.fn(async () => 0),
        findMany: vi.fn(async () => [
          { id: 'source-chat', contactId: 'survivor-contact', contactIdentityId: 'source-identity' },
          { id: 'new-unrelated-chat', contactId: 'survivor-contact', contactIdentityId: 'survivor-identity' },
        ]),
      },
    } as never)

    await expect(repository.canRestore(plan)).resolves.toBe(true)
  })
})
