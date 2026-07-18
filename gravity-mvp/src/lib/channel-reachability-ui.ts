export type PersistedReachabilityStatus = 'confirmed' | 'unreachable' | 'unknown'
export type LiveReachabilityStatus = 'confirmed' | 'unreachable' | 'checking'
export type ConnectionHealth = 'connected' | 'disconnected' | 'unknown' | 'unavailable'

export interface LiveReachabilityDecision {
  status: LiveReachabilityStatus
  retryable?: boolean
  error?: string
  connectionHealth?: ConnectionHealth
  cached?: boolean
  checkedAt?: string
}

export interface ChannelReachabilityPresentation {
  accountState: 'confirmed' | 'unreachable' | 'unknown'
  accountBadge: {
    label: 'есть' | 'нет' | 'проверяем' | 'нет связи'
    className: string
    title: string
  }
  connectionBadge: {
    label: 'нет связи'
    className: string
    title: string
  } | null
  routeBadge: {
    label: 'маршрут'
    className: string
    title: string
  } | null
  dotClassName: string
  dotTitle: string
  canWrite: boolean
  writeDisabledReason: string
}

export function deriveChannelReachabilityPresentation(input: {
  persistedStatus?: PersistedReachabilityStatus | string | null
  live?: LiveReachabilityDecision
  routeKnown: boolean
  deliveryFailed?: boolean
  deliveryError?: string | null
}): ChannelReachabilityPresentation {
  const live = input.live
  const accountState = live?.status === 'confirmed'
    ? 'confirmed'
    : live?.status === 'unreachable'
      ? 'unreachable'
      : input.persistedStatus === 'confirmed' || input.persistedStatus === 'unreachable'
        ? input.persistedStatus
        : 'unknown'
  const connectionHealth = live?.connectionHealth || 'unknown'
  const connectionBlocked = connectionHealth === 'disconnected' || connectionHealth === 'unavailable'

  const accountBadge = accountState === 'confirmed'
    ? {
        label: 'есть' as const,
        className: 'text-emerald-700 bg-emerald-50',
        title: live?.cached
          ? 'Аккаунт найден у провайдера. Показан свежий сохранённый результат'
          : 'Аккаунт найден у провайдера',
      }
    : accountState === 'unreachable'
      ? {
          label: 'нет' as const,
          className: 'text-gray-600 bg-gray-100',
          title: 'Канал проверен: аккаунт у провайдера не найден',
        }
      : connectionBlocked
        ? {
            label: 'нет связи' as const,
            className: 'text-amber-700 bg-amber-50',
            title: live?.error || 'CRM сейчас не может проверить канал. Это не ответ провайдера',
          }
        : {
            label: 'проверяем' as const,
            className: 'text-blue-700 bg-blue-50',
            title: 'Проверка аккаунта ещё идёт или свежего результата пока нет',
          }

  const connectionBadge = accountState !== 'unknown' && connectionBlocked
    ? {
        label: 'нет связи' as const,
        className: 'text-amber-700 bg-amber-50',
        title: live?.error || 'Аккаунт известен, но CRM сейчас не подключена к каналу',
      }
    : null
  const routeBadge = input.routeKnown
    ? {
        label: 'маршрут' as const,
        className: 'text-gray-500 bg-gray-50',
        title: 'CRM знает identity/чат для отправки. Это не проверка аккаунта у провайдера',
      }
    : null

  const canWrite = !input.deliveryFailed
    && !connectionBlocked
    && accountState !== 'unreachable'
    && (input.routeKnown || accountState === 'confirmed')

  let writeDisabledReason = 'Дождитесь завершения проверки аккаунта'
  if (input.deliveryFailed) {
    writeDisabledReason = input.deliveryError || 'Последняя отправка завершилась ошибкой'
  } else if (connectionBlocked) {
    writeDisabledReason = 'CRM сейчас не подключена к каналу'
  } else if (accountState === 'unreachable') {
    writeDisabledReason = 'Аккаунт у провайдера не найден'
  } else if (!input.routeKnown && accountState !== 'confirmed') {
    writeDisabledReason = 'Маршрут отправки ещё не определён'
  }

  const dotClassName = accountState === 'unreachable'
    ? 'bg-red-500'
    : connectionBlocked
      ? 'bg-amber-400'
      : accountState === 'confirmed'
        ? 'bg-emerald-500'
        : 'bg-gray-300'
  const dotTitle = accountState === 'confirmed' && connectionBlocked
    ? 'Аккаунт найден, но CRM сейчас не подключена к каналу'
    : accountBadge.title

  return {
    accountState,
    accountBadge,
    connectionBadge,
    routeBadge,
    dotClassName,
    dotTitle,
    canWrite,
    writeDisabledReason,
  }
}
