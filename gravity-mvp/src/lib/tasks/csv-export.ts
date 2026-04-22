// ═══════════════════════════════════════════════════════════════════
// CSV export for the churn tasks list.
//
// Output contract:
//   • UTF-8 with BOM (so Excel detects encoding)
//   • CRLF line endings
//   • Semicolon separator (Russian Excel locale default; comma in values
//     survives without escaping pressure)
//   • Headers use exportKey (stable — contract with future import)
//   • Row order = visible order on screen
//   • Values normalized: null → ''; boolean → Да/Нет; Date → ISO;
//     object → JSON; other → String().
// ═══════════════════════════════════════════════════════════════════

import type { TaskDTO } from '@/lib/tasks/types'
import type { ResolvedLayout, ResolvedColumn } from '@/lib/tasks/list-schema'
import { getValue as rendererGetValue } from '@/lib/tasks/list-renderers'

const BOM = '\uFEFF'
const EOL = '\r\n'
const SEP = ';'

export interface CsvExportResult {
    filename: string
    blob: Blob
    rowCount: number
    columnCount: number
}

export function exportTasksToCsv(
    tasks: TaskDTO[],
    layout: ResolvedLayout,
    opts?: { filenamePrefix?: string },
): CsvExportResult {
    // Collect visible columns in render order, skipping fullName from blocks
    // because it's a sticky-zone column — we always prepend it explicitly.
    const columns: ResolvedColumn[] = []
    const seen = new Set<string>()
    const fullName = layout.blocks
        .flatMap(b => b.visibleColumns)
        .find(c => c.id === 'fullName')
    if (fullName) {
        columns.push(fullName)
        seen.add(fullName.id)
    }
    for (const block of layout.blocks) {
        for (const col of block.visibleColumns) {
            if (seen.has(col.id)) continue
            seen.add(col.id)
            columns.push(col)
        }
    }

    const header = columns.map(c => escapeCell(c.exportKey))
    const rows: string[] = [header.join(SEP)]
    for (const task of tasks) {
        const cells = columns.map(c => escapeCell(serialize(getValue(task, c))))
        rows.push(cells.join(SEP))
    }

    const csv = BOM + rows.join(EOL) + EOL
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })

    const stamp = new Date().toISOString().slice(0, 10)
    const prefix = opts?.filenamePrefix ?? 'tasks_churn'
    return {
        filename: `${prefix}_${stamp}.csv`,
        blob,
        rowCount: tasks.length,
        columnCount: columns.length,
    }
}

// ─── Helpers ─────────────────────────────────────────────────────────

function getValue(task: TaskDTO, col: ResolvedColumn): unknown {
    try {
        return rendererGetValue(task, col)
    } catch {
        return null
    }
}

function serialize(v: unknown): string {
    if (v === null || v === undefined) return ''
    if (typeof v === 'boolean') return v ? 'Да' : 'Нет'
    if (typeof v === 'string') return v
    if (typeof v === 'number') return String(v)
    if (v instanceof Date) return v.toISOString()
    if (typeof v === 'object') {
        // TaskDTO offerAllowed etc. — flatten to readable string
        try {
            const obj = v as Record<string, unknown>
            if ('verdict' in obj) {
                const verdict = obj.verdict as string
                const reason = obj.reason ? ` (${String(obj.reason)})` : ''
                return `${verdict}${reason}`
            }
            return JSON.stringify(v)
        } catch {
            return ''
        }
    }
    return String(v)
}

function escapeCell(s: string): string {
    // CSV rule: if contains separator, quote, CR, LF — wrap in quotes & escape " → ""
    if (s === '') return ''
    const needsQuote = s.includes(SEP) || s.includes('"') || s.includes('\n') || s.includes('\r')
    if (!needsQuote) return s
    return `"${s.replace(/"/g, '""')}"`
}

// ─── Browser download helper ────────────────────────────────────────

export function downloadBlob(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    // Revoke on the next tick so the browser has time to start the download
    setTimeout(() => URL.revokeObjectURL(url), 1000)
}
