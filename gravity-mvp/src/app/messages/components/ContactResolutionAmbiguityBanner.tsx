import { AlertTriangle, Search } from 'lucide-react'

export default function ContactResolutionAmbiguityBanner({
    candidateCount,
    onManualSearch,
}: {
    candidateCount: number
    onManualSearch: () => void
}) {
    return (
        <div role="alert" className="mx-3 mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-left">
            <div className="flex items-start gap-2">
                <AlertTriangle size={16} className="mt-0.5 shrink-0 text-amber-600" />
                <div className="min-w-0">
                    <div className="text-[12px] font-semibold text-amber-900">
                        Не удалось автоматически связать контакт
                    </div>
                    <div className="mt-1 text-[11px] leading-4 text-amber-800">
                        Найдено подходящих карточек: {candidateCount}. Автоматическая привязка не выполнена.
                        Выберите контакт вручную, затем при необходимости выполните объединение.
                    </div>
                    <button
                        type="button"
                        onClick={onManualSearch}
                        className="mt-2 inline-flex h-7 items-center gap-1 rounded-md bg-white px-2 text-[11px] font-semibold text-amber-800 ring-1 ring-inset ring-amber-300 hover:bg-amber-100"
                    >
                        <Search size={11} /> Найти и привязать вручную
                    </button>
                </div>
            </div>
        </div>
    )
}
