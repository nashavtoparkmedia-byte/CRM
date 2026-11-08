import { describe, expect, it } from 'vitest'
import {
  CONTACT_PERSON_CARD_QUERY_V1,
  ContactPersonCardValidationError,
  parseContactPersonCardQueryV1,
} from './contact-person-card-contracts'

describe('parseContactPersonCardQueryV1', () => {
  it('accepts exactly the contract and an exact Contact id', () => {
    expect(parseContactPersonCardQueryV1({ contract: CONTACT_PERSON_CARD_QUERY_V1, contactId: 'c-1' }))
      .toEqual({ contract: CONTACT_PERSON_CARD_QUERY_V1, contactId: 'c-1' })
  })

  it('rejects a padded, empty or non-string id without normalizing it', () => {
    for (const contactId of [' c-1', 'c-1 ', '', 7, null, undefined]) {
      expect(() => parseContactPersonCardQueryV1({ contract: CONTACT_PERSON_CARD_QUERY_V1, contactId }))
        .toThrow(ContactPersonCardValidationError)
    }
  })

  it('rejects any other key, so no phone, name, username or provider id can steer the read', () => {
    for (const extra of ['phone', 'displayName', 'username', 'externalId', 'chatId', 'driverId']) {
      expect(() => parseContactPersonCardQueryV1({ contract: CONTACT_PERSON_CARD_QUERY_V1, contactId: 'c-1', [extra]: 'x' }))
        .toThrow(/unsupported field/)
    }
  })

  it('distinguishes an unsupported version from an unrelated contract', () => {
    expect(() => parseContactPersonCardQueryV1({ contract: 'contacts.ContactPersonCardQuery.v2', contactId: 'c-1' }))
      .toThrow(/unsupported contract version/)
    expect(() => parseContactPersonCardQueryV1({ contract: 'contacts.Other.v1', contactId: 'c-1' }))
      .toThrow(/contract must equal/)
    expect(() => parseContactPersonCardQueryV1(null)).toThrow(/object/)
  })
})
