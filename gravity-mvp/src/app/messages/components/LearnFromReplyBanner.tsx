'use client'

/**
 * PR-С: Banner после отправки outbound — предлагает обучить AI на ответе оператора.
 *
 * Показывается только если backend сказал mode='show_banner' (т.е. был
 * AI-черновик и оператор существенно отличается от него).
 *
 * Click «Обучить» → открывает AiCoachModal с предзаполненным sentText.
 * Click «Не сейчас» → закрывает banner.
 */
import { Bot, X, GraduationCap } from 'lucide-react'

interface Props {
    similarityPct: number
    onTrain:       () => void
    onDismiss:     () => void
}

export default function LearnFromReplyBanner({ similarityPct, onTrain, onDismiss }: Props) {
    return (
        <div className="flex justify-start px-[4px] py-[2px]">
            <div className="inline-flex items-start gap-[2px] rounded-lg bg-blue-50 border border-blue-200 px-3 py-[2px] text-[12px] max-w-[80%]">
                <GraduationCap size={14} className="text-blue-500 mt-[2px] shrink-0" />
                <div className="flex-1">
                    <div className="text-[12px] text-blue-900 font-medium leading-snug">
                        Ваш ответ отличается от того что предлагал AI ({similarityPct}% совпадения).
                    </div>
                    <div className="text-[11px] text-blue-700 mt-0.5 leading-snug">
                        Обучить AI стажёра на вашем варианте?
                    </div>
                    <div className="mt-1.5 flex items-center gap-[2px]">
                        <button
                            type="button"
                            onClick={onTrain}
                            className="bg-blue-500 hover:bg-blue-600 text-white text-[11px] font-semibold px-2.5 py-1 rounded-md flex items-center gap-1 transition-colors"
                        >
                            <Bot size={11} />
                            Обучить
                        </button>
                        <button
                            type="button"
                            onClick={onDismiss}
                            className="text-[11px] text-blue-600 hover:text-blue-800 px-2.5 py-1 rounded-md hover:bg-blue-100 transition-colors"
                        >
                            Не сейчас
                        </button>
                    </div>
                </div>
                <button
                    type="button"
                    onClick={onDismiss}
                    className="text-blue-400 hover:text-blue-700 shrink-0"
                    aria-label="Скрыть"
                >
                    <X size={12} />
                </button>
            </div>
        </div>
    )
}
