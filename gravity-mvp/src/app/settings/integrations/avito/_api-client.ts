/**
 * api() — fetch helper для Avito-страниц внутри CRM.
 *
 * Все Avito-endpoints живут под /api/avito/* — туда пишет Server route,
 * который читает/пишет CRM Postgres через Prisma. Никакого внешнего API
 * (как было в Box 1 — REST к standalone сервису) больше нет.
 */

const API_BASE = '/api/avito'

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  // path передаётся как в Box 1: '/accounts', '/responses/123/mark-processed'.
  // Префикс /api/avito добавляется здесь.
  const res = await fetch(`${API_BASE}${path}`, {
    cache: 'no-store',
    credentials: 'include',
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })
  const text = await res.text()
  if (!res.ok) {
    throw new Error(`API ${res.status}: ${text}`)
  }
  return text ? (JSON.parse(text) as T) : (undefined as T)
}

export const apiBase = API_BASE
