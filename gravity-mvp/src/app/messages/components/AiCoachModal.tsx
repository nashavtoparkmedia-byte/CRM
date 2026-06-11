'use client'

/**
 * PR9.55 «AI Coach» — модалка для обучения AI на правках менеджера.
 *
 * Flow (3 шага в одном modal'е):
 *
 *   1. EDIT     — текстарея с draft AI, менеджер правит и жмёт «Обучить»
 *   2. LOADING  — спиннер «AI анализирует исправления…» (1-3 сек LLM call)
 *   3. APPROVAL — список предложенных изменений с чекбоксами:
 *                 «Изменить «X»: 3.99% → 4.5%? [✓] [✗]»
 *                 Кнопка «Применить выбранные» → apply + close
 *
 * Если LLM сказал «только стиль» — Step 3 показывает info-state
 * «Изменений по фактам не требуется. Текст сохранён для отправки.»
 *
 * После apply menager жмёт «Закрыть и отправить» → текст копируется
 * в input bar родителя (через onApply callback).
 */

import { useState, useEffect, useRef } from 'react'
import { Bot, Loader2, Check, X, ChevronRight } from 'lucide-react'
import {
    coachFromCorrection,
    applyCoachSuggestions,
    type ApplyCoachResult,
} from '../proposed-reply-actions'
import type { CoachSuggestion, CoachResult } from '@/lib/ai/knowledge/coach'

interface AiCoachModalProps {
    proposalId:    string
    originalDraft: string
    onClose:       () => void
    /** Callback после успешного apply (или skip) — родитель копирует
     *  текст в input bar и закрывает modal. */
    onApply:       (correctedText: string, result: ApplyCoachResult | null) => void
    /** PR-С: если задан, textarea предзаполняется этим текстом
     *  (используется когда оператор уже отправил ответ и мы учим AI на нём). */
    initialCorrectedText?: string
    /** PR-С: если true, сразу пропускаем шаг EDIT и запускаем coach.
     *  Применимо когда initialCorrectedText заранее задан. */
    autoStart?: boolean
}

type Step = 'edit' | 'loading' | 'approval' | 'applying' | 'done'

