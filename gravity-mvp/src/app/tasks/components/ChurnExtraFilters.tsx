'use client'

// ═══════════════════════════════════════════════════════════════════
// ChurnExtraFilters — block-E churn-specific filters in the toolbar.
//   • Просрочено       — toggle chip
//   • Можно давать акцию — 3-way select (Да / Нет / Согласовать / —)
//   • Какой парк?      — select from top-N distinct loaded values
//
// Other churn filters (Катает в Яндекс / СМЗ / Поездки / Причина оттока)
// are produced generically by DynamicScenarioFilters via scenario-config
// and live on the row above.
// ═══════════════════════════════════════════════════════════════════

import { useTasksStore } from '@/store/tasks-store'
import { useTopParks } from '@/store/tasks-selectors'
import { AlertOctagon } from 'lucide-react'

export default function ChurnExtraFilters() {
    const filters = useTasksStore(s => s.filters)
    const setFilters = useTasksStore(s => s.setFilters)
    const parks = useTopParks(20)

    return (
        <div className="flex items-center gap-2 flex-wrap">
            {/* Просрочено chip */}
            <button
                onClick={() => setFilters({ overdue: filters.overdue ? undefined : true })}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-[12px] font-medium transition-colors ${
                    filters.overdue
                        ? 'bg-[#FEE2E2] text-[#B91C1C] border-[#FCA5A5]'
                        : 'bg-white text-[#64748B] border-[#E4ECFC] hover:border-[#CBD5E1]'
                }`}
            >
                <AlertOctagon className="w-3 h-3" />
                Просрочено
            </button>

            {/* Можно давать акцию */}
            <label className="flex items-center gap-1.5 text-[12px] text-[#64748B]">
                <span className="shrink-0">Акция:</span>
                <select
                    value={filters.offerAllowed ?? ''}
                    onChange={(e) => setFilters({ offerAllowed: (e.target.value || undefined) as typeof filters.offerAllowed })}
                    className="bg-white border border-[#E4ECFC] rounded-lg px-2 py-1 text-[12px] text-[#0F172A] outline-none focus:border-[#1E40AF] cursor-pointer"
                >
                    <option value="">все</option>
                    <option value="yes">Да</option>
                    <option value="no">Нет</option>
                    <option value="maybe">Согласовать</option>
                </select>
            </label>

            {/* Какой парк */}
            <label className="flex items-center gap-1.5 text-[12px] text-[#64748B]">
                <span className="shrink-0">Парк:</span>
                <select
                    value={filters.park ?? ''}
                    onChange={(e) => setFilters({ park: e.target.value || undefined })}
                    disabled={parks.length === 0}
                    className="bg-white border border-[#E4ECFC] rounded-lg px-2 py-1 text-[12px] text-[#0F172A] outline-none focus:border-[#1E40AF] cursor-pointer disabled:opacity-50"
                >
                    <option value="">все</option>
                    {parks.map(p => (
                        <option key={p.value} value={p.value}>
                            {p.value} ({p.count})
                        </option>
                    ))}
                </select>
            </label>
        </div>
    )
}
