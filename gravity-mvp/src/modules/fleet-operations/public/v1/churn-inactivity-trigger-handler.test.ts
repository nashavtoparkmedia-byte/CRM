import { describe, expect, it } from 'vitest'
import { createChurnInactivityTriggerHandlerV1, inactiveDaysV1, type ChurnInactivityDriverRowV1 } from './churn-inactivity-trigger-handler'

const asOf = new Date('2026-11-08T12:00:00.000Z')
const daysAgo = (days: number) => new Date(asOf.getTime() - days * 86_400_000)

function handler(rows: ChurnInactivityDriverRowV1[]) {
  const calls: Array<{ threshold: Date; limit: number }> = []
  const evaluate = createChurnInactivityTriggerHandlerV1({
    async findInactiveDrivers(input) {
      calls.push(input)
      return rows
    },
  })
  return { evaluate, calls }
}

describe('Отток trigger fleet.churn.no_orders_days v1', () => {
  it('selects drivers with no completed order for at least N days and says why', async () => {
    const { evaluate, calls } = handler([
      { id: 'd10', contactId: 'c10', fullName: 'Десять', lastOrderAt: daysAgo(10) },
      { id: 'd5', contactId: 'c5', fullName: 'Пять', lastOrderAt: daysAgo(5) },
    ])
    const result = await evaluate({ minInactiveDays: 5, asOf: asOf.toISOString() })
    expect(calls[0].threshold.toISOString()).toBe(daysAgo(5).toISOString())
    expect(result).toMatchObject({ triggerKey: 'fleet.churn.no_orders_days', triggerVersion: 1, minInactiveDays: 5, truncated: false })
    expect(result.matched.map((match) => [match.driverId, match.inactiveDays])).toEqual([['d10', 10], ['d5', 5]])
  })

  it('never widens the rule, even when the store returns too much', async () => {
    const { evaluate } = handler([{ id: 'd4', contactId: 'c4', fullName: 'Четыре', lastOrderAt: daysAgo(4) }])
    const result = await evaluate({ minInactiveDays: 5, asOf: asOf.toISOString() })
    expect(result.matched).toEqual([])
  })

  it('reports drivers without a canonical Contact instead of hiding them', async () => {
    const { evaluate } = handler([{ id: 'd9', contactId: null, fullName: 'Без контакта', lastOrderAt: daysAgo(9) }])
    const result = await evaluate({ minInactiveDays: 5, asOf: asOf.toISOString() })
    expect(result.matched).toEqual([])
    expect(result.withoutContact).toEqual([{ driverId: 'd9', fullName: 'Без контакта', inactiveDays: 9 }])
  })

  it('marks a truncated evaluation and refuses malformed queries', async () => {
    const rows = [1, 2, 3].map((index) => ({ id: `d${index}`, contactId: `c${index}`, fullName: `${index}`, lastOrderAt: daysAgo(20) }))
    const { evaluate } = handler(rows)
    expect((await evaluate({ minInactiveDays: 5, asOf: asOf.toISOString(), limit: 2 })).truncated).toBe(true)
    await expect(evaluate({ minInactiveDays: 0 })).rejects.toThrow('FLEET_CHURN_TRIGGER_INVALID')
    await expect(evaluate({ minInactiveDays: 5, contactIds: ['x'] })).rejects.toThrow('FLEET_CHURN_TRIGGER_INVALID')
    expect(inactiveDaysV1(daysAgo(5.9), asOf)).toBe(5)
  })
})