export default function AiCoachModal({
    proposalId,
    originalDraft,
    onClose,
    onApply,
    initialCorrectedText,
    autoStart,
}: AiCoachModalProps) {
    const [step, setStep] = useState<Step>('edit')
    const [correctedText, setCorrectedText] = useState(initialCorrectedText ?? originalDraft)
    const [coachResult, setCoachResult] = useState<CoachResult | null>(null)
    const [selected, setSelected] = useState<Set<string>>(new Set())
    const [applyResult, setApplyResult] = useState<ApplyCoachResult | null>(null)
    const [error, setError] = useState<string | null>(null)
    const autoStartRef = useRef(false)

    // PR-С: если открыт с initialCorrectedText + autoStart → сразу запустить coach
    useEffect(() => {
        if (autoStart && initialCorrectedText && !autoStartRef.current) {
            autoStartRef.current = true
            handleStartCoach()
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [autoStart, initialCorrectedText])

    const handleStartCoach = async () => {
        if (!correctedText.trim()) return
        setStep('loading')
        setError(null)
        try {
            const r = await coachFromCorrection(proposalId, correctedText)
            setCoachResult(r)
            // По умолчанию все suggestions selected
            setSelected(new Set(r.suggestions.map(s => s.itemId)))
            setStep('approval')
        } catch (e: any) {
            setError(e?.message ?? 'Ошибка генерации')
            setStep('edit')
        }
    }

    const handleApply = async () => {
        if (!coachResult) return
        const toApply = coachResult.suggestions.filter(s => selected.has(s.itemId))
        if (toApply.length === 0) {
            // Nothing to apply — просто закрываем
            onApply(correctedText, null)
            return
        }
        setStep('applying')
        try {
            const r = await applyCoachSuggestions(proposalId, toApply)
            setApplyResult(r)
            setStep('done')
        } catch (e: any) {
            setError(e?.message ?? 'Ошибка применения')
            setStep('approval')
        }
    }

    const handleFinish = () => {
        onApply(correctedText, applyResult)
    }

    const toggleSel = (id: string) => {
        setSelected(prev => {
            const next = new Set(prev)
            if (next.has(id)) next.delete(id)
            else next.add(id)
            return next
        })
    }

    return (
        <div
            className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-[4px] pt-[16px]"
            onClick={() => step !== 'loading' && step !== 'applying' && onClose()}
        >
            <div
                className="bg-white rounded-xl w-full max-w-2xl flex flex-col max-h-[85vh] overflow-hidden"
                onClick={e => e.stopPropagation()}
            >
                {/* Header */}
                <div className="px-6 py-[4px] border-b border-[#F0F0F0]">
                    <h2 className="text-[16px] font-semibold text-[#111] flex items-center gap-[2px]">
                        <Bot size={16} className="text-[#3390EC]" />
                        Обучить AI
                    </h2>
                    <p className="text-[12px] text-gray-500 mt-0.5">
                        {step === 'edit' && 'Поправь черновик. AI найдёт что устарело в Ядре знаний.'}
                        {step === 'loading' && 'AI анализирует исправления…'}
                        {step === 'approval' && (coachResult?.onlyStyleChange
                            ? 'Менеджер исправил только стиль — обучать нечему.'
                            : 'Подтверди какие факты обновить в Ядре.')}
                        {step === 'applying' && 'Обновляем Ядро знаний…'}
                        {step === 'done' && 'Готово.'}
                    </p>
                </div>

                {/* Body */}
                <div className="px-6 py-5 overflow-y-auto flex-1 space-y-[4px]">
                    {/* STEP: EDIT — textarea с draft */}
                    {step === 'edit' && (
                        <>
                            <div className="text-[11px] uppercase tracking-wide text-gray-500 font-semibold">
                                Текст для отправки
                            </div>
                            <textarea
                                value={correctedText}
                                onChange={e => setCorrectedText(e.target.value)}
                                rows={6}
                                className="w-full border border-[#E0E0E0] rounded-lg p-3 text-[14px] outline-none focus:border-[#3390EC] resize-y"
                                placeholder="Исправь то, что AI ответил неверно…"
                            />
                            {error && (
                                <div className="text-[12px] text-red-600">{error}</div>
                            )}
                            <div className="text-[11px] text-gray-500 leading-relaxed">
                                После «Обучить» AI сравнит твою правку с своим черновиком
                                и предложит обновить факты в Ядре. Ты подтвердишь — или нет.
                            </div>
                        </>
                    )}

                    {/* STEP: LOADING / APPLYING — spinner */}
                    {(step === 'loading' || step === 'applying') && (
                        <div className="flex flex-col items-center justify-center py-10 gap-3">
                            <Loader2 size={24} className="animate-spin text-[#3390EC]" />
                            <div className="text-[13px] text-gray-600">
                                {step === 'loading' ? 'AI думает что устарело…' : 'Обновляем Ядро…'}
                            </div>
                        </div>
                    )}

                    {/* STEP: APPROVAL — suggestions */}
                    {step === 'approval' && coachResult && (
                        <>
                            {coachResult.onlyStyleChange && (
                                <div className="rounded-md border border-[#E8E8E8] bg-[#FAFBFC] p-3 text-[12px] text-gray-600 leading-relaxed">
                                    Менеджер исправил только стиль (формулировку/тон) — факты
                                    в Ядре остались в силе. Сохранил твой текст для отправки.
                                </div>
                            )}
                            {coachResult.suggestions.length === 0 && !coachResult.onlyStyleChange && (
                                <div className="rounded-md border border-[#E8E8E8] bg-[#FAFBFC] p-3 text-[12px] text-gray-600 leading-relaxed">
                                    AI не нашёл что обновить в Ядре по этой правке.
                                    {coachResult.note && (
                                        <div className="text-[11px] text-gray-400 mt-1">
                                            {coachResult.note}
                                        </div>
                                    )}
                                </div>
                            )}
                            {coachResult.suggestions.length > 0 && (
                                <div className="space-y-[2px]">
                                    {coachResult.suggestions.map(s => {
                                        const checked = selected.has(s.itemId)
                                        return (
                                            <label
                                                key={s.itemId}
                                                className={`flex items-start gap-2.5 p-3 rounded-lg border cursor-pointer transition-colors ${
                                                    checked
                                                        ? 'border-[#3390EC] bg-[#F0F4FA]'
                                                        : 'border-[#E0E0E0] bg-white hover:bg-[#FAFBFC]'
                                                }`}
                                            >
                                                <input
                                                    type="checkbox"
                                                    checked={checked}
                                                    onChange={() => toggleSel(s.itemId)}
                                                    className="mt-0.5 shrink-0"
                                                />
                                                <div className="flex-1 min-w-0">
                                                    <div className="text-[13px] font-semibold text-[#111] mb-1">
                                                        {s.itemTitle}
                                                    </div>
                                                    <div className="text-[11px] text-gray-500 mb-1.5">
                                                        {s.reasoning}
                                                    </div>
                                                    <div className="text-[12px] text-gray-700 leading-snug">
                                                        <span className="text-gray-400 line-through">
                                                            {s.currentValue}
                                                        </span>
                                                    </div>
                                                    <div className="text-[12px] text-[#111] leading-snug mt-1 flex items-start gap-1">
                                                        <ChevronRight size={12} className="text-emerald-600 mt-[2px] shrink-0" />
                                                        {s.newValue}
                                                    </div>
                                                </div>
                                            </label>
                                        )
                                    })}
                                </div>
                            )}
                            {error && (
                                <div className="text-[12px] text-red-600">{error}</div>
                            )}
                        </>
                    )}

                    {/* STEP: DONE — итог */}
                    {step === 'done' && applyResult && (
                        <div className="space-y-3">
                            <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-[13px] text-emerald-800 leading-relaxed">
                                <div className="font-semibold mb-1">
                                    ✓ Обновлено в Ядре: {applyResult.applied.length}
                                </div>
                                {applyResult.applied.length > 0 && (
                                    <ul className="text-[12px] space-y-0.5">
                                        {applyResult.applied.map(a => (
                                            <li key={a.itemId}>· {a.title}</li>
                                        ))}
                                    </ul>
                                )}
                                {applyResult.skipped.length > 0 && (
                                    <div className="mt-[2px] text-[12px] text-amber-700">
                                        Пропущено: {applyResult.skipped.length}
                                    </div>
                                )}
                            </div>
                            <div className="text-[12px] text-gray-500">
                                Теперь текст можно отправить — кнопка ниже.
                            </div>
                        </div>
                    )}
                </div>

                {/* Footer */}
                <div className="px-6 py-3 border-t border-[#F0F0F0] flex items-center justify-end gap-[2px]">
                    {step === 'edit' && (
                        <>
                            <button
                                onClick={onClose}
                                className="h-[34px] px-[4px] rounded-lg border border-[#E0E0E0] bg-white text-[12px] font-semibold text-gray-700 hover:bg-[#F8F9FA] transition-colors"
                            >
                                Отмена
                            </button>
                            <button
                                onClick={handleStartCoach}
                                disabled={!correctedText.trim() || correctedText.trim() === originalDraft.trim()}
                                title={correctedText.trim() === originalDraft.trim()
                                    ? 'Сначала исправь черновик'
                                    : 'Запустить AI для анализа исправлений'}
                                className="h-[34px] px-[4px] rounded-lg bg-[#3390EC] text-white text-[12px] font-semibold hover:bg-[#2B7FD4] disabled:opacity-50 disabled:cursor-not-allowed transition-colors inline-flex items-center gap-1.5"
                            >
                                <Bot size={12} />
                                Обучить AI
                            </button>
                        </>
                    )}
                    {step === 'approval' && (
                        <>
                            <button
                                onClick={() => onApply(correctedText, null)}
                                className="h-[34px] px-[4px] rounded-lg border border-[#E0E0E0] bg-white text-[12px] font-semibold text-gray-700 hover:bg-[#F8F9FA] transition-colors"
                            >
                                Не обновлять
                            </button>
                            {coachResult && coachResult.suggestions.length > 0 && (
                                <button
                                    onClick={handleApply}
                                    disabled={selected.size === 0}
                                    className="h-[34px] px-[4px] rounded-lg bg-emerald-600 text-white text-[12px] font-semibold hover:bg-emerald-700 disabled:opacity-50 transition-colors inline-flex items-center gap-1.5"
                                >
                                    <Check size={12} />
                                    Применить {selected.size > 0 && `(${selected.size})`}
                                </button>
                            )}
                        </>
                    )}
                    {step === 'done' && (
                        <button
                            onClick={handleFinish}
                            className="h-[34px] px-[4px] rounded-lg bg-[#3390EC] text-white text-[12px] font-semibold hover:bg-[#2B7FD4] transition-colors"
                        >
                            Закрыть и отправить
                        </button>
                    )}
                </div>
            </div>
        </div>
    )
}
