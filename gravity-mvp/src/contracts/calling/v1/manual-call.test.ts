import { describe, expect, it } from 'vitest'
import {
  CANCEL_MANUAL_CALL_COMMAND_V1,
  MANUAL_CALL_AVAILABILITY_QUERY_V1,
  ManualCallContractError,
  START_MANUAL_CALL_COMMAND_V1,
  parseCancelManualCallCommandV1,
  parseManualCallAvailabilityQueryV1,
  parseStartManualCallCommandV1,
} from './manual-call'

const command = { contract: START_MANUAL_CALL_COMMAND_V1, requestId: '6f1c2b0a-9d1e-4a55-b1a2-0c3d4e5f6a7b', contactId: 'contact-1', phoneId: 'phone-1' }

const code = (fn: () => unknown) => {
  try { fn() } catch (error) { return error instanceof ManualCallContractError ? error.code : 'other' }
  return 'none'
}

describe('calling.StartManualCallCommand.v1', () => {
  it('accepts exactly a requestId, a Contact id and a Contacts phone id', () => {
    expect(parseStartManualCallCommandV1(command)).toEqual(command)
  })

  it.each(['phoneNumber', 'phone', 'e164', 'extension', 'userId', 'role'])('never takes %s', field => {
    expect(code(() => parseStartManualCallCommandV1({ ...command, [field]: '+79990000000' }))).toBe('INVALID_CONTRACT')
  })

  it.each([
    ['requestId', 'short'], ['requestId', 'has space in it'], ['requestId', 'a'.repeat(129)],
    ['contactId', ''], ['contactId', 'id with space'], ['contactId', 'id,x=y'], ['phoneId', '{x}'], ['phoneId', 7],
  ])('rejects %s = %j', (field, value) => {
    expect(code(() => parseStartManualCallCommandV1({ ...command, [field]: value }))).toBe('INVALID_CONTRACT')
  })

  it('names an unsupported version', () => {
    expect(code(() => parseStartManualCallCommandV1({ ...command, contract: 'calling.StartManualCallCommand.v2' }))).toBe('UNSUPPORTED_CONTRACT_VERSION')
    expect(code(() => parseStartManualCallCommandV1({ ...command, contract: 'other' }))).toBe('INVALID_CONTRACT')
    expect(code(() => parseStartManualCallCommandV1(null))).toBe('INVALID_CONTRACT')
  })
})

describe('calling.ManualCallAvailabilityQuery.v1 and calling.CancelManualCallCommand.v1', () => {
  it('availability takes only a Contact id', () => {
    expect(parseManualCallAvailabilityQueryV1({ contract: MANUAL_CALL_AVAILABILITY_QUERY_V1, contactId: 'c1' })).toEqual({ contract: MANUAL_CALL_AVAILABILITY_QUERY_V1, contactId: 'c1' })
    expect(code(() => parseManualCallAvailabilityQueryV1({ contract: MANUAL_CALL_AVAILABILITY_QUERY_V1, contactId: 'c1', phoneNumber: '+7' }))).toBe('INVALID_CONTRACT')
  })

  it('cancel takes one lowercase channel uuid', () => {
    const fsUuid = '5f0c1d2e-3a4b-5c6d-8e7f-001122334455'
    expect(parseCancelManualCallCommandV1({ contract: CANCEL_MANUAL_CALL_COMMAND_V1, fsUuid })).toEqual({ contract: CANCEL_MANUAL_CALL_COMMAND_V1, fsUuid })
    for (const bad of [`${fsUuid} ORIGINATOR_CANCEL`, fsUuid.toUpperCase(), 'x', '']) {
      expect(code(() => parseCancelManualCallCommandV1({ contract: CANCEL_MANUAL_CALL_COMMAND_V1, fsUuid: bad }))).toBe('INVALID_CONTRACT')
    }
  })
})
