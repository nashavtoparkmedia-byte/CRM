'use client'

/**
 * PR-Т: Popover «Улучшить с ИИ» + diff preview modal.
 *
 * Сценарий:
 *   1. Оператор пишет черновик в input
 *   2. Жмёт кнопку ✨ → открывается popover с пресетами
 *   3. Выбирает «Просто улучшить» или «Подробнее»
 *   4. Loading 2-3 сек, потом diff preview modal
 *   5. [Применить] / [Оставить мой] / [Ещё вариант]
 *
 * Применить → onApply(text) — родитель меняет text в input.
 */
import { useState, useEffect, useRef } from 'react'
import { Sparkles, Loader2, X, Check, RefreshCw } from 'lucide-react'
import { improveDraftAction } from '../improve-draft-actions'
import type { ImprovePreset } from '@/lib/ai/improveDraft'

interface Props {
    chatId:    string
    draft:     string
    onApply:   (improved: string) => void
    disabled?: boolean
}

type State =
    | { phase: 'idle' }
    | { phase: 'menu' }
    | { phase: 'loading'; preset: ImprovePreset }
    | { phase: 'preview'; preset: ImprovePreset; improved: string }
    | { phase: 'error';   message: string }

const PRESETS: Array<{ id: ImprovePreset; label: string; desc: string }> = [
    { id: 'improve', label: '✨ Просто улучшить', desc: 'Грамотный текст, тот же объём' },
    { id: 'expand',  label: '📝 Подробнее',       desc: 'Развернуть, добавить деталей' },
]

