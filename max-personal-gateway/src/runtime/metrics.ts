export type LatencyMetric =
  | 'captureHookMs'
  | 'spoolAppendMs'
  | 'ingressAckMs'
  | 'journalMs'
  | 'normalizationLagMs'
  | 'confirmationLagMs'
  | 'comparisonLagMs'

const COUNTERS = [
  'captureAccepted', 'captureRejected', 'ingressAuthFailures', 'journalAckCount',
  'idempotentRetryCount', 'drainFailures', 'lostBeforeSpool', 'matched',
  'expectedDifferences', 'regressions', 'criticalRegressions', 'wrongAccountDifferences',
  'normalizerQuarantined', 'providerConfirmationsMatched', 'providerConfirmationsUnmatched',
  'providerConfirmationsDeferred', 'providerConfirmationsAmbiguous',
] as const

export type CounterName = typeof COUNTERS[number]

export interface Percentiles {
  readonly p50: number
  readonly p95: number
  readonly p99: number
}

function percentile(values: readonly number[], quantile: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1))]
}

export class OperationalMetrics {
  readonly #counters = new Map<CounterName, number>(COUNTERS.map(name => [name, 0]))
  readonly #latencies = new Map<LatencyMetric, number[]>()
  spoolPending = 0
  spoolBytes = 0
  oldestPendingAgeMs: number | null = null

  increment(name: CounterName, by = 1): void {
    this.#counters.set(name, (this.#counters.get(name) ?? 0) + by)
  }

  set(name: CounterName, value: number): void {
    this.#counters.set(name, Math.max(0, Math.trunc(value)))
  }

  counter(name: CounterName): number { return this.#counters.get(name) ?? 0 }

  observe(name: LatencyMetric, milliseconds: number): void {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) return
    const values = this.#latencies.get(name) ?? []
    values.push(milliseconds)
    if (values.length > 4096) values.splice(0, values.length - 4096)
    this.#latencies.set(name, values)
  }

  percentiles(name: LatencyMetric): Percentiles {
    const values = this.#latencies.get(name) ?? []
    return { p50: percentile(values, 0.5), p95: percentile(values, 0.95), p99: percentile(values, 0.99) }
  }

  snapshot(): Record<string, unknown> {
    return {
      ...Object.fromEntries(this.#counters),
      spoolPending: this.spoolPending,
      spoolBytes: this.spoolBytes,
      oldestPendingAgeMs: this.oldestPendingAgeMs,
      latencies: Object.fromEntries(
        [...this.#latencies.keys()].map(name => [name, this.percentiles(name)]),
      ),
    }
  }

  prometheus(): string {
    const lines: string[] = []
    for (const name of COUNTERS) lines.push(`max_personal_${name.replace(/[A-Z]/g, value => `_${value.toLowerCase()}`)} ${this.counter(name)}`)
    lines.push(`max_personal_spool_pending ${this.spoolPending}`)
    lines.push(`max_personal_spool_bytes ${this.spoolBytes}`)
    lines.push(`max_personal_oldest_pending_age_ms ${this.oldestPendingAgeMs ?? 0}`)
    for (const [name] of this.#latencies) {
      const values = this.percentiles(name)
      for (const key of ['p50', 'p95', 'p99'] as const) {
        lines.push(`max_personal_${name.replace(/[A-Z]/g, value => `_${value.toLowerCase()}`)}{quantile="${key.slice(1)}"} ${values[key]}`)
      }
    }
    return `${lines.join('\n')}\n`
  }
}
