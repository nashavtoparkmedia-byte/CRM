import { describe, expect, test } from 'vitest'
import {
  conversationMatchesContactSearch,
  expandYoVariants,
  normalizeContactPhoneDigits,
  normalizeContactSearchText,
} from '@/lib/contact-search'

const shaburovConversation = {
  name: 'MAX 902158371854',
  channel: 'max',
  externalChatId: '902158371854',
  driver: null,
  contact: {
    displayName: '902158371854',
    canonicalSummary: {
      displayName: 'Шабуров Евгений Анатольевич',
      displayTitle: 'Шабуров Евгений Анатольевич · +7 912 664-67-45',
      primaryPhone: '+7 912 664-67-45',
      currentMainDriverProfile: {
        fullName: 'Шабуров Евгений Анатольевич',
        phone: '+79126646745',
      },
      providerIdentities: [{
        channel: 'max',
        externalId: '902158371854',
        displayName: null,
      }],
    },
  },
}

describe('Contact conversation search', () => {
  test.each([
    'Шабуров Евгений Анатольевич',
    'Шабуров',
    'шабу',
    'Евгений',
    'Анатольевич',
    'Шабуров Евгений',
    'евг анат',
    '  ШАБУРОВ   ЕВГЕНИЙ  ',
  ])('matches canonical name query %s', query => {
    expect(conversationMatchesContactSearch(shaburovConversation, query)).toBe(true)
  })

  test.each([
    '+7 912 664-67-45',
    '79126646745',
    '8 912 664-67-45',
    '89126646745',
    '9126646745',
    '6646745',
  ])('matches normalized phone query %s', query => {
    expect(conversationMatchesContactSearch(shaburovConversation, query)).toBe(true)
  })

  test('rejects a too-short numeric fragment', () => {
    expect(conversationMatchesContactSearch(shaburovConversation, '6745')).toBe(false)
  })

  test('keeps provider id as a technical fallback', () => {
    expect(conversationMatchesContactSearch(shaburovConversation, '902158371854')).toBe(true)
  })

  test('normalizes case, whitespace, Russian phone prefixes and yo', () => {
    expect(normalizeContactSearchText('  АлЁна   Петрова ')).toBe('алена петрова')
    expect(normalizeContactPhoneDigits('8 (912) 664-67-45')).toBe('79126646745')
    expect(normalizeContactPhoneDigits('9126646745')).toBe('79126646745')
    expect(expandYoVariants('федор')).toContain('фёдор')
  })

  test('canonical updates become searchable without changing the message preview', () => {
    const conversation = {
      ...shaburovConversation,
      messages: [{ content: 'Последнее сообщение водителя' }],
    }
    const updated = {
      ...conversation,
      contact: {
        ...conversation.contact,
        canonicalSummary: {
          ...conversation.contact.canonicalSummary,
          displayName: 'Новое Каноническое Имя',
          primaryPhone: '+7 999 123-45-67',
        },
      },
    }

    expect(conversationMatchesContactSearch(updated, 'канонич')).toBe(true)
    expect(conversationMatchesContactSearch(updated, '89991234567')).toBe(true)
    expect(updated.messages[0].content).toBe('Последнее сообщение водителя')
  })
})
