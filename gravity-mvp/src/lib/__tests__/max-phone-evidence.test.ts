import { describe, expect, test } from 'vitest'

import { resolveMaxPhoneEvidence } from '@/lib/contacts/max-phone-evidence'

const now = () => new Date('2026-07-18T11:00:00.000Z')

describe('MAX phone evidence trust boundary', () => {
  test('a bare senderPhone is an untrusted observation', () => {
    expect(resolveMaxPhoneEvidence('+7 922 215-57-50', null, { now })).toEqual({
      normalizedPhone: '+79222155750',
      sourceKind: 'unknown',
      trustedForAutomaticResolution: false,
      observedAt: '2026-07-18T11:00:00.000Z',
      providerIdentityId: null,
      protocolChatId: null,
      uiRouteId: null,
      trustResult: 'untrusted_source',
    })
  })

  test('provider profile evidence is trusted only with an explicit route binding', () => {
    expect(resolveMaxPhoneEvidence('89222155750', {
      sourceKind: 'provider_profile',
      trustedForAutomaticResolution: true,
      observedAt: '2026-07-18T10:30:00Z',
      providerIdentityId: '902264026154',
      protocolChatId: '902454841098',
      uiRouteId: '511708938',
    }, {
      now,
      externalChatId: '902454841098',
      senderId: '902264026154',
    })).toEqual({
      normalizedPhone: '+79222155750',
      sourceKind: 'provider_profile',
      trustedForAutomaticResolution: true,
      observedAt: '2026-07-18T10:30:00.000Z',
      providerIdentityId: '902264026154',
      protocolChatId: '902454841098',
      uiRouteId: '511708938',
      trustResult: 'bound_provider_profile',
    })
    expect(resolveMaxPhoneEvidence('89222155750', {
      sourceKind: 'provider_profile',
      trustedForAutomaticResolution: false,
    }, { now }).trustedForAutomaticResolution).toBe(false)
  })

  test('a profile phone with a mismatched route cannot claim CRM ownership', () => {
    expect(resolveMaxPhoneEvidence('89222155750', {
      sourceKind: 'provider_profile',
      trustedForAutomaticResolution: true,
      providerIdentityId: '902264026154',
      protocolChatId: '902454841098',
      uiRouteId: '902454841098',
    }, {
      now,
      externalChatId: '902454841098',
      senderId: '902264026154',
    })).toMatchObject({
      trustedForAutomaticResolution: false,
      trustResult: 'unbound_provider_profile',
    })
  })

  test.each(['unknown', 'message_text', 'shared_contact', 'manual_verified', 'spoofed'])(
    'source %s cannot self-assert MAX provider trust',
    sourceKind => {
      expect(resolveMaxPhoneEvidence('+79222155750', {
        sourceKind,
        trustedForAutomaticResolution: true,
      }, { now }).trustedForAutomaticResolution).toBe(false)
    },
  )

  test('invalid phone never becomes trusted', () => {
    expect(resolveMaxPhoneEvidence('not-a-phone', {
      sourceKind: 'provider_profile',
      trustedForAutomaticResolution: true,
    }, { now })).toMatchObject({
      normalizedPhone: null,
      trustedForAutomaticResolution: false,
    })
  })
})