export default function ImproveDraftPopover({ chatId, draft, onApply, disabled }: Props) {
    const [state, setState] = useState<State>({ phase: 'idle' })
    const buttonRef = useRef<HTMLButtonElement>(null)
    const popoverRef = useRef<HTMLDivElement>(null)

    // Close menu on outside click
    useEffect(() => {
        if (state.phase !== 'menu') return
        const handler = (e: MouseEvent) => {
            if (popoverRef.current?.contains(e.target as Node)) return
            if (buttonRef.current?.contains(e.target as Node)) return
            setState({ phase: 'idle' })
        }
        document.addEventListener('mousedown', handler)
        return () => document.removeEventListener('mousedown', handler)
    }, [state.phase])

    const isLocked = disabled || !draft.trim() || draft.trim().length < 3

    const runImprove = async (preset: ImprovePreset) => {
        setState({ phase: 'loading', preset })
        const r = await improveDraftAction(chatId, draft, preset)
        if (!r.ok) {
            setState({ phase: 'error', message: r.error })
            return
        }
        setState({ phase: 'preview', preset, improved: r.improved })
    }

    return (
        <>
            <button
                ref={buttonRef}
                onClick={() => !isLocked && setState({ phase: state.phase === 'idle' ? 'menu' : 'idle' })}
                disabled={isLocked}
                className={`h-[36px] w-[36px] rounded-full flex items-center justify-center transition-colors shrink-0 ${
                    isLocked
                        ? 'text-gray-300 cursor-not-allowed'
                        : state.phase !== 'idle'
                            ? 'bg-purple-100 text-purple-600'
                            : 'hover:bg-gray-100 text-gray-400 hover:text-purple-500'
                }`}
                title={isLocked ? 'Напишите черновик чтобы улучшить' : 'Улучшить с ИИ'}
            >
                <Sparkles size={17} />
            </button>

            {/* Menu popover */}
            {state.phase === 'menu' && (
                <div
                    ref={popoverRef}
                    className="absolute bottom-full left-0 mb-2 bg-white rounded-xl shadow-xl border border-[#E0E0E0] py-1.5 min-w-[260px] z-50 animate-in fade-in slide-in-from-bottom-1 duration-150"
                >
                    <div className="px-3 py-1.5 text-[10px] font-bold text-gray-400 uppercase tracking-wider">
                        Улучшить с ИИ
                    </div>
                    {PRESETS.map(p => (
                        <button
                            key={p.id}
                            onClick={() => runImprove(p.id)}
                            className="w-full px-3 py-2 text-left hover:bg-purple-50 transition-colors"
                        >
                            <div className="text-[13px] font-medium text-[#111]">{p.label}</div>
                            <div className="text-[11px] text-gray-500 mt-0.5">{p.desc}</div>
                        </button>
                    ))}
                </div>
            )}

            {/* Loading overlay (chip над input) */}
            {state.phase === 'loading' && (
                <div className="absolute bottom-full left-0 mb-2 bg-purple-50 border border-purple-200 rounded-lg px-3 py-1.5 z-50 flex items-center gap-2">
                    <Loader2 size={14} className="text-purple-500 animate-spin" />
                    <span className="text-[12px] text-purple-700 font-medium">
                        AI улучшает черновик...
                    </span>
                </div>
            )}

            {/* Error toast */}
            {state.phase === 'error' && (
                <div className="absolute bottom-full left-0 mb-2 bg-red-50 border border-red-200 rounded-lg px-3 py-1.5 z-50 flex items-center gap-2">
                    <X size={14} className="text-red-500" />
                    <span className="text-[12px] text-red-700">{state.message}</span>
                    <button
                        onClick={() => setState({ phase: 'idle' })}
                        className="ml-1 text-red-400 hover:text-red-700"
                    >
                        <X size={12} />
                    </button>
                </div>
            )}

            {/* Diff preview modal */}
            {state.phase === 'preview' && (
                <div
                    className="fixed inset-0 bg-black/40 z-[100] flex items-start justify-center pt-[8vh]"
                    onClick={() => setState({ phase: 'idle' })}
                >
                    <div
                        className="bg-white rounded-xl shadow-2xl w-full max-w-[600px] max-h-[80vh] flex flex-col overflow-hidden"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="px-5 py-3.5 border-b border-gray-200 flex items-center justify-between">
                            <div className="flex items-center gap-2">
                                <Sparkles size={16} className="text-purple-500" />
                                <h3 className="font-semibold text-[15px] text-[#111]">
                                    AI улучшил черновик
                                </h3>
                            </div>
                            <button
                                onClick={() => setState({ phase: 'idle' })}
                                className="p-1 rounded-md hover:bg-gray-100 text-gray-400"
                            >
                                <X size={16} />
                            </button>
                        </div>

                        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
                            {/* Было */}
                            <div>
                                <div className="text-[11px] font-bold text-gray-400 uppercase tracking-wider mb-1.5">
                                    Было
                                </div>
                                <div className="bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 text-[13px] text-gray-600 whitespace-pre-wrap">
                                    {draft}
                                </div>
                            </div>

                            {/* Стало */}
                            <div>
                                <div className="text-[11px] font-bold text-purple-600 uppercase tracking-wider mb-1.5">
                                    Стало
                                </div>
                                <div className="bg-purple-50 border border-purple-200 rounded-lg px-3 py-2 text-[13px] text-[#111] whitespace-pre-wrap">
                                    {state.improved}
                                </div>
                            </div>
                        </div>

                        <div className="px-5 py-3 border-t border-gray-200 flex items-center justify-between gap-2 bg-gray-50">
                            <button
                                onClick={() => runImprove(state.preset)}
                                className="text-[12px] text-gray-600 hover:text-gray-900 font-medium flex items-center gap-1.5 px-3 py-1.5 rounded-md hover:bg-gray-200 transition-colors"
                            >
                                <RefreshCw size={12} />
                                Ещё вариант
                            </button>
                            <div className="flex items-center gap-2">
                                <button
                                    onClick={() => setState({ phase: 'idle' })}
                                    className="text-[12px] text-gray-600 hover:text-[#111] font-medium px-3 py-1.5 rounded-md hover:bg-gray-200 transition-colors"
                                >
                                    Оставить мой
                                </button>
                                <button
                                    onClick={() => {
                                        onApply(state.improved)
                                        setState({ phase: 'idle' })
                                    }}
                                    className="bg-purple-500 hover:bg-purple-600 text-white text-[12px] font-semibold px-4 py-1.5 rounded-md flex items-center gap-1.5 transition-colors"
                                >
                                    <Check size={13} />
                                    Применить
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </>
    )
}
