import { describe, expect, it } from 'vitest'

import {
  classifyTelegramSharedContact,
  readTelegramSharedContactMedia,
} from '@/lib/telegram-shared-contact'

describe('Telegram shared-contact trust', () => {
  it('trusts only a valid phone explicitly owned by the sender', () => {
    expect(classifyTelegramSharedContact({
      senderTelegramUserId: '100500',
      sharedContactUserId: 100500n,
      phoneNumber: '8 (999) 000-00-00',
      transport: 'bot_webhook',
    })).toEqual({
      senderTelegramUserId: '100500',
      sharedContactUserId: '100500',
      normalizedPhone: '+79990000000',
      trustResult: 'trusted_own_contact',
      trustedForAutomaticEnrichment: true,
    })
  })

  it('marks a foreign shared contact as untrusted evidence', () => {
    expect(classifyTelegramSharedContact({
      senderTelegramUserId: '100500',
      sharedContactUserId: '100501',
      phoneNumber: '+79990000000',
      transport: 'bot_webhook',
    })).toMatchObject({
      trustResult: 'foreign_contact',
      trustedForAutomaticEnrichment: false,
    })
  })

  it('does not infer ownership when Telegram omits contact.user_id', () => {
    expect(classifyTelegramSharedContact({
      senderTelegramUserId: '100500',
      phoneNumber: '+79990000000',
      transport: 'gramjs',
    })).toMatchObject({
      trustResult: 'owner_not_proven',
      trustedForAutomaticEnrichment: false,
    })
  })

  it('rejects invalid phone evidence without guessing from sender data', () => {
    expect(classifyTelegramSharedContact({
      senderTelegramUserId: '100500',
      sharedContactUserId: '100500',
      phoneNumber: '123',
      transport: 'bot_webhook',
    })).toMatchObject({
      normalizedPhone: null,
      trustResult: 'invalid_phone',
      trustedForAutomaticEnrichment: false,
    })
  })

  it('reads a GramJS MessageMediaContact without stringifying metadata into text', () => {
    expect(readTelegramSharedContactMedia({
      className: 'MessageMediaContact',
      phoneNumber: '+79990000000',
      userId: 100500n,
      firstName: 'Ivan',
      lastName: 'Petrov',
      vcard: 'BEGIN:VCARD',
    })).toEqual({
      phoneNumber: '+79990000000',
      userId: '100500',
      firstName: 'Ivan',
      lastName: 'Petrov',
    })
  })
})
