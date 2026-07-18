import { describe, expect, test } from 'vitest'

import { deriveChannelReachabilityPresentation } from '@/lib/channel-reachability-ui'

describe('canonical channel reachability presentation', () => {
  test('an existing Chat never overrides a provider-level unreachable answer', () => {
    const presentation = deriveChannelReachabilityPresentation({
      persistedStatus: 'unreachable',
      routeKnown: true,
      live: { status: 'unreachable', connectionHealth: 'connected' },
    })
    expect(presentation.accountBadge.label).toBe('нет')
    expect(presentation.routeBadge?.label).toBe('маршрут')
    expect(presentation.canWrite).toBe(false)
  })

  test('keeps cached account evidence while showing a disconnected CRM session separately', () => {
    const presentation = deriveChannelReachabilityPresentation({
      persistedStatus: 'confirmed',
      routeKnown: true,
      live: {
        status: 'checking',
        connectionHealth: 'disconnected',
        cached: true,
        error: 'WhatsApp подключение восстанавливается',
      },
    })
    expect(presentation.accountBadge.label).toBe('есть')
    expect(presentation.connectionBadge?.label).toBe('нет связи')
    expect(presentation.canWrite).toBe(false)
    expect(presentation.dotClassName).toBe('bg-amber-400')
  })

  test('shows an operational failure as no connection, never as account absent', () => {
    const presentation = deriveChannelReachabilityPresentation({
      persistedStatus: 'unknown',
      routeKnown: false,
      live: {
        status: 'checking',
        connectionHealth: 'unavailable',
        error: 'CRM сейчас не может проверить MAX',
      },
    })
    expect(presentation.accountBadge.label).toBe('нет связи')
    expect(presentation.accountState).toBe('unknown')
    expect(presentation.accountBadge.label).not.toBe('нет')
  })

  test('allows a known route while account refresh is pending only when connection is not blocked', () => {
    expect(deriveChannelReachabilityPresentation({
      persistedStatus: 'unknown',
      routeKnown: true,
      live: { status: 'checking', connectionHealth: 'connected' },
    }).canWrite).toBe(true)
    expect(deriveChannelReachabilityPresentation({
      persistedStatus: 'unknown',
      routeKnown: true,
      live: { status: 'checking', connectionHealth: 'disconnected' },
    }).canWrite).toBe(false)
  })

  test('a confirmed phone check can enable a new route without pretending CRM already has a Chat', () => {
    const presentation = deriveChannelReachabilityPresentation({
      persistedStatus: 'unknown',
      routeKnown: false,
      live: { status: 'confirmed', connectionHealth: 'connected' },
    })
    expect(presentation.accountBadge.label).toBe('есть')
    expect(presentation.routeBadge).toBeNull()
    expect(presentation.canWrite).toBe(true)
  })

  test('a delivery failure stays separate from the provider account answer', () => {
    const presentation = deriveChannelReachabilityPresentation({
      persistedStatus: 'confirmed',
      routeKnown: true,
      live: { status: 'confirmed', connectionHealth: 'connected' },
      deliveryFailed: true,
      deliveryError: 'Последняя отправка не доставлена',
    })
    expect(presentation.accountBadge.label).toBe('есть')
    expect(presentation.canWrite).toBe(false)
    expect(presentation.writeDisabledReason).toBe('Последняя отправка не доставлена')
  })
})
