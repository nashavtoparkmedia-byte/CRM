// The Fleet Operations handler behind the Отток business trigger
// fleet.churn.no_orders_days (version 1): "the driver has not completed an order
// for at least N days".
//
// Fleet owns the business data (Driver.lastOrderAt, Driver.dismissedAt) and the
// rule; Communication Workspace never recomputes it. The handler reads persisted
// Driver rows through an injected port, never calls a park, never writes, and
// reports every evaluated driver it could not hand over (no canonical Contact)
// instead of hiding it. A driver who never completed an order is not churn.

export const CHURN_INACTIVITY_TRIGGER_KEY_V1 = 'fleet.churn.no_orders_days' as const
export const CHURN_INACTIVITY_TRIGGER_VERSION_V1 = 1
export const CHURN_INACTIVITY_MAX_MATCHES_V1 = 5000
const DAY_MS = 86_400_000

export interface ChurnInactivityDriverRowV1 {
  id: string
  contactId: string | null
  fullName: string
  lastOrderAt: Date
}

export interface ChurnInactivityPersistencePortV1 {
  /** Non-dismissed drivers whose last completed order is at or before `threshold`, oldest first, at most `limit`. */
  findInactiveDrivers(input: { threshold: Date; limit: number }): Promise<ChurnInactivityDriverRowV1[]>
}

export interface ChurnInactivityMatchV1 {
  driverId: string
  contactId: string
  fullName: string
  lastOrderAt: string
  inactiveDays: number
}

export interface ChurnInactivityEvaluationV1 {
  triggerKey: typeof CHURN_INACTIVITY_TRIGGER_KEY_V1
  triggerVersion: typeof CHURN_INACTIVITY_TRIGGER_VERSION_V1
  minInactiveDays: number
  asOf: string
  threshold: string
  matched: ChurnInactivityMatchV1[]
  /** Drivers that met the rule but have no canonical Contact, so nobody can be addressed. */
  withoutContact: Array<{ driverId: string; fullName: string; inactiveDays: number }>
  truncated: boolean
}

export class ChurnInactivityQueryErrorV1 extends Error {
  constructor(message: string) {
    super(`FLEET_CHURN_TRIGGER_INVALID: ${message}`)
    this.name = 'ChurnInactivityQueryErrorV1'
  }
}

export function parseChurnInactivityQueryV1(input: unknown): { minInactiveDays: number; asOf: Date; limit: number } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ChurnInactivityQueryErrorV1('query must be an object')
  const value = input as Record<string, unknown>
  for (const key of Object.keys(value)) {
    if (!['minInactiveDays', 'asOf', 'limit'].includes(key)) throw new ChurnInactivityQueryErrorV1(`${key} is not part of the query`)
  }
  const days = value.minInactiveDays
  if (typeof days !== 'number' || !Number.isSafeInteger(days) || days < 1 || days > 365) throw new ChurnInactivityQueryErrorV1('minInactiveDays must be a whole number of days from 1 to 365')
  const asOf = value.asOf === undefined ? new Date() : new Date(String(value.asOf))
  if (Number.isNaN(asOf.getTime())) throw new ChurnInactivityQueryErrorV1('asOf must be a time')
  const limit = value.limit === undefined ? CHURN_INACTIVITY_MAX_MATCHES_V1 : value.limit
  if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > CHURN_INACTIVITY_MAX_MATCHES_V1) throw new ChurnInactivityQueryErrorV1('limit is out of range')
  return { minInactiveDays: days, asOf, limit }
}

/** Whole days without an order, counted from the last completed order. */
export function inactiveDaysV1(lastOrderAt: Date, asOf: Date): number {
  return Math.floor((asOf.getTime() - lastOrderAt.getTime()) / DAY_MS)
}

export function createChurnInactivityTriggerHandlerV1(port: ChurnInactivityPersistencePortV1) {
  return async function evaluateChurnInactivityTriggerV1(input: unknown): Promise<ChurnInactivityEvaluationV1> {
    const query = parseChurnInactivityQueryV1(input)
    const threshold = new Date(query.asOf.getTime() - query.minInactiveDays * DAY_MS)
    const rows = await port.findInactiveDrivers({ threshold, limit: query.limit + 1 })
    const truncated = rows.length > query.limit
    const matched: ChurnInactivityMatchV1[] = []
    const withoutContact: ChurnInactivityEvaluationV1['withoutContact'] = []
    for (const row of rows.slice(0, query.limit)) {
      // The rule is re-checked here: a port that returns too much never widens the trigger.
      if (row.lastOrderAt.getTime() > threshold.getTime()) continue
      const inactiveDays = inactiveDaysV1(row.lastOrderAt, query.asOf)
      if (!row.contactId) {
        withoutContact.push({ driverId: row.id, fullName: row.fullName, inactiveDays })
        continue
      }
      matched.push({ driverId: row.id, contactId: row.contactId, fullName: row.fullName, lastOrderAt: row.lastOrderAt.toISOString(), inactiveDays })
    }
    return {
      triggerKey: CHURN_INACTIVITY_TRIGGER_KEY_V1,
      triggerVersion: CHURN_INACTIVITY_TRIGGER_VERSION_V1,
      minInactiveDays: query.minInactiveDays,
      asOf: query.asOf.toISOString(),
      threshold: threshold.toISOString(),
      matched,
      withoutContact,
      truncated,
    }
  }
}
