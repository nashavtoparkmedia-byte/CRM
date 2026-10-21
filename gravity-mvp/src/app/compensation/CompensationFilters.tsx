'use client'

import { useRouter } from 'next/navigation'

import { MANAGER_BOARD_ALL_STATES, MANAGER_STATE_LABELS } from './money'

/**
 * Month, status and park, as plain form controls.
 *
 * Each change navigates with the filter in the URL, so the server renders the
 * list and the page can be shared or reloaded without losing what was chosen.
 * Paging starts over on every change, because a cursor belongs to one filter.
 * No month means every month; no month and no status is the inbox of new
 * applications, which is where the board opens.
 */
export default function CompensationFilters({
    periodKey,
    state,
    externalParkId,
    parks,
}: {
    /** The chosen budget month, or null for every month. */
    periodKey: string | null
    state: string | null
    externalParkId: string | null
    parks: Array<{ externalParkId: string; name: string }>
}) {
    const router = useRouter()

    function apply(next: { month?: string | null; status?: string | null; park?: string | null }) {
        const query = new URLSearchParams()
        const nextMonth = next.month === undefined ? periodKey : next.month
        const nextStatus = next.status === undefined ? state : next.status
        const nextPark = next.park === undefined ? externalParkId : next.park
        if (nextMonth) query.set('month', nextMonth)
        if (nextStatus) query.set('status', nextStatus)
        if (nextPark) query.set('park', nextPark)
        const search = query.toString()
        router.push(search ? `/compensation?${search}` : '/compensation')
    }

    return (
        <div className="mb-4 flex flex-wrap gap-3" data-testid="compensation-filters">
            <label className="flex flex-col gap-1">
                <span className="text-[13px] font-medium text-muted">Месяц</span>
                <input
                    type="month"
                    value={periodKey ?? ''}
                    aria-label="Месяц"
                    onChange={(event) => apply({ month: event.target.value || null })}
                    className="h-11 rounded-lg border border-border px-3 text-[15px]"
                />
            </label>
            {periodKey !== null && (
                <button
                    type="button"
                    onClick={() => apply({ month: null })}
                    className="h-11 self-end rounded-lg border border-border px-3 text-[15px] text-foreground"
                >
                    Все месяцы
                </button>
            )}
            <label className="flex flex-col gap-1">
                <span className="text-[13px] font-medium text-muted">Статус</span>
                <select
                    value={state ?? MANAGER_BOARD_ALL_STATES}
                    aria-label="Статус"
                    onChange={(event) => apply({ status: event.target.value })}
                    className="h-11 rounded-lg border border-border px-3 text-[15px]"
                >
                    <option value={MANAGER_BOARD_ALL_STATES}>Все</option>
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
