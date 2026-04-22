'use client'

// ═══════════════════════════════════════════════════════════════════
// TaskListExcelButtons — Excel export + import against the canonical
// «Отток_шаблон» template.
//
//   Export  → exportChurnXlsx (server action) → template-based .xlsx
//   Import  → previewChurnImport → diff dialog → applyChurnImport
//
// Neither side knows the column contract — it lives in lib/tasks/excel-contract.ts.
// ═══════════════════════════════════════════════════════════════════

import { useRef, useState, useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Upload, Download, Loader2, ChevronDown, FileSpreadsheet, FileText } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { pushToast } from '@/lib/tasks/toast-store'
import { recordUsage } from '@/lib/tasks/usage'
import { useTasksStore } from '@/store/tasks-store'
import { CHURN_COLUMNS } from '@/lib/tasks/excel-contract'
import {
    exportChurnXlsx,
    exportChurnTemplate,
    previewChurnImport,
    applyChurnImport,
    type ImportPreviewResult,
} from '../excel-actions'

export default function TaskListExcelButtons() {
    const qc = useQueryClient()
    const filters = useTasksStore(s => s.filters)
    const sort = useTasksStore(s => s.sort)

    const fileInputRef = useRef<HTMLInputElement>(null)
    const [busy, setBusy] = useState<'export' | 'import' | null>(null)
    const [exportOpen, setExportOpen] = useState(false)
    const exportRef = useRef<HTMLDivElement>(null)
    const [preview, setPreview] = useState<ImportPreviewResult | null>(null)
    const [pendingBase64, setPendingBase64] = useState<string | null>(null)
    const [applying, setApplying] = useState(false)

    useEffect(() => {
        if (!exportOpen) return
        const handler = (e: MouseEvent) => {
            if (exportRef.current && !exportRef.current.contains(e.target as Node)) setExportOpen(false)
        }
        document.addEventListener('mousedown', handler)
        return () => document.removeEventListener('mousedown', handler)
    }, [exportOpen])

    const runExport = async (kind: 'data' | 'template') => {
        if (busy) return
        setBusy('export')
        setExportOpen(false)
        void recordUsage('excel_click', { kind: kind === 'data' ? 'export' : 'export_template' })
        try {
            const result = kind === 'data'
                ? await exportChurnXlsx(filters, sort)
                : await exportChurnTemplate()
            const bytes = Uint8Array.from(atob(result.base64), c => c.charCodeAt(0))
            const blob = new Blob([bytes as unknown as ArrayBuffer], {
                type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            })
            downloadBlob(blob, result.filename)
            pushToast(
                kind === 'data'
                    ? `Экспортировано ${result.rowCount} кейсов`
                    : `Шаблон для импорта сохранён`,
                'success',
            )
        } catch (e) {
            pushToast('Ошибка экспорта: ' + (e as Error).message, 'error')
        } finally {
            setBusy(null)
        }
    }

    const handleImportClick = () => {
        if (busy) return
        void recordUsage('excel_click', { kind: 'import' })
        fileInputRef.current?.click()
    }

    const handleFileChosen: React.ChangeEventHandler<HTMLInputElement> = async (e) => {
        const file = e.target.files?.[0]
        e.target.value = '' // allow same-file re-selection
        if (!file) return
        setBusy('import')
        try {
            const buf = await file.arrayBuffer()
            const base64 = arrayBufferToBase64(buf)
            const result = await previewChurnImport(base64)
            setPendingBase64(base64)
            setPreview(result)
        } catch (err) {
            pushToast('Не удалось прочитать файл: ' + (err as Error).message, 'error')
        } finally {
            setBusy(null)
        }
    }

    const handleRemap = async (columnOverrides: Record<string, string>) => {
        if (!pendingBase64) return
        setBusy('import')
        try {
            const result = await previewChurnImport(pendingBase64, columnOverrides)
            setPreview(result)
            void recordUsage('excel_click', { kind: 'import_remap', mappingCount: Object.keys(columnOverrides).length })
        } catch (err) {
            pushToast('Не удалось пересчитать предпросмотр: ' + (err as Error).message, 'error')
        } finally {
            setBusy(null)
        }
    }

    const handleApply = async () => {
        if (!preview || applying) return
        setApplying(true)
        try {
            const res = await applyChurnImport(preview.token)
            await qc.invalidateQueries({ queryKey: ['tasks'] })
            setPreview(null)
            if (res.errors.length === 0) {
                const parts = []
                if (res.created) parts.push(`создано ${res.created}`)
                if (res.updated) parts.push(`обновлено ${res.updated}`)
                if (res.skipped) parts.push(`пропущено ${res.skipped}`)
                pushToast(`Импорт: ${parts.join(', ') || 'изменений нет'}`, 'success')
            } else {
                pushToast(`Импорт частично: создано ${res.created}, обновлено ${res.updated}, ошибок ${res.errors.length}`, 'error')
                console.error('[import] errors:', res.errors)
            }
        } catch (e) {
            pushToast('Ошибка применения: ' + (e as Error).message, 'error')
        } finally {
            setApplying(false)
        }
    }

    return (
        <>
            <div className="flex items-center gap-1">
                <div ref={exportRef} className="relative">
                    <button
                        onClick={() => setExportOpen(o => !o)}
                        disabled={!!busy}
                        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-[#E4ECFC] text-[#64748B] text-[12px] font-medium hover:bg-[#F1F5FD] transition-colors disabled:opacity-50"
                        title="Экспорт в Excel"
                    >
                        {busy === 'export' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
                        Экспорт
                        <ChevronDown className="w-3 h-3 opacity-60" />
                    </button>
                    {exportOpen && (
                        <div className="absolute right-0 top-full mt-1 z-40 min-w-[240px] bg-white rounded-lg shadow-md border border-[#E4ECFC] py-1 text-[13px]">
                            <button
                                onClick={() => runExport('data')}
                                className="w-full flex items-start gap-2 px-3 py-2 hover:bg-[#F8FAFC] transition-colors text-left"
                            >
                                <FileSpreadsheet className="w-4 h-4 text-[#1E40AF] mt-0.5 shrink-0" />
                                <div>
                                    <div className="font-medium text-[#0F172A]">Рабочий Excel</div>
                                    <div className="text-[11px] text-[#64748B]">Все текущие кейсы с данными</div>
                                </div>
                            </button>
                            <button
                                onClick={() => runExport('template')}
                                className="w-full flex items-start gap-2 px-3 py-2 hover:bg-[#F8FAFC] transition-colors text-left"
                            >
                                <FileText className="w-4 h-4 text-[#64748B] mt-0.5 shrink-0" />
                                <div>
                                    <div className="font-medium text-[#0F172A]">Шаблон для импорта</div>
                                    <div className="text-[11px] text-[#64748B]">Пустой файл со структурой и валидациями</div>
                                </div>
                            </button>
                        </div>
                    )}
                </div>
                <button
                    onClick={handleImportClick}
                    disabled={!!busy}
                    className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-[#E4ECFC] text-[#64748B] text-[12px] font-medium hover:bg-[#F1F5FD] transition-colors disabled:opacity-50"
                    title="Импортировать Excel-файл по шаблону Отток"
                >
                    {busy === 'import' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
                    Импорт
                </button>
                <input
                    ref={fileInputRef}
                    type="file"
                    accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                    onChange={handleFileChosen}
                    className="hidden"
                />
            </div>

            {preview && (
                <ImportPreviewDialog
                    preview={preview}
                    applying={applying}
                    onClose={() => { setPreview(null); setPendingBase64(null) }}
                    onApply={handleApply}
                    onRemap={handleRemap}
                    remapBusy={busy === 'import'}
                />
            )}
        </>
    )
}

// ─── Preview dialog ─────────────────────────────────────────────────

function ImportPreviewDialog({
    preview, applying, onClose, onApply, onRemap, remapBusy,
}: {
    preview: ImportPreviewResult
    applying: boolean
    onClose: () => void
    onApply: () => void
    onRemap: (overrides: Record<string, string>) => void
    remapBusy: boolean
}) {
    // Local editable map: excel letter → contract letter (or '' for ignore)
    const [mapDraft, setMapDraft] = useState<Record<string, string>>(() =>
        Object.fromEntries(
            preview.unmappedHeaders.map(h => [h.letter, h.suggestedColumnLetter ?? '']),
        ),
    )
    const canApply = preview.rowsWithChanges > 0 && !applying

    return (
        <Dialog open={true} onOpenChange={(o) => { if (!o && !applying) onClose() }}>
            <DialogContent className="max-w-3xl max-h-[85vh] overflow-hidden flex flex-col">
                <DialogHeader>
                    <DialogTitle>Импорт Отток — предпросмотр</DialogTitle>
                </DialogHeader>

                <div className="grid grid-cols-4 gap-2 mb-3 text-[12px]">
                    <Stat label="Всего строк" value={preview.totalRows} />
                    <Stat label="Создастся"    value={preview.createRows} tone={preview.createRows > 0 ? 'info' : 'ok'} />
                    <Stat label="Обновится"    value={preview.updateRows} tone={preview.updateRows > 0 ? 'info' : 'ok'} />
                    <Stat label="С ошибками"   value={preview.rowsWithErrors} tone={preview.rowsWithErrors > 0 ? 'warn' : 'ok'} />
                </div>

                {preview.unmappedHeaders.length > 0 && (
                    <div className="mb-3 border border-[#FCD34D] bg-[#FEF3C7] rounded-lg p-3">
                        <div className="text-[13px] font-semibold text-[#92400E] mb-2">
                            Сопоставление колонок ({preview.unmappedHeaders.length})
                        </div>
                        <div className="text-[12px] text-[#78350F] mb-3">
                            Эти колонки из файла не сопоставились автоматически. Укажи, какие поля CRM они означают, либо оставь «— не импортировать».
                        </div>
                        <div className="space-y-1.5">
                            {preview.unmappedHeaders.map(h => (
                                <div key={h.letter} className="flex items-center gap-2 text-[12px]">
                                    <span className="font-mono text-[11px] text-[#78350F] w-10 shrink-0">
                                        {h.letter}
                                    </span>
                                    <span className="flex-1 min-w-0 truncate text-[#0F172A]" title={h.header}>
                                        {h.header}
                                    </span>
                                    <span className="text-[#78350F]">→</span>
                                    <select
                                        value={mapDraft[h.letter] ?? ''}
                                        onChange={(e) => setMapDraft(m => ({ ...m, [h.letter]: e.target.value }))}
                                        className="bg-white border border-[#E4ECFC] rounded-lg px-2 py-1 text-[12px] text-[#0F172A] outline-none focus:border-[#1E40AF] min-w-[220px]"
                                    >
                                        <option value="">— не импортировать</option>
                                        {CHURN_COLUMNS.map(col => (
                                            <option key={col.letter} value={col.letter}>
                                                {col.letter}: {col.header}
                                            </option>
                                        ))}
                                    </select>
                                </div>
                            ))}
                        </div>
                        <div className="flex justify-end mt-3">
                            <button
                                onClick={() => {
                                    const applied: Record<string, string> = {}
                                    for (const [k, v] of Object.entries(mapDraft)) if (v) applied[k] = v
                                    onRemap(applied)
                                }}
                                disabled={remapBusy}
                                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#92400E] text-white text-[12px] font-medium hover:bg-[#78350F] disabled:opacity-50"
                            >
                                {remapBusy && <Loader2 className="w-3 h-3 animate-spin" />}
                                Применить сопоставление
                            </button>
                        </div>
                    </div>
                )}

                <div className="flex-1 overflow-auto border border-[#E4ECFC] rounded-lg">
                    {preview.sampleDiffs.length === 0 ? (
                        <div className="p-6 text-center text-[#64748B] text-[13px]">
                            Изменений не обнаружено. Загруженный файл совпадает с текущим состоянием.
                        </div>
                    ) : (
                        <table className="w-full text-[12px]">
                            <thead className="bg-[#F8FAFC] sticky top-0 z-10">
                                <tr className="text-left">
                                    <th className="px-2 py-1.5 border-b">Строка</th>
                                    <th className="px-2 py-1.5 border-b">ID кейса</th>
                                    <th className="px-2 py-1.5 border-b">Изменения</th>
                                    <th className="px-2 py-1.5 border-b">Ошибки</th>
                                </tr>
                            </thead>
                            <tbody>
                                {preview.sampleDiffs.map((d, i) => (
                                    <tr key={i} className="border-b border-[#EEF2FF] align-top">
                                        <td className="px-2 py-1.5 text-[#64748B]">{d.rowNumber}</td>
                                        <td className="px-2 py-1.5 font-mono text-[11px] text-[#475569]" title={d.taskId}>
                                            {d.taskId.slice(-6)}
                                        </td>
                                        <td className="px-2 py-1.5">
                                            {d.changes.length === 0 ? (
                                                <span className="text-[#94A3B8]">—</span>
                                            ) : (
                                                <ul className="space-y-0.5">
                                                    {d.changes.slice(0, 6).map((c, j) => (
                                                        <li key={j} className="text-[#0F172A]">
                                                            <span className="text-[#64748B]">{c.field}:</span>{' '}
                                                            <span className="line-through text-[#94A3B8]">{formatVal(c.from)}</span>
                                                            {' → '}
                                                            <span className="font-medium">{formatVal(c.to)}</span>
                                                        </li>
                                                    ))}
                                                    {d.changes.length > 6 && (
                                                        <li className="text-[11px] text-[#64748B]">…и ещё {d.changes.length - 6}</li>
                                                    )}
                                                </ul>
                                            )}
                                        </td>
                                        <td className="px-2 py-1.5 text-[#B91C1C]">
                                            {d.errors.join('; ') || '—'}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    )}
                </div>


                <div className="flex justify-end gap-2 mt-3">
                    <button
                        onClick={onClose}
                        disabled={applying}
                        className="px-4 py-1.5 rounded-lg border border-[#E4ECFC] text-[#334155] text-[13px] font-medium hover:bg-[#F8FAFC] disabled:opacity-50"
                    >
                        Отмена
                    </button>
                    <button
                        onClick={onApply}
                        disabled={!canApply}
                        className="px-4 py-1.5 rounded-lg bg-[#4f46e5] text-white text-[13px] font-semibold hover:bg-[#4338ca] disabled:opacity-40 flex items-center gap-1.5"
                    >
                        {applying && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                        Применить{preview.rowsWithChanges > 0 ? ` (${preview.rowsWithChanges})` : ''}
                    </button>
                </div>
            </DialogContent>
        </Dialog>
    )
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: 'ok' | 'warn' | 'info' }) {
    const color =
        tone === 'ok'   ? 'text-[#166534]' :
        tone === 'warn' ? 'text-[#B91C1C]' :
        tone === 'info' ? 'text-[#1E40AF]' :
                          'text-[#0F172A]'
    return (
        <div className="bg-[#F8FAFC] border border-[#E4ECFC] rounded-lg px-3 py-2">
            <div className="text-[#64748B] text-[11px]">{label}</div>
            <div className={`text-[18px] font-semibold ${color}`}>{value}</div>
        </div>
    )
}

function formatVal(v: unknown): string {
    if (v === null || v === undefined) return '—'
    if (v instanceof Date) return v.toISOString().slice(0, 10)
    if (typeof v === 'object') return JSON.stringify(v).slice(0, 60)
    const s = String(v)
    return s.length > 60 ? s.slice(0, 57) + '…' : s
}

// ─── Helpers ─────────────────────────────────────────────────────────

function arrayBufferToBase64(buf: ArrayBuffer): string {
    const bytes = new Uint8Array(buf)
    let bin = ''
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
    return btoa(bin)
}

function downloadBlob(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = filename
    document.body.appendChild(a); a.click(); document.body.removeChild(a)
    setTimeout(() => URL.revokeObjectURL(url), 1000)
}
