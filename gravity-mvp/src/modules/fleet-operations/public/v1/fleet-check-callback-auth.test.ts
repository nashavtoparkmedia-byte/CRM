import { describe, expect, it } from 'vitest'

import {
  FLEET_CHECK_CALLBACK_SECRET_HEADER_V1,
  fleetCheckCallbackGateV1,
  isUsableFleetCheckCallbackSecretV1,
} from './fleet-check-callback-auth'

const SECRET = 'q7Rk2Zp9Lm4Xv8Tn3Wb6Yc1Hd5Fg0Js2Ue7Ia9Ko3'
const headers = (value?: string) => new Headers(value === undefined ? {} : { [FLEET_CHECK_CALLBACK_SECRET_HEADER_V1]: value })

describe('fleetCheckCallbackGateV1', () => {
  it('admits exactly the configured secret', () => {
    expect(fleetCheckCallbackGateV1(headers(SECRET), SECRET)).toEqual({ ok: true })
    expect(fleetCheckCallbackGateV1(new Headers({ 'X-Fleet-Check-Secret': SECRET }), SECRET)).toEqual({ ok: true })
  })

  it('answers 401 for a missing, empty, wrong, or suffixed secret (HTTP header values arrive trimmed)', () => {
    for (const value of [undefined, '', SECRET.slice(0, -1), `${SECRET}x`, SECRET.toLowerCase(), 'x'.repeat(513)]) {
      expect(fleetCheckCallbackGateV1(headers(value), SECRET)).toEqual({ ok: false, status: 401 })
    }
  })

  it('answers 503 when the CRM has no usable secret, whatever the request sent', () => {
    for (const configured of [undefined, null, '', ' ', 'short-secret', 'a'.repeat(40), 'replace-me-with-a-long-random-value-0123456789', `${SECRET} `, 42]) {
      expect(fleetCheckCallbackGateV1(headers(typeof configured === 'string' ? configured : SECRET), configured)).toEqual({ ok: false, status: 503 })
    }
  })

  it('reads FLEET_CHECK_CALLBACK_SECRET from the environment by default', () => {
    const before = process.env.FLEET_CHECK_CALLBACK_SECRET
    try {
      delete process.env.FLEET_CHECK_CALLBACK_SECRET
      expect(fleetCheckCallbackGateV1(headers(SECRET))).toEqual({ ok: false, status: 503 })
      process.env.FLEET_CHECK_CALLBACK_SECRET = SECRET
      expect(fleetCheckCallbackGateV1(headers(SECRET))).toEqual({ ok: true })
    } finally {
      if (before === undefined) delete process.env.FLEET_CHECK_CALLBACK_SECRET
      else process.env.FLEET_CHECK_CALLBACK_SECRET = before
    }
  })
})

describe('isUsableFleetCheckCallbackSecretV1', () => {
  it('needs 32+ plain characters, at least 8 distinct, and no placeholder word', () => {
    expect(isUsableFleetCheckCallbackSecretV1(SECRET)).toBe(true)
    expect(isUsableFleetCheckCallbackSecretV1(SECRET.slice(0, 31))).toBe(false)
    expect(isUsableFleetCheckCallbackSecretV1('ab'.repeat(20))).toBe(false)
    expect(isUsableFleetCheckCallbackSecretV1(`${SECRET.slice(0, 30)}__x`)).toBe(false)
    expect(isUsableFleetCheckCallbackSecretV1(`${SECRET}\n`)).toBe(false)
    expect(isUsableFleetCheckCallbackSecretV1(`changeme${SECRET}`)).toBe(false)
  })
})
