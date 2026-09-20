'use client'

import { useRouter } from 'next/navigation'

import { MANAGER_STATE_LABELS } from './money'

/**
 * Month, status and park, as plain form controls.
 *
 * Each change navigates with the filter in the URL, so the server renders the
 * list and the page can be shared or reloaded without losing what was chosen.
 * Paging starts over on every change, because a cursor belongs to one filter.
 */
export default function CompensationFilters({
    periodKey,
    state,
    externalParkId,
    parks,
}: {
    periodKey: string
    state: string | null
    externalParkId: string | null
    parks: Array<{ externalParkId: string; name: string }>
}) {
    const router = useRouter()

    function apply(next: { month?: string; status?: string | null; park?: string | null }) {
        const query = new URLSearchParams()
        query.set('month', next.month ?? periodKey)
        const nextStatus = next.status === undefined ? state : next.status
        const nextPark = next.park === undefined ? externalParkId : next.park
        if (nextStatus) query.set('status', nextStatus)
        if (nextPark) query.set('park', nextPark)
        router.push(`/compensation?${query.toString()}`)
    }

    return (
        <div className="mb-4 flex flex-wrap gap-3" data-testid="compensation-filters">
            <label className="flex flex-col gap-1">
                <span className="text-[13px] font-medium text-muted">Месяц</span>
                <input
                    type="month"
                    value={periodKey}
                    aria-label="Месяц"
                    onChange={(event) => apply({ month: event.target.value || periodKey })}
                    className="h-11 rounded-lg border border-border px-3 text-[15px]"
                />
            </label>
            <label className="flex flex-col gap-1">
                <span className="text-[13px] font-medium text-muted">Статус</span>
                <select
                    value={state ?? ''}
                    aria-label="Статус"
                    onChange={(event) => apply({ status: event.target.value || null })}
                    className="h-11 rounded-lg border border-border px-3 text-[15px]"
                >
                    <option value="">Все</option>
                    {Object.entries(MANAGER_STATE_LABELS).map(([value, label]) => (
                        <option key={value} value={value}>{label}</option>
                    ))}
                </select>
            </label>
            <label className="flex flex-col gap-1">
                <span className="text-[13px] font-medium text-muted">Парк</span>
                <select
                    value={externalParkId ?? ''}
                    aria-label="Парк"
                    onChange={(event) => apply({ park: event.target.value || null })}
                    className="h-11 rounded-lg border border-border px-3 text-[15px]"
                >
                    <option value="">Все парки</option>
                    {parks.map((park) => (
                        <option key={park.externalParkId} value={park.externalParkId}>{park.name}</option>
                    ))}
                </select>
            </label>
        </div>
    )
}
