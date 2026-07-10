import { readFileSync } from 'fs'
import path from 'path'
import { describe, expect, test, vi } from 'vitest'

import { ContactResolutionService } from '../contacts/ContactResolutionService'
import type {
  ContactMergeEdge,
  ContactResolutionInput,
  ContactResolutionRepository,
  ContactResolutionResult,
  ResolutionContact,
} from '../contacts/contact-resolution.types'

const PHONE = '+79990000000'

function contact(id: string, isArchived = false): ResolutionContact {
  return { id, isArchived }
}

function edge(mergedId: string, survivor: ResolutionContact): ContactMergeEdge {
  return { mergedId, survivor }
}

function trustedPhone(source: NonNullable<ContactResolutionInput['phoneEvidence']>['source'] = 'provider_profile') {
  return { source, trustedForAutomaticResolution: true } as const
}

function repository(options: {
  identities?: Record<string, ResolutionContact | null>
  phoneOwners?: ResolutionContact[]
  merges?: Record<string, ContactMergeEdge[]>
} = {}) {
  const repo: ContactResolutionRepository = {
    findIdentity: vi.fn(async (channel, externalUserId) =>
      options.identities?.[`${channel}:${externalUserId}`] ?? null,
    ),
    findActivePhoneOwners: vi.fn(async () => options.phoneOwners ?? []),
    findMergesFromContact: vi.fn(async contactId => options.merges?.[contactId] ?? []),
  }
  return repo as ContactResolutionRepository & {
    findIdentity: ReturnType<typeof vi.fn>
    findActivePhoneOwners: ReturnType<typeof vi.fn>
    findMergesFromContact: ReturnType<typeof vi.fn>
  }
}

function service(options: Parameters<typeof repository>[0] = {}) {
  const repo = repository(options)
  return { repo, resolver: new ContactResolutionService(repo) }
}

