'use client'

import { useState } from 'react'
import { AlertTriangle, Bot, FlaskConical, Play, UserRound } from 'lucide-react'
import {
    runPreviewMock,
    type PreviewMockMode,
    type PreviewMockRun,
} from '@/lib/ai-call/mock-preview'
import type { PreviewScenario } from '@/lib/ai-call/scenario-preview'
import type { PreviewProject } from '@/lib/ai-call/product-preview'
import { ContactResolutionPreview } from './ContactResolutionPreview'

interface Props {
    project: PreviewProject
    scenario: PreviewScenario
    onComplete: (result: PreviewMockRun) => void
}

export function MockCallSimulator({ project, scenario, onComplete }: Props) {
    const [phone, setPhone] = useState('+7 999 000-00-01')
    const [contactName, setContactName] = useState('Тестовый контакт')
    const [answers, setAnswers] = useState('Да, готов обсудить условия и следующий шаг')
    const [mode, setMode] = useState<PreviewMockMode>('normal')
    const [result, setResult] = useState<PreviewMockRun | null>(null)

    function run() {
        const next = runPreviewMock({
            scenario,
            phone,
            contactName,
            answers: answers.split(/\r?\n/),
            mode,
        })
        setResult(next)
        onComplete(next)
    }

    return (
        <section className="grid gap-4 lg:grid-cols-[380px_1fr]">
            <div className="rounded-xl border border-[#E4ECFC] bg-white p-5">
                <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[#E8F5FD] text-[#2AABEE]">
                        <FlaskConical className="h-5 w-5" />
                    </div>
                    <div>
                        <h2 className="text-[17px] font-semibold">Тестовый запуск</h2>
                        <p className="text-sm text-[#64748B]">{project.name} · v{scenario.version}</p>
                    </div>
                </div>
                <div className="mt-4 rounded-lg bg-[#ECFDF5] px-3 py-2 text-sm text-[#047857]">
                    Локальная симуляция: провайдеры, SIP и база данных не используются.
                </div>
                <label className="mt-5 block text-[13px] font-medium">Тестовый телефон</label>
                <input
                    value={phone}
                    onChange={(event) => setPhone(event.target.value)}
                    className="mt-1 h-11 w-full rounded-lg border border-[#E4ECFC] px-3 outline-none focus:border-[#2AABEE]"
                />
                <ContactResolutionPreview phone={phone} />
                <label className="mt-4 block text-[13px] font-medium">Имя тестового Contact</label>
                <input
                    value={contactName}
                    onChange={(event) => setContactName(event.target.value)}
                    className="mt-1 h-11 w-full rounded-lg border border-[#E4ECFC] px-3 outline-none focus:border-[#2AABEE]"
                />
                <label className="mt-4 block text-[13px] font-medium">Ответы собеседника</label>
                <textarea
                    value={answers}
                    onChange={(event) => setAnswers(event.target.value)}
                    rows={5}
                    className="mt-1 w-full rounded-lg border border-[#E4ECFC] px-3 py-2 outline-none focus:border-[#2AABEE]"
                />
                <label className="mt-4 block text-[13px] font-medium">Проверяемый исход</label>
                <select
                    value={mode}
                    onChange={(event) => setMode(event.target.value as PreviewMockMode)}
                    className="mt-1 h-11 w-full rounded-lg border border-[#E4ECFC] bg-white px-3 outline-none focus:border-[#2AABEE]"
                >
                    <option value="normal">Определить по ответу</option>
                    <option value="transfer">Передача менеджеру</option>
                    <option value="invalid-output">Некорректный ответ AI</option>
                </select>
                <button
                    type="button"
                    onClick={run}
                    className="mt-5 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-lg bg-[#2AABEE] px-4 text-[15px] font-semibold text-white hover:bg-[#1E96D4]"
                >
                    <Play className="h-4 w-4" />
                    Запустить mock-разговор
                </button>
            </div>

            <div className="rounded-xl border border-[#E4ECFC] bg-white p-5">
                <h3 className="text-[17px] font-semibold">Диалог</h3>
                {!result ? (
                    <div className="flex min-h-80 flex-col items-center justify-center text-center">
                        <Bot className="h-9 w-9 text-[#2AABEE]" />
                        <p className="mt-3 font-medium">Симуляция ещё не запускалась</p>
                        <p className="mt-1 max-w-sm text-sm text-[#64748B]">Введите тестовые ответы и запустите безопасный mock-разговор.</p>
                    </div>
                ) : (
                    <>
                        <div className="mt-4 space-y-3">
                            {result.transcript.map((line, index) => (
                                <div
                                    key={`${line.stepId}-${index}`}
                                    className={`flex gap-2 ${line.role === 'contact' ? 'justify-end' : 'justify-start'}`}
                                >
                                    {line.role !== 'contact' && (
                                        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#E8F5FD] text-[#2AABEE]">
                                            {line.role === 'system' ? <AlertTriangle className="h-4 w-4" /> : <Bot className="h-4 w-4" />}
                                        </div>
                                    )}
                                    <div className={`max-w-[78%] rounded-2xl px-3 py-2 text-sm ${
                                        line.role === 'contact'
                                            ? 'rounded-br-sm bg-[#2AABEE] text-white'
                                            : line.role === 'system'
                                            ? 'rounded-bl-sm bg-[#FEF2F2] text-[#B91C1C]'
                                            : 'rounded-bl-sm bg-[#F1F5FD]'
                                    }`}>
                                        {line.text}
                                    </div>
                                    {line.role === 'contact' && (
                                        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#F1F5FD] text-[#64748B]">
                                            <UserRound className="h-4 w-4" />
                                        </div>
                                    )}
                                </div>
                            ))}
                        </div>
                        <div className="mt-5 grid gap-2 border-t border-[#E4ECFC] pt-4 sm:grid-cols-3">
                            <div className="rounded-lg bg-[#F8FAFE] p-3">
                                <div className="text-xs text-[#64748B]">Текущий шаг</div>
                                <div className="mt-1 text-sm font-medium">{result.currentStep}</div>
                            </div>
                            <div className="rounded-lg bg-[#F8FAFE] p-3">
                                <div className="text-xs text-[#64748B]">Выбранная ветка</div>
                                <div className="mt-1 text-sm font-medium">{result.selectedBranch}</div>
                            </div>
                            <div className="rounded-lg bg-[#F8FAFE] p-3">
                                <div className="text-xs text-[#64748B]">Score</div>
                                <div className="mt-1 text-sm font-medium">{result.qualificationScore}/100</div>
                            </div>
                        </div>
                    </>
                )}
            </div>
        </section>
    )
}
