import { AlertCircle, Bot, CheckCircle2, Clock3, UserRound } from 'lucide-react'
import { resolvePreviewContact } from '@/lib/ai-call/contact-preview'
import { managerActionForResult, resultTone } from '@/lib/ai-call/result-preview'
import type { PreviewMockRun } from '@/lib/ai-call/mock-preview'
import type { PreviewProject } from '@/lib/ai-call/product-preview'
import { HandoffPreviewCard } from './HandoffPreviewCard'

export function ResultsPreviewPanel({
    project,
    result,
}: {
    project: PreviewProject
    result: PreviewMockRun | null
}) {
    if (!result) {
        return (
            <section className="rounded-xl border border-[#E4ECFC] bg-white px-5 py-16 text-center">
                <Bot className="mx-auto h-9 w-9 text-[#2AABEE]" />
                <h2 className="mt-3 text-[17px] font-semibold">Результатов пока нет</h2>
                <p className="mt-1 text-sm text-[#64748B]">Сначала выполните безопасный тестовый запуск.</p>
            </section>
        )
    }

    const contact = resolvePreviewContact(result.phone)
    const tone = resultTone(result)
    const action = managerActionForResult(project.type, result)

    return (
        <section className="space-y-4">
            <div className={`rounded-xl border p-5 ${
                tone === 'failed'
                    ? 'border-[#FECACA] bg-[#FEF2F2]'
                    : tone === 'attention'
                    ? 'border-[#FDE68A] bg-[#FFFBEB]'
                    : 'border-[#BBF7D0] bg-[#F0FDF4]'
            }`}>
                <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                    <div className="flex items-start gap-3">
                        {tone === 'success'
                            ? <CheckCircle2 className="mt-0.5 h-6 w-6 text-[#059669]" />
                            : <AlertCircle className={`mt-0.5 h-6 w-6 ${tone === 'failed' ? 'text-[#DC2626]' : 'text-[#D97706]'}`} />}
                        <div>
                            <p className="text-xs font-medium uppercase tracking-wide text-[#64748B]">Итог mock-звонка</p>
                            <h2 className="mt-1 text-[17px] font-semibold">{result.outcome}</h2>
                            <p className="mt-1 text-sm text-[#64748B]">Следующее действие: {action}</p>
                        </div>
                    </div>
                    <div className="flex items-center gap-2 rounded-lg bg-white/70 px-3 py-2 text-sm">
                        <Clock3 className="h-4 w-4 text-[#64748B]" />
                        {result.durationSec} сек.
                    </div>
                </div>
                <div className="mt-4 grid gap-2 sm:grid-cols-3">
                    <div className="rounded-lg bg-white/70 p-3">
                        <div className="text-xs text-[#64748B]">Квалификация</div>
                        <div className="mt-1 font-semibold">{result.decision.qualification ?? 'Не определена'}</div>
                    </div>
                    <div className="rounded-lg bg-white/70 p-3">
                        <div className="text-xs text-[#64748B]">Score</div>
                        <div className="mt-1 font-semibold">{result.qualificationScore}/100</div>
                    </div>
                    <div className="rounded-lg bg-white/70 p-3">
                        <div className="text-xs text-[#64748B]">Причина</div>
                        <div className="mt-1 font-semibold">{result.decision.stopReason ?? result.selectedBranch}</div>
                    </div>
                </div>
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
                <div className="rounded-xl border border-[#E4ECFC] bg-white p-5">
                    <h3 className="font-semibold">Собранные данные</h3>
                    <dl className="mt-3 space-y-2">
                        {Object.entries(result.extractedData).map(([field, value]) => (
                            <div key={field} className="flex items-start justify-between gap-4 rounded-lg bg-[#F8FAFE] p-3 text-sm">
                                <dt className="text-[#64748B]">{field}</dt>
                                <dd className="text-right font-medium">{value}</dd>
                            </div>
                        ))}
                    </dl>
                </div>
                <div className="rounded-xl border border-[#E4ECFC] bg-white p-5">
                    <h3 className="font-semibold">Привязка Contact</h3>
                    <div className="mt-3 flex items-start gap-3">
                        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[#F1F5FD] text-[#64748B]">
                            <UserRound className="h-5 w-5" />
                        </div>
                        <div>
                            <div className="font-medium">{contact.displayName ?? 'Contact не выбран'}</div>
                            <div className="text-sm text-[#64748B]">{contact.normalizedPhone ?? 'Некорректный номер'}</div>
                            <div className="mt-1 text-xs text-[#64748B]">Статус preview: {contact.status}</div>
                        </div>
                    </div>
                    <div className="mt-3 rounded-lg bg-[#F1F5FD] px-3 py-2 text-xs text-[#64748B]">
                        Это read-only проверка. Production Contact не создаётся и не изменяется.
                    </div>
                </div>
            </div>

            <HandoffPreviewCard result={result} />

            <div className="grid gap-4 lg:grid-cols-2">
                <div className="rounded-xl border border-[#E4ECFC] bg-white p-5">
                    <h3 className="font-semibold">Расшифровка</h3>
                    <div className="mt-3 space-y-2">
                        {result.transcript.map((line, index) => (
                            <div key={`${line.stepId}-${index}`} className="rounded-lg bg-[#F8FAFE] p-3 text-sm">
                                <div className="text-xs font-medium text-[#64748B]">
                                    {line.role === 'ai' ? 'AI' : line.role === 'contact' ? 'Собеседник' : 'Система'}
                                </div>
                                <div className="mt-1">{line.text}</div>
                            </div>
                        ))}
                    </div>
                </div>
                <div className="rounded-xl border border-[#E4ECFC] bg-white p-5">
                    <h3 className="font-semibold">События</h3>
                    <div className="mt-3 space-y-2">
                        {result.events.map((event) => (
                            <div key={event.key} className="flex gap-3 rounded-lg bg-[#F8FAFE] p-3 text-sm">
                                <span className="text-xs font-semibold text-[#2AABEE]">{event.seq}</span>
                                <div>
                                    <div className="font-medium">{event.detail}</div>
                                    <div className="mt-0.5 text-xs text-[#64748B]">{event.type}</div>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            </div>

            {result.decision.validationErrors.length > 0 && (
                <div className="rounded-xl border border-[#FECACA] bg-[#FEF2F2] p-5">
                    <h3 className="font-semibold text-[#B91C1C]">Ошибка AI Decision Contract</h3>
                    <ul className="mt-2 space-y-1 text-sm text-[#B91C1C]">
                        {result.decision.validationErrors.map((error) => <li key={error}>• {error}</li>)}
                    </ul>
                </div>
            )}

            <details className="rounded-xl border border-[#E4ECFC] bg-white p-5">
                <summary className="cursor-pointer text-sm font-medium">Технические данные</summary>
                <div className="mt-3 space-y-1 font-mono text-xs text-[#64748B]">
                    <div>session: {result.sessionId}</div>
                    <div>mode: {result.mode}</div>
                    <div>step: {result.currentStep}</div>
                </div>
            </details>
        </section>
    )
}
