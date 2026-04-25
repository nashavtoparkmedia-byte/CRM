'use client'

import React, { useState, useEffect } from 'react'
import { Button } from "@/components/ui/button"
import { 
    getSegmentationSettings, 
    saveSegmentationSettings, 
    getSegmentationPreview, 
    triggerRecalculation 
} from "../segmentation-actions"
import { Thresholds } from "@/lib/scoring"
import { 
    Settings2, 
    Play, 
    Save, 
    RefreshCcw,
    TrendingUp,
    Users,
    Zap,
    X,
    Clock
} from "lucide-react"

interface SegmentationSettingsProps {
    isOpen: boolean
    onClose: () => void
}

export function SegmentationSettings({ isOpen, onClose }: SegmentationSettingsProps) {
    const [settings, setSettings] = useState<Thresholds | null>(null)
    const [preview, setPreview] = useState<Record<string, number> | null>(null)
    const [isLoading, setIsLoading] = useState(false)
    const [isSaving, setIsSaving] = useState(false)
    const [isRecalculating, setIsRecalculating] = useState(false)
    const [toast, setToast] = useState<{ message: string, type: 'success' | 'error' } | null>(null)

    useEffect(() => {
        if (isOpen) {
            loadSettings()
        }
    }, [isOpen])

    useEffect(() => {
        if (toast) {
            const timer = setTimeout(() => setToast(null), 3000)
            return () => clearTimeout(timer)
        }
    }, [toast])

    async function loadSettings() {
        setIsLoading(true)
        try {
            const s = await getSegmentationSettings()
            setSettings(s)
            const p = await getSegmentationPreview(s)
            setPreview(p)
        } catch (error) {
            setToast({ message: "Ошибка загрузки настроек", type: 'error' })
        } finally {
            setIsLoading(false)
        }
    }

    async function handleSave() {
        if (!settings) return
        setIsSaving(true)
        try {
            await saveSegmentationSettings(settings)
            const p = await getSegmentationPreview(settings)
            setPreview(p)
            setToast({ message: "Настройки сохранены", type: 'success' })
        } catch (error) {
            setToast({ message: "Ошибка сохранения", type: 'error' })
        } finally {
            setIsSaving(false)
        }
    }

    async function handleRecalculate() {
        if (!settings) return
        setIsRecalculating(true)
        try {
            await saveSegmentationSettings(settings)
            const result = await triggerRecalculation()
            if (result.syncError) {
                // Sync from Yandex failed — recalc still ran on local data, but warn user
                setToast({
                    message: `Пересчёт по локальным данным (${result.count}). Синхронизация Yandex Fleet недоступна — данные могут быть устаревшими.`,
                    type: 'error'
                })
            } else {
                setToast({ message: `Пересчитано ${result.count} водителей`, type: 'success' })
                setTimeout(onClose, 1500)
            }
        } catch (error) {
            setToast({ message: "Ошибка пересчета", type: 'error' })
        } finally {
            setIsRecalculating(false)
        }
    }

    if (!isOpen || !settings) return null

    return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm animate-in fade-in duration-200">
            <div className="relative w-full max-w-lg rounded-[32px] bg-white shadow-2xl animate-in zoom-in-95 duration-200 overflow-hidden flex flex-col max-h-[90vh]">
                
                {/* Header */}
                <div className="px-8 pt-8 pb-4 flex items-center justify-between">
                    <h2 className="text-2xl font-black text-gray-900 flex items-center gap-3">
                        <div className="bg-yellow-400 p-2 rounded-2xl shadow-sm">
                            <Settings2 className="h-6 w-6 text-gray-900" />
                        </div>
                        Настройка сегментации
                    </h2>
                    <button
                        onClick={onClose}
                        className="p-2 text-gray-400 hover:text-gray-900 hover:bg-gray-100 rounded-full transition-colors"
                    >
                        <X size={24} />
                    </button>
                </div>

                <div className="px-8 pb-8 space-y-6 overflow-y-auto">
                    {/* Main Settings */}
                    <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-2">
                            <label className="text-[11px] font-black uppercase text-gray-400 tracking-wider block ml-1">Период анализа (дней)</label>
                            <input 
                                type="number" 
                                value={settings.analysis_period} 
                                onChange={e => setSettings({...settings, analysis_period: parseInt(e.target.value)})}
                                className="w-full h-11 px-4 rounded-2xl border border-gray-100 bg-gray-50 focus:ring-2 focus:ring-yellow-400 outline-none font-bold text-gray-900 transition-all"
                            />
                        </div>
                        <div className="space-y-2">
                            <label className="text-[11px] font-black uppercase text-gray-400 tracking-wider block ml-1">Неактивность (Выпал)</label>
                            <input 
                                type="number" 
                                value={settings.dropped_days} 
                                onChange={e => setSettings({...settings, dropped_days: parseInt(e.target.value)})}
                                className="w-full h-11 px-4 rounded-2xl border border-gray-100 bg-gray-50 focus:ring-2 focus:ring-yellow-400 outline-none font-bold text-gray-900 transition-all"
                            />
                        </div>
                    </div>

                    <div className="space-y-4 pt-2">
                        <label className="text-[11px] font-black uppercase text-gray-400 tracking-wider block ml-1">Пороги поездок за {settings.analysis_period} дн.</label>
                        
                        <div className="grid grid-cols-3 gap-3">
                            <div className="bg-green-50 rounded-2xl p-4 border border-green-100 space-y-2 group hover:border-green-300 transition-colors">
                                <TrendingUp className="h-4 w-4 text-green-500" />
                                <span className="text-[9px] font-bold text-green-600 block uppercase">Прибыльные</span>
                                <input 
                                    type="number" 
                                    value={settings.profitable_min} 
                                    onChange={e => setSettings({...settings, profitable_min: parseInt(e.target.value)})}
                                    className="w-full border-none bg-transparent p-0 text-xl font-black text-green-700 outline-none"
                                />
                            </div>
                            <div className="bg-blue-50 rounded-2xl p-4 border border-blue-100 space-y-2 group hover:border-blue-300 transition-colors">
                                <Zap className="h-4 w-4 text-blue-500" />
                                <span className="text-[9px] font-bold text-blue-600 block uppercase">Средние</span>
                                <input 
                                    type="number" 
                                    value={settings.medium_min} 
                                    onChange={e => setSettings({...settings, medium_min: parseInt(e.target.value)})}
                                    className="w-full border-none bg-transparent p-0 text-xl font-black text-blue-700 outline-none"
                                />
                            </div>
                            <div className="bg-gray-50 rounded-2xl p-4 border border-gray-100 space-y-2 group hover:border-gray-300 transition-colors">
                                <Users className="h-4 w-4 text-gray-400" />
                                <span className="text-[9px] font-bold text-gray-500 block uppercase">Малые</span>
                                <input 
                                    type="number" 
                                    value={settings.small_min} 
                                    onChange={e => setSettings({...settings, small_min: parseInt(e.target.value)})}
                                    className="w-full border-none bg-transparent p-0 text-xl font-black text-gray-700 outline-none"
                                />
                            </div>
                        </div>
                    </div>

                    {/* Preview Section */}
                    {preview && (
                        <div className="bg-gray-900 rounded-[28px] p-6 text-white space-y-4 shadow-xl relative overflow-hidden">
                            <div className="absolute top-0 right-0 w-32 h-32 bg-yellow-400/5 rounded-full -mr-16 -mt-16 blur-3xl" />
                            <div className="flex items-center justify-between relative z-10">
                                <span className="text-[11px] font-black uppercase text-gray-400 tracking-widest">Предпросмотр сегментов</span>
                                <button 
                                    onClick={loadSettings}
                                    className="p-1 text-gray-400 hover:text-white transition-colors"
                                >
                                    <RefreshCcw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
                                </button>
                            </div>
                            
                            <div className="grid grid-cols-2 gap-x-8 gap-y-3 relative z-10">
                                <div className="flex items-center justify-between">
                                    <div className="flex items-center gap-3">
                                        <div className="w-2 h-2 rounded-full bg-green-400 shadow-[0_0_8px_rgba(74,222,128,0.5)]" />
                                        <span className="text-xs font-bold text-gray-300">Прибыльные</span>
                                    </div>
                                    <span className="text-sm font-black text-white">{preview.profitable}</span>
                                </div>
                                <div className="flex items-center justify-between">
                                    <div className="flex items-center gap-3">
                                        <div className="w-2 h-2 rounded-full bg-blue-400 shadow-[0_0_8px_rgba(96,165,250,0.5)]" />
                                        <span className="text-xs font-bold text-gray-300">Средние</span>
                                    </div>
                                    <span className="text-sm font-black text-white">{preview.medium}</span>
                                </div>
                                <div className="flex items-center justify-between">
                                    <div className="flex items-center gap-3">
                                        <div className="w-2 h-2 rounded-full bg-gray-400 shadow-[0_0_8px_rgba(156,163,175,0.5)]" />
                                        <span className="text-xs font-bold text-gray-300">Малые</span>
                                    </div>
                                    <span className="text-sm font-black text-white">{preview.small}</span>
                                </div>
                                <div className="flex items-center justify-between">
                                    <div className="flex items-center gap-3">
                                        <div className="w-2 h-2 rounded-full bg-red-400 shadow-[0_0_8px_rgba(248,113,113,0.5)]" />
                                        <span className="text-xs font-bold text-gray-300">Выпал</span>
                                    </div>
                                    <span className="text-sm font-black text-white">{preview.dropped}</span>
                                </div>
                            </div>
                        </div>
                    )}
                </div>

                <div className="bg-gray-50 px-8 py-6 flex sm:justify-between items-center gap-4 mt-auto">
                    <button 
                        onClick={onClose}
                        className="font-bold text-gray-500 hover:text-gray-900 transition-colors"
                    >
                        Отмена
                    </button>
                    <div className="flex gap-3">
                        <Button 
                            variant="secondary"
                            onClick={handleSave}
                            disabled={isSaving}
                            className="rounded-2xl font-bold bg-white shadow-sm border border-gray-100 px-6 h-12"
                        >
                            {isSaving ? <RefreshCcw className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4 mr-2" />}
                            Сохранить
                        </Button>
                        <Button 
                            onClick={handleRecalculate}
                            disabled={isRecalculating}
                            className="rounded-2xl font-extrabold bg-yellow-400 hover:bg-yellow-500 text-gray-900 shadow-lg shadow-yellow-200/50 px-8 h-12"
                        >
                            {isRecalculating ? <RefreshCcw className="h-4 w-4 animate-spin mr-2" /> : <Play className="h-4 w-4 mr-2" />}
                            Пересчитать
                        </Button>
                    </div>
                </div>

                {/* Custom Toast */}
                {toast && (
                    <div className={`fixed bottom-8 left-1/2 -translate-x-1/2 px-6 py-3 rounded-2xl shadow-2xl text-white font-bold animate-in slide-in-from-bottom-4 duration-300 z-[110] ${
                        toast.type === 'success' ? 'bg-gray-900' : 'bg-red-600'
                    }`}>
                        {toast.message}
                    </div>
                )}
            </div>
        </div>
    )
}
