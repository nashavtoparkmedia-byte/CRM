import { describe, expect, it } from 'vitest'

import {
  CONTACT_COMMUNICATION_CLASSES_V1,
  CONTACT_COMMUNICATION_PERMISSION_QUERY_V1,
  ContactCommunicationPolicyContractValidationError,
  SET_CONTACT_COMMUNICATION_POLICY_COMMAND_V1,
  isContactCommunicationClassV1,
  parseContactCommunicationPermissionQueryV1,
  parseContactCommunicationRestrictionStateV1,
  parseSetContactCommunicationPolicyCommandV1,
} from './contact-communication-policy-contracts'

const command = () => ({
  contract: SET_CONTACT_COMMUNICATION_POLICY_COMMAND_V1,
  requestId: 'req-1',
  contactId: 'contact-1',
  expectedVersion: 0,
  restriction: { denyAll: false, denyMessage: true, denyVoice: false },
  actor: 'operator-1',
  reason: 'asked not to be messaged',
})

describe('ContactCommunicationPermissionQuery.v1 contract', () => {
  it('declares exactly the two V1 effect classes', () => {
    expect([...CONTACT_COMMUNICATION_CLASSES_V1]).toEqual(['message', 'voice'])
    expect(isContactCommunicationClassV1('message')).toBe(true)
    expect(isContactCommunicationClassV1('voice')).toBe(true)
    for (const other of ['telegram', 'whatsapp', 'max', 'email', 'all', 'MESSAGE', '', 1, null]) {
      expect(isContactCommunicationClassV1(other)).toBe(false)
    }
  })

  it('parses a structurally valid query even when the class is unsupported, so the handler can deny it', () => {
    expect(parseContactCommunicationPermissionQueryV1({
      contract: CONTACT_COMMUNICATION_PERMISSION_QUERY_V1, contactId: 'c', communicationClass: 'fax',
    })).toEqual({ contract: CONTACT_COMMUNICATION_PERMISSION_QUERY_V1, contactId: 'c', communicationClass: 'fax' })
  })

  it('refuses structural garbage and unknown fields', () => {
    const base = { contract: CONTACT_COMMUNICATION_PERMISSION_QUERY_V1, contactId: 'c', communicationClass: 'message' }
    expect(() => parseContactCommunicationPermissionQueryV1(null)).toThrow(ContactCommunicationPolicyContractValidationError)
    expect(() => parseContactCommunicationPermissionQueryV1([])).toThrow(/must be an object/u)
    expect(() => parseContactCommunicationPermissionQueryV1({ ...base, contract: 'contacts.Other.v1' })).toThrow(/contract must equal/u)
    expect(() => parseContactCommunicationPermissionQueryV1({ ...base, contactId: '' })).toThrow(/contactId/u)
    expect(() => parseContactCommunicationPermissionQueryV1({ ...base, contactId: ' c ' })).toThrow(/contactId/u)
    expect(() => parseContactCommunicationPermissionQueryV1({ ...base, communicationClass: 7 })).toThrow(/communicationClass/u)
    // A channel, a provider or an override is not a query field.
    expect(() => parseContactCommunicationPermissionQueryV1({ ...base, channel: 'telegram' })).toThrow(/unsupported query field/u)
    expect(() => parseContactCommunicationPermissionQueryV1({ ...base, override: true })).toThrow(/unsupported query field/u)
  })

  it('names an unsupported major version explicitly', () => {
    let caught: unknown
    try {
      parseContactCommunicationPermissionQueryV1({
        contract: 'contacts.ContactCommunicationPermissionQuery.v2', contactId: 'c', communicationClass: 'message',
      })
    } catch (error) { caught = error }
    expect(caught).toBeInstanceOf(ContactCommunicationPolicyContractValidationError)
    expect((caught as ContactCommunicationPolicyContractValidationError).code).toBe('UNSUPPORTED_CONTRACT_VERSION')
  })
})

describe('SetContactCommunicationPolicyCommand.v1 contract', () => {
  it('parses the exact requested state with every field present', () => {
    expect(parseSetContactCommunicationPolicyCommandV1(command())).toEqual(command())
  })

  it('requires the complete restriction triple, never a patch', () => {
    expect(() => parseContactCommunicationRestrictionStateV1({ denyAll: true })).toThrow(/denyMessage must be a boolean/u)
    expect(() => parseContactCommunicationRestrictionStateV1({ denyAll: true, denyMessage: false, denyVoice: 'no' })).toThrow(/denyVoice/u)
    expect(() => parseContactCommunicationRestrictionStateV1({ denyAll: true, denyMessage: false, denyVoice: false, denyTelegram: true }))
      .toThrow(/unsupported restriction field/u)
    expect(() => parseContactCommunicationRestrictionStateV1(null)).toThrow(/must be an object/u)
  })

  it('refuses any field that could broaden or bypass the policy', () => {
    for (const extra of [{ override: true }, { force: true }, { bypassVersion: true }, { channel: 'telegram' }, { providerAccountId: 'x' }]) {
      expect(() => parseSetContactCommunicationPolicyCommandV1({ ...command(), ...extra })).toThrow(/unsupported command field/u)
    }
  })

  it('bounds and trims every identifier and text', () => {
    expect(() => parseSetContactCommunicationPolicyCommandV1({ ...command(), requestId: '' })).toThrow(/requestId/u)
    expect(() => parseSetContactCommunicationPolicyCommandV1({ ...command(), requestId: 'a'.repeat(129) })).toThrow(/at most 128/u)
    expect(() => parseSetContactCommunicationPolicyCommandV1({ ...command(), actor: ' op ' })).toThrow(/actor/u)
    expect(() => parseSetContactCommunicationPolicyCommandV1({ ...command(), actor: 'op\u0007' })).toThrow(/control characters/u)
    expect(() => parseSetContactCommunicationPolicyCommandV1({ ...command(), reason: 'r'.repeat(513) })).toThrow(/at most 512/u)
    expect(() => parseSetContactCommunicationPolicyCommandV1({ ...command(), reason: '' })).toThrow(/reason/u)
  })

  it('requires a non-negative integer expected version', () => {
    for (const bad of [-1, 1.5, '0', Number.NaN, Number.POSITIVE_INFINITY, undefined]) {
      expect(() => parseSetContactCommunicationPolicyCommandV1({ ...command(), expectedVersion: bad })).toThrow(/expectedVersion/u)
    }
    expect(parseSetContactCommunicationPolicyCommandV1({ ...command(), expectedVersion: 7 }).expectedVersion).toBe(7)
  })

  it('refuses a prototype-carrying object as a command', () => {
    class Carrier { contract = SET_CONTACT_COMMUNICATION_POLICY_COMMAND_V1 }
    expect(() => parseSetContactCommunicationPolicyCommandV1(new Carrier())).toThrow(/plain object/u)
  })
})
