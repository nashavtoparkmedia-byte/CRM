export const REACHABILITY_DEFINITIVE_TTL_MS = 15 * 60 * 1000
export const REACHABILITY_OPERATIONAL_TTL_MS = 30 * 1000

type LoaderResult<T> = {
  value: T
  ttlMs: number
}

type CacheEntry<T> = {
  value: T
  checkedAtMs: number
  expiresAtMs: number
}

export type ReachabilityDecision<T> = CacheEntry<T> & {
  source: 'live' | 'cache' | 'coalesced'
}

const decisionCache = new Map<string, CacheEntry<unknown>>()
const inFlight = new Map<string, Promise<CacheEntry<unknown>>>()
const MAX_CACHE_ENTRIES = 500

function pruneExpired(nowMs: number) {
  for (const [key, entry] of decisionCache.entries()) {
    if (entry.expiresAtMs <= nowMs) decisionCache.delete(key)
  }
  while (decisionCache.size >= MAX_CACHE_ENTRIES) {
    const oldestKey = decisionCache.keys().next().value
    if (!oldestKey) break
    decisionCache.delete(oldestKey)
  }
}

export async function getOrCreateReachabilityDecision<T>(input: {
  key: string
  force?: boolean
  now?: () => number
  load: () => Promise<LoaderResult<T>>
}): Promise<ReachabilityDecision<T>> {
  const now = input.now || Date.now
  const nowMs = now()
  pruneExpired(nowMs)

  if (!input.force) {
    const cached = decisionCache.get(input.key) as CacheEntry<T> | undefined
    if (cached && cached.expiresAtMs > nowMs) {
      return { ...cached, source: 'cache' }
    }
  }

  const existing = inFlight.get(input.key) as Promise<CacheEntry<T>> | undefined
  if (existing) {
    const entry = await existing
    return { ...entry, source: 'coalesced' }
  }

  const promise = (async (): Promise<CacheEntry<T>> => {
    const loaded = await input.load()
    const checkedAtMs = now()
    const entry = {
      value: loaded.value,
      checkedAtMs,
      expiresAtMs: checkedAtMs + Math.max(1, loaded.ttlMs),
    }
    decisionCache.set(input.key, entry)
    return entry
  })()
  inFlight.set(input.key, promise as Promise<CacheEntry<unknown>>)

  try {
    const entry = await promise
    return { ...entry, source: 'live' }
  } finally {
    inFlight.delete(input.key)
  }
}

export function resetReachabilityDecisionCacheForTests() {
  decisionCache.clear()
  inFlight.clear()
}
