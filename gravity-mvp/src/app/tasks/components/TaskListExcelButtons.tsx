'use client'

// ═══════════════════════════════════════════════════════════════════
// TaskListExcelButtons — Export (works) + Import (preview only).
//
// Export: builds a CSV of the currently filtered task list, using the
// active churn layout's visible columns in on-screen order. Headers
// use the stable exportKey (not the Russian label) — this is the
// contract for the future import pipeline.
//
// Import: opens a file picker, parses CSV in the browser, and shows
// a preview dialog with row count + the first rows. Actual apply
// (match + diff + write) is intentionally out of scope for this stage.
// ═══════════════════════════════════════════════════════════════════

import { useRef, useState } from 'react'
import { Upload, Download } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { pushToast } from '@/lib/tasks/toast-store'
import { recordUsage } from '@/lib/tasks/usage'
import { useFilteredTasks } from '@/store/tasks-selectors'
import { useListViewStore } from '@/store/list-view-store'
import { getSystemView, getDefaultViewId } from '@/lib/tasks/list-views'
import { resolveLayout } from '@/lib/tasks/list-columns'
import { exportTasksToCsv, downloadBlob } from '@/lib/tasks/csv-export'

interface ParsedCsv {
    filename: string
    size: number
    headers: string[]
    rows: string[][]
}

