import { describe, expect, it } from 'vitest'

import {
  DRIVERS_PAGE_LIMIT_DEFAULT,
  DRIVERS_PAGE_LIMIT_MAX,
  EVENTS_LIMIT_DEFAULT,
  EVENT_TYPE_WHITELIST,
  FLEET_STATUS_LABELS,
  RECENT_EVENTS_DAYS,
  RECENT_EVENTS_MAX,
  SCRAPER_STATS_CACHE_TTL_MS,
} from './monitoring-policy'

describe('Fleet monitoring policy', () => {
  it('preserves the bounded event vocabulary and pagination limits', () => {
    expect(EVENT_TYPE_WHITELIST).toEqual([
      'call_attempt',
      'call_connected',
      'call_no_answer',
      'message_sent',
      'fleet_check_requested',
      'fleet_check_completed',
      'external_park_detected',
      'attention_marked',
    ])
    expect({ DRIVERS_PAGE_LIMIT_DEFAULT, DRIVERS_PAGE_LIMIT_MAX, EVENTS_LIMIT_DEFAULT }).toEqual({
      DRIVERS_PAGE_LIMIT_DEFAULT: 20,
      DRIVERS_PAGE_LIMIT_MAX: 100,
      EVENTS_LIMIT_DEFAULT: 5,
    })
  })

  it('preserves status labels, cache lifetime and recent-event window', () => {
    expect(FLEET_STATUS_LABELS).toEqual({ queued: 'в очереди', completed: 'завершена', failed: 'ошибка' })
    expect(SCRAPER_STATS_CACHE_TTL_MS).toBe(30_000)
    expect({ RECENT_EVENTS_MAX, RECENT_EVENTS_DAYS }).toEqual({ RECENT_EVENTS_MAX: 3, RECENT_EVENTS_DAYS: 7 })
  })
})
