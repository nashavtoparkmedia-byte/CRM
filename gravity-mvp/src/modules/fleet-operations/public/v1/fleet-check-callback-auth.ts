// The gate of the scraper's fleet-check result callback
// (POST /api/monitoring/fleet-check/callback): a machine route with no staff
// session, so it carries its own shared secret.
//
// - The worker sends FLEET_CHECK_CALLBACK_SECRET in the header below.
// - The CRM compares it with its own FLEET_CHECK_CALLBACK_SECRET in constant
//   time, over SHA-256 digests, so neither the value nor its length leaks.
// - There is no default: an unset, short or malformed configured secret answers
//   503 and nothing is read or written; a missing or wrong header answers 401.
// - Neither answer says anything about the secret or the request.
import { createHash, timingSafeEqual } from 'node:crypto'

export const FLEET_CHECK_CALLBACK_SECRET_HEADER_V1 = 'x-fleet-check-secret'
export const FLEET_CHECK_CALLBACK_SECRET_MIN_LENGTH_V1 = 32
const MAX_LENGTH = 512
const SECRET_CHARACTERS = /^[A-Za-z0-9_+/=.~-]+$/
const PLACEHOLDER = /(?:__|replace|generate|change.?me|example|placeholder|secret|password)/i

export type FleetCheckCallbackGateV1 = { ok: true } | { ok: false; status: 401 | 503 }

/** A configured secret the gate accepts: long, plain characters, not a placeholder. */
export function isUsableFleetCheckCallbackSecretV1(value: unknown): value is string {
  return typeof value === 'string'
    && value.length >= FLEET_CHECK_CALLBACK_SECRET_MIN_LENGTH_V1
    && value.length <= MAX_LENGTH
    && SECRET_CHARACTERS.test(value)
    && !PLACEHOLDER.test(value)
    && new Set(value).size >= 8
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest()
}

export function fleetCheckCallbackGateV1(
  headers: Pick<Headers, 'get'>,
  configured: unknown = process.env.FLEET_CHECK_CALLBACK_SECRET,
): FleetCheckCallbackGateV1 {
  if (!isUsableFleetCheckCallbackSecretV1(configured)) return { ok: false, status: 503 }
  const supplied = headers.get(FLEET_CHECK_CALLBACK_SECRET_HEADER_V1)
  if (typeof supplied !== 'string' || supplied.length === 0 || supplied.length > MAX_LENGTH) return { ok: false, status: 401 }
  return timingSafeEqual(digest(supplied), digest(configured)) ? { ok: true } : { ok: false, status: 401 }
}
