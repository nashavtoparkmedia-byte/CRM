import {
  ChatChannel,
  ContactPhoneSource,
  type Prisma,
  PrismaClient,
} from '@prisma/client'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest'

import { MERGE_CONTACTS_COMMAND_V1 } from '@/contracts/contacts/v1'
import { makeMessagingContactMergeRepositories } from '@/modules/messaging/public/v1/legacy-prisma-contact-merge-adapter'
import {
  createMergeContactsHandlerV1,
  type ContactMergeTransactionalRepositoriesV1,
} from '@/modules/contacts/public/v1'
import {
  makeLegacyPrismaContactMergeRepositoriesV1,
} from '@/modules/contacts/public/v1/legacy-prisma-contact-merge-adapter'
import { makeWorkContactMergeRepositories } from '@/modules/work-management/public/v1/legacy-prisma-contact-merge-adapter'
import { makeCallingContactMergeRepositories } from '@/modules/calling/public/v1/legacy-prisma-contact-merge-adapter'
import { makeFleetContactMergeRepositories } from '@/modules/fleet-operations/public/v1/legacy-prisma-contact-merge-adapter'

import ContactProfileDrawer from '../../app/messages/components/ContactProfileDrawer'
import { MessageService } from '../MessageService'
import { ContactService } from '../ContactService'
import { SafeContactResolutionExecutor } from '../contacts/SafeContactResolutionExecutor'
import type { ContactResolutionInput } from '../contacts/contact-resolution.types'
import { prisma } from '../prisma'

type ListedConversation = Awaited<ReturnType<typeof MessageService.listConversations>>[number]

const uiHarness = vi.hoisted(() => ({
  conversations: [] as ListedConversation[],
  refreshConversations: vi.fn(async () => {}),
  refetchContact: vi.fn(async () => {}),
  useContact: vi.fn(),
}))

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('server-only', () => ({}))
vi.mock('@/app/messages/hooks/useChatNavigation', () => ({
  useChatNavigation: () => ({ toggleProfileDrawer: vi.fn(), updateQuery: vi.fn() }),
}))
vi.mock('@/app/messages/hooks/useConversations', () => ({
  useConversations: () => ({
    conversations: uiHarness.conversations,
    isLoading: false,
    setConversations: vi.fn(),
  }),
  refreshConversations: uiHarness.refreshConversations,
}))
vi.mock('@/app/messages/hooks/useContact', () => ({
  useContact: (contactId: string | undefined) => uiHarness.useContact(contactId),
}))
vi.mock('@/app/messages/hooks/useContactSearch', () => ({
  useContactSearch: () => ({ results: [], loading: false }),
}))
vi.mock('@/app/messages/hooks/useChannelStatus', () => ({
  useChannelStatus: () => ({ channelStatus: {} }),
}))
vi.mock('@/modules/work-management/public/v1/task-view', () => ({
  WorkTaskCreateModalV1: () => null,
}))
vi.mock('@/modules/calling/public/v1/client-ui/CallButton', () => ({ default: () => null }))
vi.mock('@/app/messages/components/DriverTasksWidget', () => ({ default: () => null }))

const TEST_DATABASE_URL = process.env.CONTACT_RESOLUTION_TEST_DATABASE_URL
const REQUIRE_DATABASE = process.env.REQUIRE_CONTACT_RESOLUTION_DB_TESTS === '1'
const PHONE = '+79990000000'
const MANUAL_PHONE = '+79991112233'
const IDENTITY_GATE_KEY = 1_987_654_321
const WRITER_APPLICATION = 'contact-resolution-race-writer'

if (REQUIRE_DATABASE && !TEST_DATABASE_URL) {
  throw new Error('CONTACT_RESOLUTION_TEST_DATABASE_URL is required for the PostgreSQL race suite')
}

const describeWithDatabase = TEST_DATABASE_URL ? describe : describe.skip

function clientUrl(applicationName: string): string | undefined {
  if (!TEST_DATABASE_URL) return undefined
  const parsed = new URL(TEST_DATABASE_URL)
  parsed.searchParams.set('application_name', applicationName)
  return parsed.toString()
}

const writer = TEST_DATABASE_URL
  ? new PrismaClient({ datasourceUrl: clientUrl(WRITER_APPLICATION) })
  : null
const gate = TEST_DATABASE_URL
  ? new PrismaClient({ datasourceUrl: clientUrl('contact-resolution-race-gate') })
  : null
const observer = TEST_DATABASE_URL
  ? new PrismaClient({ datasourceUrl: clientUrl('contact-resolution-race-observer') })
  : null