export default function TaskListExcelButtons() {
    const tasks = useFilteredTasks()
    const activeMap = useListViewStore(s => s.activeViewIdByScenario)
    const overridesByViewId = useListViewStore(s => s.overridesByViewId)

    const fileInputRef = useRef<HTMLInputElement>(null)
    const [importPreview, setImportPreview] = useState<ParsedCsv | null>(null)

    const handleExport = () => {
        void recordUsage('excel_click', { kind: 'export' })
        try {
            const activeId = activeMap['churn'] ?? getDefaultViewId('churn')
            const view = getSystemView(activeId) ?? getSystemView(getDefaultViewId('churn'))
            if (!view) {
                pushToast('Нет активного представления', 'error')
                return
            }
            const layout = resolveLayout(view, overridesByViewId[view.id])
            const result = exportTasksToCsv(tasks, layout)
            downloadBlob(result.blob, result.filename)
            pushToast(`Экспортировано ${result.rowCount} задач · ${result.columnCount} колонок`, 'success')
        } catch (e) {
            pushToast('Ошибка экспорта: ' + (e as Error).message, 'error')
        }
    }

    const handleImportClick = () => {
        void recordUsage('excel_click', { kind: 'import' })
        fileInputRef.current?.click()
    }

    const handleFileChosen: React.ChangeEventHandler<HTMLInputElement> = async (e) => {
        const file = e.target.files?.[0]
        e.target.value = '' // allow same-file re-selection
        if (!file) return
        try {
            const text = await file.text()
            const parsed = parseCsv(text)
            setImportPreview({
                filename: file.name,
                size: file.size,
                headers: parsed.headers,
                rows: parsed.rows,
            })
        } catch (err) {
            pushToast('Не удалось прочитать файл: ' + (err as Error).message, 'error')
        }
    }

    return (
        <>
            <div className="flex items-center gap-1">
                <button
                    onClick={handleExport}
                    className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-[#E4ECFC] text-[#64748B] text-[12px] font-medium hover:bg-[#F1F5FD] transition-colors"
                    title="Экспортировать текущий список в CSV"
                >
                    <Download className="w-3.5 h-3.5" />
                    Экспорт
                </button>
                <button
                    onClick={handleImportClick}
                    className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-[#E4ECFC] text-[#64748B] text-[12px] font-medium hover:bg-[#F1F5FD] transition-colors"
                    title="Импортировать CSV-файл (предпросмотр)"
                >
                    <Upload className="w-3.5 h-3.5" />
                    Импорт
                </button>
                <input
                    ref={fileInputRef}
                    type="file"
                    accept=".csv,text/csv"
                    onChange={handleFileChosen}
                    className="hidden"
                />
            </div>

            {importPreview && (
                <ImportPreviewDialog
                    preview={importPreview}
                    onClose={() => setImportPreview(null)}
                />
            )}
        </>
    )
}

// ─── Import preview ──────────────────────────────────────────────────

function ImportPreviewDialog({
    preview,
    onClose,
}: {
    preview: ParsedCsv
    onClose: () => void
}) {
    return (
        <Dialog open={true} onOpenChange={(o) => { if (!o) onClose() }}>
            <DialogContent className="max-w-3xl max-h-[80vh] overflow-hidden flex flex-col">
                <DialogHeader>
                    <DialogTitle>Импорт CSV — предпросмотр</DialogTitle>
                </DialogHeader>

                <div className="text-[13px] text-[#0F172A] mb-3 space-y-0.5">
                    <div><span className="text-[#64748B]">Файл:</span> {preview.filename}</div>
                    <div><span className="text-[#64748B]">Размер:</span> {(preview.size / 1024).toFixed(1)} KB</div>
                    <div><span className="text-[#64748B]">Колонок:</span> {preview.headers.length}</div>
                    <div><span className="text-[#64748B]">Строк:</span> {preview.rows.length}</div>
                </div>

                <div className="overflow-auto border border-[#E4ECFC] rounded-lg flex-1">
                    <table className="w-full text-[12px]">
                        <thead className="bg-[#F8FAFC] sticky top-0">
                            <tr>
                                {preview.headers.map((h, i) => (
                                    <th key={i} className="px-2 py-1.5 text-left font-semibold text-[#475569] border-b border-[#E4ECFC] whitespace-nowrap">
                                        {h}
                                    </th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {preview.rows.slice(0, 50).map((row, ri) => (
                                <tr key={ri} className="border-b border-[#EEF2FF]">
                                    {row.map((cell, ci) => (
                                        <td key={ci} className="px-2 py-1 text-[#0F172A] whitespace-nowrap max-w-[200px] truncate" title={cell}>
                                            {cell || '—'}
                                        </td>
                                    ))}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>

                <div className="mt-3 text-[12px] text-[#64748B] bg-[#FEF3C7] border border-[#FCD34D] rounded-lg p-2.5">
                    <strong className="text-[#92400E]">Применение изменений ещё не реализовано.</strong>
                    {' '}Это предпросмотр содержимого файла. Чтобы данные попали в задачи, нужна следующая фаза:
                    матчинг по ключу, preview-diff и conflict detection.
                </div>

                <div className="flex justify-end gap-2 mt-3">
                    <button
                        onClick={onClose}
                        className="px-4 py-1.5 rounded-lg border border-[#E4ECFC] text-[#334155] text-[13px] font-medium hover:bg-[#F8FAFC]"
                    >
                        Закрыть
                    </button>
                </div>
            </DialogContent>
        </Dialog>
    )
}

// ─── Minimal CSV parser ──────────────────────────────────────────────

function parseCsv(text: string): { headers: string[]; rows: string[][] } {
    // Strip BOM
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1)

    // Detect separator: semicolon wins if it appears in the first line
    // before any comma; otherwise comma. Tabs supported as fallback.
    const firstLine = text.split(/\r?\n/, 1)[0] ?? ''
    const sep = firstLine.includes(';') ? ';' : firstLine.includes('\t') ? '\t' : ','

    const rows: string[][] = []
    let cur: string[] = []
    let field = ''
    let inQuotes = false
    const flushField = () => { cur.push(field); field = '' }

    for (let i = 0; i < text.length; i++) {
        const c = text[i]
        if (inQuotes) {
            if (c === '"') {
                if (text[i + 1] === '"') { field += '"'; i++ }
                else inQuotes = false
            } else field += c
        } else {
            if (c === '"') inQuotes = true
            else if (c === sep) flushField()
            else if (c === '\r') { /* ignore, let \n handle */ }
            else if (c === '\n') {
                cur.push(field); field = ''
                rows.push(cur); cur = []
            } else field += c
        }
    }
    if (field.length > 0 || cur.length > 0) {
        cur.push(field)
        rows.push(cur)
    }

    const headers = rows.shift() ?? []
    return { headers, rows }
}
