import { describe, expect, it } from 'vitest'
import { ManualDialUnavailableError } from '../../application/manual-call'
import {
  MANUAL_CALL_ORIGINATE_TIMEOUT_SECONDS,
  buildManualCancelCommandV1,
  buildManualOriginateCommandV1,
  manualCallEslConnectionV1,
} from './freeswitch-manual-call-adapter'

const FS_UUID = '5f0c1d2e-3a4b-5c6d-8e7f-001122334455'
const valid = { fsUuid: FS_UUID, e164: '+79161110001', extension: '101', staffUserId: 'u1' }

describe('manual originate command', () => {
  it('dials the trunk leg first and bridges the employee’s own extension in, with a FreeSWITCH-side timeout', () => {
    expect(buildManualOriginateCommandV1(valid)).toBe(
      'bgapi originate {'
      + `origination_uuid=${FS_UUID},origination_caller_id_number=79161110001,origination_caller_id_name='79161110001',`
      + `crm_user_id=u1,originate_timeout=${MANUAL_CALL_ORIGINATE_TIMEOUT_SECONDS},ignore_early_media=true,rtp_secure_media=false,`
      + 'RECORD_STEREO=true,recording_follow_transfer=true,'
      + `recording_file=/var/lib/freeswitch/recordings/${FS_UUID}.wav,`
      + `execute_on_answer='record_session /var/lib/freeswitch/recordings/${FS_UUID}.wav'}`
      + 'sofia/gateway/megafon/79161110001 &bridge([sip_h_P-CRM-Outbound-Bridge=true]user/101)',
    )
  })

  // L1: the number is checked again right where the command is assembled, so no channel variable,
  // second dial string or application can ride in through it.
  it.each([
    '+7 916 111 00 01', '+79161110001;', '+79161110001&bridge(user/102)', '+7916{x=1}1110001', '+79161110001\napi',
    '+7', '+', '79161110001', '+0123456789', '+791611100011234567', '', '+79161110001,crm_user_id=u9', '+7916111000^1',
  ])('refuses the hostile destination %j', e164 => {
    expect(() => buildManualOriginateCommandV1({ ...valid, e164 })).toThrow(ManualDialUnavailableError)
  })

  it.each(['101,crm_user_id=u9', '10a', '', '1', '1234567', '101}', '101 ', '^101'])('refuses the hostile extension %j', extension => {
    expect(() => buildManualOriginateCommandV1({ ...valid, extension })).toThrow(ManualDialUnavailableError)
  })

  it.each(['u1,x=y', 'u1}', 'u 1', '', 'u1^'])('refuses the hostile staff id %j', staffUserId => {
    expect(() => buildManualOriginateCommandV1({ ...valid, staffUserId })).toThrow(ManualDialUnavailableError)
  })

  it.each(['not-a-uuid', `${FS_UUID},x=y`, FS_UUID.toUpperCase()])('refuses the channel uuid %j', fsUuid => {
    expect(() => buildManualOriginateCommandV1({ ...valid, fsUuid })).toThrow(ManualDialUnavailableError)
    expect(() => buildManualCancelCommandV1(fsUuid)).toThrow(ManualDialUnavailableError)
  })

  it('cancels exactly one channel', () => {
    expect(buildManualCancelCommandV1(FS_UUID)).toBe(`api uuid_kill ${FS_UUID} ORIGINATOR_CANCEL`)
  })
})

describe('ESL connection for a manual call', () => {
  const strong = 'a'.repeat(24)

  it('takes explicit settings only', () => {
    expect(manualCallEslConnectionV1({ FS_ESL_HOST: '127.0.0.1', FS_ESL_PORT: '8021', ESL_PASSWORD: strong })).toEqual({ host: '127.0.0.1', port: 8021, password: strong })
  })

  it.each([
    ['no host', { FS_ESL_PORT: '8021', ESL_PASSWORD: strong }],
    ['no port', { FS_ESL_HOST: '127.0.0.1', ESL_PASSWORD: strong }],
    ['a bad port', { FS_ESL_HOST: '127.0.0.1', FS_ESL_PORT: '99999', ESL_PASSWORD: strong }],
    ['no password', { FS_ESL_HOST: '127.0.0.1', FS_ESL_PORT: '8021' }],
    ['the FreeSWITCH default password', { FS_ESL_HOST: '127.0.0.1', FS_ESL_PORT: '8021', ESL_PASSWORD: 'ClueCon' }],
    ['a short password', { FS_ESL_HOST: '127.0.0.1', FS_ESL_PORT: '8021', ESL_PASSWORD: 'short' }],
  ])('refuses %s', (_name, env) => {
    expect(() => manualCallEslConnectionV1(env)).toThrow(ManualDialUnavailableError)
  })
})