type Deferred = {
  promise: Promise<void>
  resolve: () => void
}

type WriterOutcome =
  | { kind: 'committed'; value: unknown }
  | { kind: 'rejected'; error: unknown }

type StagedRaceResult = {
  observation: 'blocked' | 'committed' | 'rejected'
  resolution: Awaited<ReturnType<SafeContactResolutionExecutor['execute']>>
  resolutionOrder: number
  writerOrder: number
  writerOutcome: WriterOutcome
}

function deferred(): Deferred {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

async function pollUntil<T>(
  probe: () => Promise<T | null>,
  description: string,
  timeoutMs = 2_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = await probe()
    if (result !== null) return result
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`Timed out waiting for ${description}`)
}

function input(externalUserId: string): ContactResolutionInput {
  return {
    channel: 'telegram',
    externalUserId,
    normalizedPhone: PHONE,
    phoneEvidence: { source: 'provider_profile', trustedForAutomaticResolution: true },
    chatKind: 'private',
  }
}

async function contact(id: string, isArchived = false, displayName = id): Promise<void> {
  await prisma.contact.create({ data: { id, displayName, isArchived } })
}

async function phone(id: string, contactId: string, normalizedPhone = PHONE): Promise<void> {
  await prisma.contactPhone.create({
    data: {
      id,
      contactId,
      phone: normalizedPhone,
      source: ContactPhoneSource.telegram,
      isPrimary: true,
    },
  })
  await prisma.contact.update({
    where: { id: contactId },
    data: { primaryPhoneId: id },
  })
}

async function persistBackendAmbiguity(): Promise<ListedConversation> {
  await contact('A', false, 'Stale Contact Alpha')
  await contact('B', false, 'Candidate Contact Bravo')
  await phone('phone-A', 'A')
  await phone('phone-B', 'B')

  const resolution = await ContactService.resolveContact(
    ChatChannel.max,
    'ambiguous-max-sender',
    PHONE,
    'Ambiguous sender',
    {
      chatKind: 'private',
      phoneEvidence: { source: 'provider_profile', trustedForAutomaticResolution: true },
    },
  )
  if (resolution.status !== 'ambiguous') {
    throw new Error(`Expected backend ambiguity, received ${resolution.status}`)
  }

  await prisma.chat.create({
    data: {
      id: 'ambiguous-chat',
      channel: ChatChannel.max,
      externalChatId: 'ambiguous-max-chat',
      name: 'Ambiguous MAX chat',
      contactId: 'A',
      metadata: {
        contactResolution: {
          status: resolution.status,
          candidateCount: resolution.candidateCount,
          automaticLinkPerformed: false,
        },
      },
    },
  })

  const conversations = await MessageService.listConversations()
  const conversation = conversations.find((item: { id: string }) => item.id === 'ambiguous-chat')
  if (!conversation) throw new Error('Persisted ambiguous chat is absent from conversations')
  return conversation
}

function transactionalMergeRepositories(
  transaction: Prisma.TransactionClient,
): ContactMergeTransactionalRepositoriesV1 {
  const contacts = makeLegacyPrismaContactMergeRepositoriesV1(transaction)
  return {
    contacts: contacts.contacts,
    fleet: makeFleetContactMergeRepositories(transaction),
    messaging: makeMessagingContactMergeRepositories(transaction),
    work: makeWorkContactMergeRepositories(transaction),
    calling: makeCallingContactMergeRepositories(transaction),
  }
}

function createWriterMerge() {
  return createMergeContactsHandlerV1({
    generateMergeRecordId: () => 'merge-A-B',
    log: () => {},
    unitOfWork: {
      async run(operation) {
        return writer!.$transaction(
          async transaction => {
            return operation(transactionalMergeRepositories(transaction))
          },
          { timeout: 15_000 },
        )
      },
    },
  })
}

async function holdIdentityInsertGate(): Promise<{ release: () => void; task: Promise<void> }> {
  const acquired = deferred()
  const release = deferred()
  const task = gate!.$transaction(async transaction => {
    await transaction.$queryRaw`
      SELECT true AS acquired
      FROM (SELECT pg_advisory_xact_lock(${IDENTITY_GATE_KEY})) AS held
    `
    acquired.resolve()
    await release.promise
  }, { timeout: 30_000 })
  await acquired.promise
  return { release: release.resolve, task }
}

