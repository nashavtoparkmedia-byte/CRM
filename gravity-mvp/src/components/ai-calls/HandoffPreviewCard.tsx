import { ArrowRightLeft, UserRoundCheck } from 'lucide-react'
import { buildHandoffPreview } from '@/lib/ai-call/handoff-preview'
import type { PreviewMockRun } from '@/lib/ai-call/mock-preview'

export function HandoffPreviewCard({ result }: { result: PreviewMockRun }) {
    const handoff = buildHandoffPreview(result)
    if (handoff.state === 'not_requested') {
        return (
            <div className="rounded-xl border border-[#E4ECFC] bg-white p-5">
                <div className="flex items-center gap-2 text-sm font-medium text-[#64748B]">
                    <UserRoundCheck className="h-4 w-4" />
                    Передача менеджеру не потребовалась
                </div>
            </div>
        )
    }

    return (
        <div className="rounded-xl border border-[#BAE6FD] bg-[#F0F9FF] p-5">
            <div className="flex items-start gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white text-[#2AABEE]">
                    <ArrowRightLeft className="h-5 w-5" />
                </div>
                <div>
                    <h3 className="font-semibold">Mock-передача менеджеру</h3>
                    <p className="mt-1 text-sm text-[#64748B]">Live SIP transfer не выполняется.</p>
                </div>
            </div>
            <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
                <div>
                    <dt className="text-xs text-[#64748B]">Почему</dt>
                    <dd className="mt-1 font-medium">{handoff.reason}</dd>
                </div>
                <div>
                    <dt className="text-xs text-[#64748B]">Кому</dt>
                    <dd className="mt-1 font-medium">{handoff.target}</dd>
                </div>
                <div>
                    <dt className="text-xs text-[#64748B]">Краткое резюме</dt>
                    <dd className="mt-1 font-medium">{handoff.summary}</dd>
                </div>
                <div>
                    <dt className="text-xs text-[#64748B]">Если менеджер недоступен</dt>
                    <dd className="mt-1 font-medium">{handoff.unavailableFallback}</dd>
                </div>
            </dl>
        </div>
    )
}