describe('ContactResolutionService read-only planner', () => {
  test('resolves a private MAX identity to an active Contact', async () => {
    const { resolver } = service({ identities: { 'max:max-user-1': contact('contact-1') } })

    await expect(resolver.resolve({ channel: 'max', externalUserId: 'max-user-1', chatKind: 'private' }))
      .resolves.toMatchObject({ status: 'identity_found', contactId: 'contact-1', canonicalContactId: 'contact-1' })
  })

  test('returns the same Contact on repeated identity resolution', async () => {
    const { resolver } = service({ identities: { 'max:max-user-1': contact('contact-1') } })
    const input = { channel: 'max' as const, externalUserId: 'max-user-1' }

    const first = await resolver.resolve(input)
    const second = await resolver.resolve(input)

    expect(first).toMatchObject({ status: 'identity_found', canonicalContactId: 'contact-1' })
    expect(second).toMatchObject({ status: 'identity_found', canonicalContactId: 'contact-1' })
  })

  test('follows a merged identity source A to survivor B', async () => {
    const { resolver } = service({
      identities: { 'max:max-user-1': contact('A', true) },
      merges: { A: [edge('A', contact('B'))] },
    })

    await expect(resolver.resolve({ channel: 'max', externalUserId: 'max-user-1' }))
      .resolves.toMatchObject({ status: 'merged_contact', originalContactId: 'A', canonicalContactId: 'B' })
  })

  test('follows a merge chain A to B to C', async () => {
    const { resolver } = service({
      identities: { 'max:max-user-1': contact('A', true) },
      merges: { A: [edge('A', contact('B', true))], B: [edge('B', contact('C'))] },
    })

    await expect(resolver.resolve({ channel: 'max', externalUserId: 'max-user-1' }))
      .resolves.toMatchObject({ status: 'merged_contact', originalContactId: 'A', canonicalContactId: 'C' })
  })

  test('returns merge_cycle for A to B to A', async () => {
    const { resolver } = service({
      identities: { 'max:max-user-1': contact('A', true) },
      merges: { A: [edge('A', contact('B', true))], B: [edge('B', contact('A', true))] },
    })

    await expect(resolver.resolve({ channel: 'max', externalUserId: 'max-user-1' }))
      .resolves.toMatchObject({ status: 'merge_cycle', contactIds: ['A', 'B'] })
  })

  test('returns archived_without_merge instead of treating an archived Contact as active', async () => {
    const { resolver } = service({ identities: { 'max:max-user-1': contact('A', true) } })

    await expect(resolver.resolve({ channel: 'max', externalUserId: 'max-user-1' }))
      .resolves.toMatchObject({ status: 'archived_without_merge', contactId: 'A' })
  })

  test('requires creation when no identity and no phone are supplied', async () => {
    const { resolver } = service()

    await expect(resolver.resolve({ channel: 'max' })).resolves.toMatchObject({ status: 'create_required' })
  })

  test('matches exactly one owner of a trusted phone', async () => {
    const { resolver } = service({ phoneOwners: [contact('phone-contact')] })

    await expect(resolver.resolve({ channel: 'max', normalizedPhone: PHONE, phoneEvidence: trustedPhone() }))
      .resolves.toMatchObject({ status: 'phone_matched', contactId: 'phone-contact' })
  })

  test('returns ambiguous_phone for two different canonical phone owners', async () => {
    const { resolver } = service({ phoneOwners: [contact('B'), contact('A')] })

    await expect(resolver.resolve({ channel: 'max', normalizedPhone: PHONE, phoneEvidence: trustedPhone() }))
      .resolves.toMatchObject({ status: 'ambiguous_phone', candidateContactIds: ['A', 'B'] })
  })

  test('treats two merged phone records with one survivor as one canonical owner', async () => {
    const { resolver } = service({
      phoneOwners: [contact('B', true), contact('A', true)],
      merges: { A: [edge('A', contact('C'))], B: [edge('B', contact('C'))] },
    })

    await expect(resolver.resolve({ channel: 'max', normalizedPhone: PHONE, phoneEvidence: trustedPhone() }))
      .resolves.toMatchObject({ status: 'merged_contact', originalContactId: 'A', canonicalContactId: 'C' })
  })

  test('keeps identity_found when identity and trusted phone resolve to one canonical Contact', async () => {
    const { resolver } = service({
      identities: { 'telegram:1001': contact('C') },
      phoneOwners: [contact('A', true)],
      merges: { A: [edge('A', contact('C'))] },
    })

    await expect(resolver.resolve({
      channel: 'telegram', externalUserId: '1001', normalizedPhone: PHONE, phoneEvidence: trustedPhone(),
    })).resolves.toMatchObject({ status: 'identity_found', canonicalContactId: 'C' })
  })

  test('returns identity_phone_conflict when identity and trusted phone point to different Contacts', async () => {
    const { resolver } = service({
      identities: { 'telegram:1001': contact('identity-contact') },
      phoneOwners: [contact('phone-contact')],
    })

    await expect(resolver.resolve({
      channel: 'telegram', externalUserId: '1001', normalizedPhone: PHONE, phoneEvidence: trustedPhone(),
    })).resolves.toMatchObject({
      status: 'identity_phone_conflict', identityContactId: 'identity-contact', phoneContactIds: ['phone-contact'],
    })
  })

  test('does not let an identity silently win over two trusted phone owners', async () => {
    const { resolver } = service({
      identities: { 'telegram:1001': contact('identity-contact') },
      phoneOwners: [contact('phone-a'), contact('phone-b')],
    })

    await expect(resolver.resolve({
      channel: 'telegram', externalUserId: '1001', normalizedPhone: PHONE, phoneEvidence: trustedPhone(),
    })).resolves.toMatchObject({
      status: 'identity_phone_conflict', phoneContactIds: ['phone-a', 'phone-b'],
    })
  })

  test('never uses a phone extracted from message text for automatic resolution', async () => {
    const { repo, resolver } = service({ phoneOwners: [contact('phone-contact')] })

    await expect(resolver.resolve({
      channel: 'max', normalizedPhone: PHONE, phoneEvidence: trustedPhone('message_text'),
    })).resolves.toMatchObject({ status: 'untrusted_phone' })
    expect(repo.findActivePhoneOwners).not.toHaveBeenCalled()
  })

  test('permits a trusted WhatsApp phone JID in phone resolution', async () => {
    const { repo, resolver } = service({ phoneOwners: [contact('wa-contact')] })

    await expect(resolver.resolve({
      channel: 'whatsapp', externalUserId: '79990000000@c.us', normalizedPhone: PHONE,
      phoneEvidence: trustedPhone('whatsapp_phone_jid'),
    })).resolves.toMatchObject({ status: 'phone_matched', canonicalContactId: 'wa-contact' })
    expect(repo.findActivePhoneOwners).toHaveBeenCalledWith(PHONE)
  })

  test('does not use an unresolved WhatsApp LID without trusted phone evidence', async () => {
    const { repo, resolver } = service({ phoneOwners: [contact('wa-contact')] })

    await expect(resolver.resolve({
      channel: 'whatsapp', externalUserId: 'opaque-lid@lid', normalizedPhone: PHONE,
      phoneEvidence: { source: 'unknown', trustedForAutomaticResolution: false },
    })).resolves.toMatchObject({ status: 'untrusted_phone' })
    expect(repo.findActivePhoneOwners).not.toHaveBeenCalled()
  })

  test('does not use a Telegram username as an identity', async () => {
    const { repo, resolver } = service({ identities: { 'telegram:driver_name': contact('wrong-contact') } })

    await expect(resolver.resolve({ channel: 'telegram', username: 'driver_name' }))
      .resolves.toMatchObject({ status: 'create_required' })
    expect(repo.findIdentity).not.toHaveBeenCalled()
  })

  test('uses a Telegram private user ID as identity', async () => {
    const { resolver } = service({ identities: { 'telegram:12345': contact('telegram-contact') } })

    await expect(resolver.resolve({ channel: 'telegram', externalUserId: '12345', chatKind: 'private' }))
      .resolves.toMatchObject({ status: 'identity_found', canonicalContactId: 'telegram-contact' })
  })

  test('skips Telegram groups before any identity or phone lookup', async () => {
    const { repo, resolver } = service({ phoneOwners: [contact('wrong-contact')] })

    await expect(resolver.resolve({
      channel: 'telegram', chatKind: 'group', externalUserId: 'group-id', normalizedPhone: PHONE, phoneEvidence: trustedPhone(),
    })).resolves.toMatchObject({ status: 'skipped_group' })
    expect(repo.findIdentity).not.toHaveBeenCalled()
    expect(repo.findActivePhoneOwners).not.toHaveBeenCalled()
  })

  test('does not substitute MAX externalChatId for externalUserId', async () => {
    const { repo, resolver } = service({ identities: { 'max:max-chat-id': contact('wrong-contact') } })

    await expect(resolver.resolve({ channel: 'max', externalChatId: 'max-chat-id' }))
      .resolves.toMatchObject({ status: 'create_required' })
    expect(repo.findIdentity).not.toHaveBeenCalled()
  })

  test('warns that provider account scope is not persisted', async () => {
    const { resolver } = service()

    const result = await resolver.resolve({ channel: 'max', providerAccountId: 'account-1' })

    expect(result.warnings).toContain('provider_account_scope_not_persisted')
  })

  test('invalid or empty values do not trigger arbitrary lookups', async () => {
    const { repo, resolver } = service()

    await expect(resolver.resolve({
      channel: 'max', externalUserId: '   ', normalizedPhone: 'not-a-phone', phoneEvidence: trustedPhone(),
    })).resolves.toMatchObject({ status: 'invalid_input' })
    expect(repo.findIdentity).not.toHaveBeenCalled()
    expect(repo.findActivePhoneOwners).not.toHaveBeenCalled()
  })

  test('database candidate order does not affect an ambiguous result', async () => {
    const first = service({ phoneOwners: [contact('B'), contact('A')] }).resolver
    const second = service({ phoneOwners: [contact('A'), contact('B')] }).resolver
    const input = { channel: 'max' as const, normalizedPhone: PHONE, phoneEvidence: trustedPhone() }

    await expect(first.resolve(input)).resolves.toMatchObject({ status: 'ambiguous_phone', candidateContactIds: ['A', 'B'] })
    await expect(second.resolve(input)).resolves.toMatchObject({ status: 'ambiguous_phone', candidateContactIds: ['A', 'B'] })
  })

  test('returns explicit typed result statuses rather than null', async () => {
    const statuses: ContactResolutionResult['status'][] = [
      'identity_found', 'phone_matched', 'create_required', 'ambiguous_phone', 'identity_phone_conflict',
      'merged_contact', 'archived_without_merge', 'skipped_group', 'untrusted_phone', 'invalid_input',
      'merge_cycle', 'merge_ambiguous', 'merge_depth_exceeded',
    ]
    const { resolver } = service()
    const result: ContactResolutionResult = await resolver.resolve({ channel: 'max' })

    expect(statuses).toContain(result.status)
    expect(result).not.toBeNull()
  })

  test('contains no mutation calls and is not imported by channel webhooks', () => {
    const root = path.join(process.cwd(), 'src')
    const serviceSource = readFileSync(path.join(root, 'lib/contacts/ContactResolutionService.ts'), 'utf8')

    expect(serviceSource).not.toMatch(/\.(create|update|upsert|delete|deleteMany|updateMany)\(/)
    for (const file of [
      'app/api/webhooks/max/route.ts',
      'app/api/webhook/max/route.ts',
      'app/api/webhook/telegram/route.ts',
    ]) {
      expect(readFileSync(path.join(root, file), 'utf8')).not.toContain('ContactResolutionService')
    }
  })
})