async function waitForResolverAtIdentityMutation(): Promise<number> {
  return pollUntil(async () => {
    const rows = await observer!.$queryRaw<Array<{ pid: number }>>`
      SELECT activity.pid
      FROM pg_stat_activity AS activity
      JOIN pg_locks AS waiting
        ON waiting.pid = activity.pid
       AND waiting.locktype = 'advisory'
       AND waiting.granted = false
      WHERE activity.datname = current_database()
        AND activity.query LIKE '%ContactIdentity%'
      LIMIT 1
    `
    return rows[0]?.pid ?? null
  }, 'resolver to pause in the BEFORE INSERT trigger')
}

async function observeWriterBlockedOrSettled(
  outcome: () => WriterOutcome | null,
): Promise<'blocked' | 'committed' | 'rejected'> {
  return pollUntil(async () => {
    const settled = outcome()
    if (settled) return settled.kind

    const rows = await observer!.$queryRaw<Array<{ pid: number }>>`
      SELECT activity.pid
      FROM pg_stat_activity AS activity
      JOIN pg_locks AS waiting
        ON waiting.pid = activity.pid
       AND waiting.granted = false
      WHERE activity.datname = current_database()
        AND activity.application_name <> 'contact-resolution-race-gate'
        AND activity.wait_event_type = 'Lock'
        AND activity.query LIKE '%pg_advisory_xact_lock%'
      LIMIT 1
    `
    return rows.length > 0 ? 'blocked' : null
  }, 'writer relation-lock wait or completion')
}

async function stageRace(
  externalUserId: string,
  writerOperation: () => Promise<unknown>,
): Promise<StagedRaceResult> {
  const identityGate = await holdIdentityInsertGate()
  let sequence = 0
  let resolutionOrder = 0
  let writerOrder = 0
  let writerOutcome: WriterOutcome | null = null

  const resolutionTask = SafeContactResolutionExecutor.fromPrisma()
    .execute(input(externalUserId))
    .then(result => {
      resolutionOrder = ++sequence
      return result
    })

  let writerTask: Promise<WriterOutcome> | null = null
  let observation: StagedRaceResult['observation'] | null = null
  let orchestrationError: unknown = null
  try {
    await waitForResolverAtIdentityMutation()
    writerTask = writerOperation().then(
      value => {
        writerOrder = ++sequence
        writerOutcome = { kind: 'committed', value }
        return writerOutcome
      },
      error => {
        writerOrder = ++sequence
        writerOutcome = { kind: 'rejected', error }
        return writerOutcome
      },
    )
    observation = await observeWriterBlockedOrSettled(() => writerOutcome)
  } catch (error) {
    orchestrationError = error
  } finally {
    identityGate.release()
    await identityGate.task
  }

  const resolutionOutcome = await resolutionTask.then(
    value => ({ kind: 'resolved' as const, value }),
    error => ({ kind: 'rejected' as const, error }),
  )
  const completedWriter = await writerTask
  if (orchestrationError) throw orchestrationError
  if (resolutionOutcome.kind === 'rejected') throw resolutionOutcome.error
  if (!completedWriter || !observation) {
    throw new Error('Race orchestration did not start the ownership writer')
  }
  return {
    observation,
    resolution: resolutionOutcome.value,
    resolutionOrder,
    writerOrder,
    writerOutcome: completedWriter,
  }
}

