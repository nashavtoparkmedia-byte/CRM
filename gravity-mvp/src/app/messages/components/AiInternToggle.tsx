'use client'

/**
 * PR-У: компактный toggle «AI стажёр · ВКЛ/ВЫКЛ» для шапки /messages.
 *
 * Дублирует функционал toggle из /settings/ai/AiControlCenterClient.tsx,
 * чтобы оператор мог включить/выключить стажёра прямо из чатов, не уходя
 * в настройки. Состояние читается из AiAgentConfig singleton (через
 * getAiConfig server action), переключается через saveAiConfig.
 *
 * Optimistic UI + revert при ошибке (как в AiControlCenterClient).
 */
import { useState, useEffect, useTransition } from 'react'
import { Bot } from 'lucide-react'
import { getAiConfig, saveAiConfig } from '@/app/settings/ai/actions'

export default function AiInternToggle() {
    const [enabled, setEnabled] = useState<boolean | null>(null)  // null = loading
    const [pending, startTransition] = useTransition()

    useEffect(() => {
        getAiConfig()
            .then((cfg: any) => setEnabled(cfg?.internEnabled ?? true))
            .catch(() => setEnabled(true))  // fallback default
    }, [])

    const handleToggle = () => {
        if (enabled === null || pending) return
        const newVal = !enabled
        setEnabled(newVal)  // optimistic
        startTransition(async () => {
            try {
                await saveAiConfig({ internEnabled: newVal })
            } catch (e: any) {
                setEnabled(!newVal)  // revert
                console.error('[AiInternToggle] save failed:', e?.message)
            }
        })
    }

    if (enabled === null) {
        // Skeleton — не показываем кнопку пока config не загружен
        return (
            <div className="h-[26px] w-[110px] bg-gray-100 rounded-md animate-pulse" />
        )
    }

    return (
        <button
            onClick={handleToggle}
            disabled={pending}
            title={enabled
                ? 'AI стажёр работает — в чатах при фокусе в input появляется черновик ответа. Нажми чтобы выключить.'
                : 'AI стажёр выключен — черновики в чатах не генерируются. Нажми чтобы включить.'}
            className={`h-[26px] px-2.5 inline-flex items-center gap-1.5 rounded-md text-[11px] font-semibold transition-colors disabled:opacity-50 ${
                enabled
                    ? 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
                    : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
            }`}
        >
            <span className={`w-1.5 h-1.5 rounded-full ${enabled ? 'bg-emerald-500' : 'bg-gray-400'}`} />
            <Bot size={12} className="opacity-70" />
            <span>AI стажёр · {enabled ? 'ВКЛ' : 'ВЫКЛ'}</span>
        </button>
    )
}
