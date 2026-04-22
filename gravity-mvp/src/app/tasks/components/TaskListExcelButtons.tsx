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

import { useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Upload, Download, Loader2 } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { pushToast } from '@/lib/tasks/toast-store'
import { recordUsage } from '@/lib/tasks/usage'
import { useTasksStore } from '@/store/tasks-store'
import {
    exportChurnXlsx,
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
    const [preview, setPreview] = useState<ImportPreviewResult | null>(null)
    const [applying, setApplying] = useState(false)

    const handleExport = async () => {
        if (busy) return
        setBusy('export')
        void recordUsage('excel_click', { kind: 'export' })
        try {
            const result = await exportChurnXlsx(filters, sort)
            const bytes = Uint8Array.from(atob(result.base64), c => c.charCodeAt(0))
            const blob = new Blob([bytes], {
                type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            })
            downloadBlob(blob, result.filename)
            pushToast(`Экспортировано ${result.rowCount} кейсов`, 'success')
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
            setPreview(result)
        } catch (err) {
            pushToast('Не удалось прочитать файл: ' + (err as Error).message, 'error')
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
                pushToast(`Обновлено ${res.applied} кейсов`, 'success')
            } else {
                pushToast(`Обновлено ${res.applied}, ошибок: ${res.errors.length}`, 'error')
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
                <button
                    onClick={handleExport}
                    disabled={!!busy}
                    className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-[#E4ECFC] text-[#64748B] text-[12px] font-medium hover:bg-[#F1F5FD] transition-colors disabled:opacity-50"
                    title="Экспортировать в Excel по шаблону Отток"
                >
                    {busy === 'export' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
                    Экспорт
                </button>
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
                    onClose={() => setPreview(null)}
                    onApply={handleApply}
                />
            )}
        </>
    )
}

// ─── Preview dialog ─────────────────────────────────────────────────

function ImportPreviewDialog({
    preview, applying, onClose, onApply,
}: {
    preview: ImportPreviewResult
    applying: boolean
    onClose: () => void
    onApply: () => void
}) {
    const canApply = preview.rowsWithChanges > 0 && !applying
    return (
        <Dialog open={true} onOpenChange={(o) => { if (!o && !applying) onClose() }}>
            <DialogContent className="max-w-3xl max-h-[85vh] overflow-hidden flex flex-col">
                <DialogHeader>
                    <DialogTitle>Импорт Отток — предпросмотр</DialogTitle>
                </DialogHeader>

                <div className="grid grid-cols-4 gap-2 mb-3 text-[12px]">
                    <Stat label="Всего строк"     value={preview.totalRows} />
                    <Stat label="Совпали"         value={preview.matchedRows} tone="ok" />
                    <Stat label="С изменениями"   value={preview.rowsWithChanges} tone="info" />
                    <Stat label="С ошибками"      value={preview.rowsWithErrors} tone={preview.rowsWithErrors > 0 ? 'warn' : 'ok'} />
                </div>

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

                {preview.unmatchedRows > 0 && (
                    <div className="mt-3 text-[12px] text-[#92400E] bg-[#FEF3C7] border border-[#FCD34D] rounded-lg p-2">
                        Не сопоставлены {preview.unmatchedRows} строк — проверь «ID кейса» в колонке A.
                    </div>
                )}

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