describeWithDatabase.sequential('SafeContactResolutionExecutor PostgreSQL races', () => {
  beforeAll(async () => {
    if (process.env.DATABASE_URL !== TEST_DATABASE_URL) {
      throw new Error('DATABASE_URL must equal CONTACT_RESOLUTION_TEST_DATABASE_URL')
    }

    const parsed = new URL(TEST_DATABASE_URL!)
    const isLoopback = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost'
    if (!isLoopback || !parsed.pathname.includes('contact_resolution')) {
      throw new Error('race suite refuses a non-local or non-contact_resolution database')
    }

    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION contact_resolution_test_pause_identity_insert()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $trigger$
      BEGIN
        IF NEW."externalId" LIKE 'n1-race-%' THEN
          PERFORM pg_advisory_xact_lock(${IDENTITY_GATE_KEY});
        END IF;
        RETURN NEW;
      END
      $trigger$
    `)
    await prisma.$executeRawUnsafe(
      'DROP TRIGGER IF EXISTS contact_resolution_test_pause_identity_insert ON "ContactIdentity"',
    )
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER contact_resolution_test_pause_identity_insert
      BEFORE INSERT ON "ContactIdentity"
      FOR EACH ROW
      EXECUTE FUNCTION contact_resolution_test_pause_identity_insert()
    `)
  })

  beforeEach(async () => {
    cleanup()
    uiHarness.conversations = []
    uiHarness.refreshConversations.mockReset()
    uiHarness.refetchContact.mockReset()
    uiHarness.useContact.mockReset()
    uiHarness.useContact.mockImplementation(() => ({
      contact: null,
      isLoading: false,
      refetch: uiHarness.refetchContact,
    }))
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ContactIdentity", "ContactPhone", "ContactMerge", "Contact" CASCADE',
    )
  })

  afterEach(() => {
    cleanup()
  })

  afterAll(async () => {
    if (TEST_DATABASE_URL) {
      await prisma.$executeRawUnsafe(
        'DROP TRIGGER IF EXISTS contact_resolution_test_pause_identity_insert ON "ContactIdentity"',
      )
      await prisma.$executeRawUnsafe(
        'DROP FUNCTION IF EXISTS contact_resolution_test_pause_identity_insert()',
      )
    }
    await Promise.all([
      writer?.$disconnect(),
      gate?.$disconnect(),
      observer?.$disconnect(),
      prisma.$disconnect(),
    ])
  })

  test('Race A: a 1→2 owner writer cannot commit after revalidation but before identity mutation', async () => {
    await contact('A')
    await contact('B')
    await phone('phone-A', 'A')

    const race = await stageRace('n1-race-owner', () => ContactService.addPhoneToContact('B', PHONE))

    expect(race.observation).toBe('blocked')
    expect(race.writerOutcome).toMatchObject({
      kind: 'committed',
      value: { kind: 'conflict', otherContactId: 'A' },
    })
    expect(race.resolutionOrder).toBeLessThan(race.writerOrder)
    expect(race.resolution).toMatchObject({ status: 'resolved', contact: { id: 'A' } })
    await expect(prisma.contactIdentity.findUnique({
      where: {
        channel_externalId: {
          channel: ChatChannel.telegram, externalId: 'n1-race-owner',
        },
      },
    })).resolves.toMatchObject({ contactId: 'A' })
    await expect(prisma.contactPhone.count({
      where: { phone: PHONE, isActive: true },
    })).resolves.toBe(1)
  }, 20_000)

  test('Race B: accepted A→B merge cannot leave an identity on archived A', async () => {
    await contact('A')
    await contact('B')
    await phone('phone-A', 'A')
    const mergeContacts = createWriterMerge()

    const race = await stageRace('n1-race-merge', () => mergeContacts({
      contract: MERGE_CONTACTS_COMMAND_V1,
      operation: 'contact_to_contact',
      sourceId: 'A',
      targetId: 'B',
      mergedBy: 'n1-race-test',
    }))

    expect(race.observation).toBe('blocked')
    expect(race.writerOutcome).toMatchObject({
      kind: 'committed',
      value: { status: 'contact_merged', survivorId: 'B', mergedId: 'A' },
    })
    expect(race.resolutionOrder).toBeLessThan(race.writerOrder)
    await expect(prisma.contactIdentity.findUnique({
      where: {
        channel_externalId: {
          channel: ChatChannel.telegram, externalId: 'n1-race-merge',
        },
      },
    })).resolves.toMatchObject({ contactId: 'B' })
    await expect(prisma.contactPhone.findUnique({ where: { id: 'phone-A' } }))
      .resolves.toMatchObject({ contactId: 'B' })
    await expect(prisma.contact.findUnique({ where: { id: 'A' } }))
      .resolves.toMatchObject({ isArchived: true })
    await expect(prisma.contactMerge.findUnique({ where: { id: 'merge-A-B' } }))
      .resolves.toMatchObject({ survivorId: 'B', mergedId: 'A', action: 'merge' })
  }, 20_000)

  test('Race C: an A→C canonical edge remains stable against a conflicting owner write', async () => {
    await contact('A', true)
    await contact('B')
    await contact('C')
    await phone('phone-C', 'C')
    await prisma.contactMerge.create({
      data: {
        id: 'merge-A-C', survivorId: 'C', mergedId: 'A', reason: 'manual', snapshotBefore: {},
      },
    })

    const race = await stageRace(
      'n1-race-same-survivor',
      () => ContactService.addPhoneToContact('B', PHONE),
    )

    expect(race.observation).toBe('blocked')
    expect(race.writerOutcome).toMatchObject({
      kind: 'committed',
      value: { kind: 'conflict', otherContactId: 'C' },
    })
    expect(race.resolutionOrder).toBeLessThan(race.writerOrder)
    expect(race.resolution).toMatchObject({ status: 'resolved', contact: { id: 'C' } })
    await expect(prisma.contactIdentity.findUnique({
      where: {
        channel_externalId: {
          channel: ChatChannel.telegram,
          externalId: 'n1-race-same-survivor',
        },
      },
    })).resolves.toMatchObject({ contactId: 'C' })
    await expect(prisma.contactPhone.findUnique({ where: { id: 'phone-C' } }))
      .resolves.toMatchObject({ contactId: 'C' })

    const repeated = await SafeContactResolutionExecutor.fromPrisma()
      .execute(input('n1-race-same-survivor-repeat'))
    expect(repeated).toMatchObject({ status: 'resolved', contact: { id: 'C' } })
    await expect(prisma.contactPhone.count({
      where: { contactId: 'C', phone: PHONE, isActive: true },
    })).resolves.toBe(1)
  }, 20_000)

  test('Race D: resolver, writer and observer use independent PostgreSQL backends', async () => {
    const [resolverPid, writerPid, observerPid] = await Promise.all([
      prisma.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`,
      writer!.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`,
      observer!.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`,
    ])
    expect(new Set([resolverPid[0].pid, writerPid[0].pid, observerPid[0].pid]).size).toBe(3)
  })

  test('persisted backend ambiguity reaches conversations and the real Drawer fail-closed', async () => {
    const conversation = await persistBackendAmbiguity()
    const resolutionMetadata = conversation.metadata.contactResolution

    expect(resolutionMetadata).toEqual({
      status: 'ambiguous',
      candidateCount: 2,
      automaticLinkPerformed: false,
    })
    expect(resolutionMetadata).not.toHaveProperty('candidateContactIds')
    expect(conversation.contactId).toBe('A')

    uiHarness.conversations = [conversation]
    const view = render(createElement(ContactProfileDrawer, { chatId: conversation.id }))

    expect(screen.getByRole('alert').textContent).toContain('Не удалось автоматически связать контакт')
    expect(screen.getByRole('alert').textContent).toContain('Найдено подходящих карточек: 2')
    expect(screen.getByRole('button', { name: /Найти и привязать вручную/ })).toBeTruthy()
    expect(uiHarness.useContact).toHaveBeenCalledWith(undefined)
    expect(view.container.textContent).not.toContain('Stale Contact Alpha')
    expect(view.container.textContent).not.toContain('Candidate Contact Bravo')

    await expect(prisma.contactIdentity.count()).resolves.toBe(0)
    await expect(prisma.contactMerge.count()).resolves.toBe(0)
    await expect(prisma.chat.findUnique({ where: { id: conversation.id } }))
      .resolves.toMatchObject({ contactId: 'A' })
  })

  test('manual ambiguity action fails closed when no stable provider identity was persisted', async () => {
    const conversation = await persistBackendAmbiguity()
    await contact('C')
    await phone('phone-C', 'C', MANUAL_PHONE)
    await prisma.driver.create({
      data: {
        id: 'manual-driver',
        yandexDriverId: 'manual-yandex-driver',
        fullName: 'Manual Driver',
        phone: MANUAL_PHONE,
      },
    })

    uiHarness.conversations = [conversation]
    const view = render(createElement(ContactProfileDrawer, { chatId: conversation.id }))
    fireEvent.click(screen.getByRole('button', { name: /Найти и привязать вручную/ }))
    expect(screen.getByRole('heading', { name: 'Привязать к водителю' })).toBeTruthy()

    fireEvent.change(screen.getByPlaceholderText('Поиск по ФИО или телефону...'), {
      target: { value: 'Manual Driver' },
    })
    const result = await screen.findByText('Manual Driver', {}, { timeout: 3_000 })
    const resultButton = result.closest('button')
    if (!resultButton) throw new Error('Manual driver search result is not actionable')
    fireEvent.click(resultButton)

    await waitFor(() => {
      expect(screen.getByText(/Стабильный идентификатор канала не сохранён/)).toBeTruthy()
    }, { timeout: 5_000 })

    await expect(prisma.chat.findUnique({ where: { id: conversation.id } }))
      .resolves.toMatchObject({
        contactId: 'A',
        contactIdentityId: null,
        driverId: null,
        metadata: {
          contactResolution: {
            status: 'ambiguous',
            candidateCount: 2,
            automaticLinkPerformed: false,
          },
        },
      })
    await expect(prisma.contactIdentity.count()).resolves.toBe(0)
    await expect(prisma.contactMerge.count()).resolves.toBe(0)
    expect(view.container.textContent).toContain('Не удалось автоматически связать контакт')
    expect(screen.getByRole('heading', { name: 'Привязать к водителю' })).toBeTruthy()
  }, 15_000)
})
