import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import { selectCanonicalContactChannelIdentities } from '@/lib/contact-profile-ui'
import type {
  ContactChatPayload,
  ContactIdentityPayload,
  ContactPhonePayload,
} from '@/lib/contact-profile-contract'

const phone: ContactPhonePayload = {
  id: 'phone-1',
  phone: '+7 912 678-75-32',
  label: null,
  isPrimary: true,
  source: 'manual',
}

function identity(
  id: string,
  externalId: string,
  phoneId: string | null,
  reachabilityStatus: ContactIdentityPayload['reachabilityStatus'],
  personalMaxRouteKnown = false,
): ContactIdentityPayload {
  return {
    id,
    channel: 'max',
    externalId,
    phoneId,
    displayName: null,
    source: 'auto',
    confidence: 1,
    reachabilityStatus,
    reachabilityCheckedAt: null,
    personalMaxRouteKnown,
  }
}

function chat(identityId: string, externalChatId: string): ContactChatPayload {
  return {
    id: `chat-${identityId}`,
    channel: 'max',
    externalChatId,
    contactIdentityId: identityId,
    lastMessageAt: null,
    unreadCount: 0,
    status: 'open',
    name: null,
  }
}

describe('canonical Contact channel identity selection', () => {
  test('collapses a phone reachability placeholder into the routed MAX identity', () => {
    const selected = selectCanonicalContactChannelIdentities({
      phones: [phone],
      identities: [
        identity('phone-placeholder', '79126787532', 'phone-1', 'confirmed'),
        identity('provider-route', '902454841098', null, 'unreachable'),
      ],
      chats: [chat('provider-route', '902454841098')],
    })

    expect(selected).toHaveLength(1)
    expect(selected[0]).toMatchObject({
      id: 'provider-route',
      externalId: '902454841098',
      reachabilityStatus: 'confirmed',
    })
  })

  test('keeps two distinct routed MAX accounts while suppressing only the phone placeholder', () => {
    const selected = selectCanonicalContactChannelIdentities({
      phones: [phone],
      identities: [
        identity('phone-placeholder', '79126787532', 'phone-1', 'confirmed'),
        identity('provider-route-1', '902454841098', null, 'confirmed'),
        identity('provider-route-2', '902999000111', null, 'unknown'),
      ],
      chats: [
        chat('provider-route-1', '902454841098'),
        chat('provider-route-2', '902999000111'),
      ],
    })

    expect(selected.map(item => item.id)).toEqual(['provider-route-1', 'provider-route-2'])
  })

  test('feeds only canonical identities into the Contact profile channel rows', () => {
    const drawer = readFileSync(
      resolve(process.cwd(), 'src/app/messages/components/ContactProfileDrawer.tsx'),
      'utf8',
    )

    expect(drawer).toContain('selectCanonicalContactChannelIdentities({')
    expect(drawer).toContain('identities: canonicalIdentities.filter')
    expect(drawer).toContain('const orphanIdentities = canonicalIdentities.filter')
  })

  test('keeps a phone identity when there is no routed provider identity', () => {
    const selected = selectCanonicalContactChannelIdentities({
      phones: [phone],
      identities: [
        identity('phone-placeholder', '79126787532', 'phone-1', 'confirmed'),
      ],
      chats: [],
    })

    expect(selected.map(item => item.id)).toEqual(['phone-placeholder'])
  })

  test('preserves durable route knowledge when phone placeholders are collapsed', () => {
    const selected = selectCanonicalContactChannelIdentities({
      phones: [phone],
      identities: [
        identity('phone-placeholder', '79126787532', 'phone-1', 'confirmed', true),
        identity('provider-route', '902454841098', null, 'unknown'),
      ],
      chats: [chat('provider-route', '902454841098')],
    })

    expect(selected).toHaveLength(1)
    expect(selected[0]).toMatchObject({
      id: 'provider-route',
      personalMaxRouteKnown: true,
      reachabilityStatus: 'confirmed',
    })
  })

  test('collapses an unlinked MAX protocol chat alias into the routed provider identity', () => {
    const selected = selectCanonicalContactChannelIdentities({
      phones: [phone],
      identities: [
        identity('phone-placeholder', '79126787532', 'phone-1', 'confirmed'),
        identity('protocol-alias', '902454841098', null, 'confirmed', true),
        identity('provider-route', '902264026154', null, 'unknown'),
      ],
      chats: [chat('provider-route', '902454841098')],
    })

    expect(selected).toHaveLength(1)
    expect(selected[0]).toMatchObject({
      id: 'provider-route',
      externalId: '902264026154',
      personalMaxRouteKnown: true,
      reachabilityStatus: 'confirmed',
    })
  })
})
