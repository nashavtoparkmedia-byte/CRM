// ═══════════════════════════════════════════════════════════════════
// Excel ⇄ CRM contract for the Отток (churn) scenario.
//
// One source of truth for:
//   • Excel column layout (letter → header → internal field)
//   • export direction   (internal value → cell value)
//   • import direction   (cell value → patch payload)
//   • which fields are editable on import
//
// Used by:
//   - server actions:  export-churn-xlsx.ts, import-churn-xlsx.ts
//   - client UI:       TaskListExcelButtons preview dialog
//   - CLI/one-off:     data migrations that must stay in sync
//
// DO NOT change column LETTERS or exportKey labels once data is in —
// they are the contract that users see in their files.
// ═══════════════════════════════════════════════════════════════════

import type { TaskDTO } from '@/lib/tasks/types'
import type { ScenarioData } from '@/lib/tasks/scenario-config'

// ─── Row addresses in the template ──────────────────────────────────
export const TEMPLATE_SHEET_NAME = 'Отток_шаблон'
export const HEADER_ROW = 3                  // column headers, row 3
export const FIRST_DATA_ROW = 4              // data starts at row 4

// ─── Reference lists (match «Справочники» sheet) ────────────────────

/** Project — only valid value for churn export. */
export const REF_PROJECT = 'Отток'

/** Excel enum for "Этап воронки". Maps to internal stage id. */
export const STAGE_LABEL_BY_ID: Record<string, string> = {
    detected: 'Обнаружен',
    contacting: 'Связываемся',
    reason_collected: 'Причина собрана',
    offer_made: 'Предложение сделано',
    waiting_return: 'Ждём возврата',
    control: 'Контроль',
    returned: 'Вернулся',
    lost: 'Потерян',
}
export const STAGE_ID_BY_LABEL: Record<string, string> = Object.fromEntries(
    Object.entries(STAGE_LABEL_BY_ID).map(([k, v]) => [v, k]),
)

/** Excel enum for "Итог закрытия". Maps to internal closedReason. */
export const CLOSE_RESULT_LABEL_BY_ID: Record<string, string> = {
    returned: 'Вернулся',
    lost: 'Потерян',
    other_park: 'Ушёл в другой парк',
    irrelevant: 'Неактуально',
}
export const CLOSE_RESULT_ID_BY_LABEL: Record<string, string> = Object.fromEntries(
    Object.entries(CLOSE_RESULT_LABEL_BY_ID).map(([k, v]) => [v, k]),
)

/** Excel enum for "Катает в Яндекс?" (boolean mapping). */
export const YANDEX_ACTIVE_LABELS = { yes: 'да', no: 'нет' }

/** Excel enum for "Можно давать акцию?" (tri-state → ДА/НЕТ/empty). */
export const OFFER_ALLOWED_LABELS = { yes: 'ДА', no: 'НЕТ' }

// ─── Epoch-date guard ────────────────────────────────────────────────
// Any timestamp older than 2010 is treated as "no value" (usually a
// leftover from old seed/import that wrote Unix epoch 0). DO NOT
// render it as a date in the workbook.
const EPOCH_GUARD = new Date('2010-01-01T00:00:00Z').getTime()

export function isRealDate(iso: string | null | undefined): boolean {
    if (!iso) return false
    const t = new Date(iso).getTime()
    return Number.isFinite(t) && t >= EPOCH_GUARD
}

// ─── Column definitions ──────────────────────────────────────────────

export type ExcelEditMode = 'KEY' | 'DERIVED' | 'LOOKUP' | 'YES'
export type ExcelBlockId =
    | 'identification' | 'case_mgmt' | 'context' | 'manager_work' | 'offer' | 'closing'

export interface ExcelColumnDef {
    /** Spreadsheet column letter (A..W). Stable contract. */
    letter: string
    /** Russian header, exactly as it appears in the template row 3. */
    header: string
    /** Which top-level block this column belongs to. */
    block: ExcelBlockId
    /** Edit policy for this column on import. */
    edit: ExcelEditMode

    /**
     * Date-only column. Numeric toExcel output is interpreted as an
     * Excel serial number and the cell is formatted as 'yyyy-mm-dd'.
     * Without this flag a number would be written as a raw number.
     */
    isDate?: boolean

    /** Extract the Excel value from a TaskDTO (used on export). */
    toExcel: (task: TaskDTO) => string | number | Date | null

    /**
     * Convert a raw Excel cell value into a patch fragment on import.
     * Returns { task?, scenarioData? } — whichever layer the field
     * lives on. Return null to skip (empty cell, unchanged).
     * Only meaningful when edit === 'YES' or 'LOOKUP'.
     */
    fromExcel?: (raw: unknown) => ImportPatch | null
}

export interface ImportPatch {
    task?: Record<string, unknown>
    scenarioData?: Record<string, unknown>
}

// ─── Helpers ─────────────────────────────────────────────────────────

function str(v: unknown): string | null {
    if (v === null || v === undefined) return null
    const s = String(v).trim()
    return s === '' ? null : s
}

function sd(task: TaskDTO, key: string): unknown {
    // Prefer the rich scenarioData map (server sends it on DetailDTO).
    const data = (task as unknown as { scenarioData?: ScenarioData | Record<string, { value: unknown }> }).scenarioData
    const entry = (data as Record<string, unknown> | undefined)?.[key]
    if (entry && typeof entry === 'object' && 'value' in entry) {
        return (entry as { value: unknown }).value
    }
    // Fallback: list-view preview array
    const preview = task.scenarioFieldsPreview?.find(f => f.fieldId === key)
    return preview?.value
}

/**
 * For date-only Excel cells we emit the Excel serial number directly
 * (days since 1899-12-30). This is TZ-free — Excel interprets it as
 * the raw calendar day regardless of the viewer's timezone.
 *
 * Passing a JS Date to ExcelJS converts via Date.getTime() (UTC epoch
 * ms), so a local-midnight Date in MSK (UTC+5) becomes serial=day-0.79
 * and Excel shows the previous day at 19:00. Using the serial number
 * bypasses the whole TZ conversion layer.
 */
const EXCEL_EPOCH_UTC = Date.UTC(1899, 11, 30)

function dateOrEmpty(iso: string | null | undefined): number | null {
    if (!isRealDate(iso)) return null
    const d = new Date(iso!)
    // Stored value is UTC-midnight of the target calendar day
    // (parseDateOnlyUTC on import builds it this way).
    const utc = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
    return (utc - EXCEL_EPOCH_UTC) / 86400000
}

/**
 * Parse a "YYYY-MM-DD" (optionally with trailing " HH:MM:SS") or a JS Date
 * into a UTC-midnight Date for that calendar day. No TZ guessing.
 */
function parseDateOnlyUTC(raw: unknown): Date | null {
    if (raw === null || raw === undefined || raw === '') return null
    let y: number, mo: number, d: number
    if (raw instanceof Date) {
        // SheetJS produces Date at local midnight of that Y/M/D — take
        // its local components, not the UTC ones (which would shift).
        if (Number.isNaN(raw.getTime())) return null
        y = raw.getFullYear(); mo = raw.getMonth(); d = raw.getDate()
    } else {
        const s = String(raw).trim()
        const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s)
        if (!m) return null
        y = +m[1]; mo = +m[2] - 1; d = +m[3]
    }
    const utc = Date.UTC(y, mo, d)
    if (!Number.isFinite(utc)) return null
    const out = new Date(utc)
    return out.getTime() >= new Date('2010-01-01T00:00:00Z').getTime() ? out : null
}

// ─── THE CONTRACT ────────────────────────────────────────────────────

export const CHURN_COLUMNS: ExcelColumnDef[] = [
    // ─── Идентификация ──────────────────────────────────
    {
        letter: 'A', header: 'ID кейса', block: 'identification', edit: 'KEY',
        toExcel: t => t.id,
    },
    {
        letter: 'B', header: 'ФИО водителя', block: 'identification', edit: 'DERIVED',
        toExcel: t => t.driverName ?? '',
    },
    {
        letter: 'C', header: 'Номер ВУ', block: 'identification', edit: 'DERIVED',
        toExcel: t => (sd(t, 'licenseNumber') as string) ?? '',
    },

    // ─── Управление кейсом ───────────────────────────────
    {
        letter: 'D', header: 'Проект', block: 'case_mgmt', edit: 'DERIVED',
        toExcel: () => REF_PROJECT,
    },
    {
        letter: 'E', header: 'Менеджер', block: 'case_mgmt', edit: 'LOOKUP',
        toExcel: t => t.assignee?.name ?? '',
        fromExcel: raw => {
            const name = str(raw)
            return name === null
                ? null
                : { task: { __assigneeName: name } } // resolved on server to assigneeId
        },
    },
    {
        letter: 'F', header: 'Этап воронки', block: 'case_mgmt', edit: 'YES',
        toExcel: t => (t.stage ? STAGE_LABEL_BY_ID[t.stage] ?? t.stage : ''),
        fromExcel: raw => {
            const label = str(raw)
            if (label === null) return null
            const id = STAGE_ID_BY_LABEL[label]
            if (!id) return null
            return { task: { stage: id } }
        },
    },

    // ─── Контекст водителя ───────────────────────────────
    {
        letter: 'G', header: 'Катает в Яндекс?', block: 'context', edit: 'YES',
        toExcel: t => {
            const v = sd(t, 'yandexActive')
            if (v === true) return YANDEX_ACTIVE_LABELS.yes
            if (v === false) return YANDEX_ACTIVE_LABELS.no
            return ''
        },
        fromExcel: raw => {
            const s = str(raw)?.toLowerCase() ?? null
            if (s === null) return null
            if (s === YANDEX_ACTIVE_LABELS.yes) return { scenarioData: { yandexActive: true } }
            if (s === YANDEX_ACTIVE_LABELS.no)  return { scenarioData: { yandexActive: false } }
            return null
        },
    },
    {
        letter: 'H', header: 'Какой парк?', block: 'context', edit: 'YES',
        toExcel: t => (sd(t, 'externalParkName') as string) ?? '',
        fromExcel: raw => {
            const s = str(raw); if (s === null) return null
            return { scenarioData: { externalParkName: s } }
        },
    },
    {
        letter: 'I', header: 'Сколько поездок в среднем по данным Яндекс', block: 'context', edit: 'YES',
        toExcel: t => {
            const v = sd(t, 'yandexTripsCount')
            if (v === null || v === undefined) return ''
            return typeof v === 'number' ? v : String(v)
        },
        fromExcel: raw => {
            if (raw === null || raw === undefined || raw === '') return null
            // Template stores "700-800", "давно не работал" — keep as string
            return { scenarioData: { yandexTripsCount: typeof raw === 'number' ? raw : String(raw) } }
        },
    },

    // ─── Работа менеджера ────────────────────────────────
    {
        letter: 'J', header: 'Причина оттока', block: 'manager_work', edit: 'YES',
        toExcel: t => {
            const v = sd(t, 'churnReason')
            return v ? String(v) : ''
        },
        fromExcel: raw => {
            const s = str(raw); if (s === null) return null
            return { scenarioData: { churnReason: s } }
        },
    },
    {
        letter: 'K', header: 'Статус по смыслу', block: 'manager_work', edit: 'YES',
        toExcel: t => (sd(t, 'semanticStatus') as string) ?? '',
        fromExcel: raw => {
            const s = str(raw); if (s === null) return null
            return { scenarioData: { semanticStatus: s } }
        },
    },
    {
        // L is editable: the file round-trip must preserve the date.
        // On export prefer the manual override (scenarioData.lastContactDate),
        // fall back to the derived TaskEvent-based value.
        letter: 'L', header: 'Дата последнего контакта', block: 'manager_work', edit: 'YES', isDate: true,
        toExcel: t => {
            const override = sd(t, 'lastContactDate')
            if (override) {
                const d = new Date(String(override))
                if (Number.isFinite(d.getTime()) && d.getTime() >= new Date('2010-01-01').getTime()) return d
            }
            return dateOrEmpty(t.lastContactAt)
        },
        fromExcel: raw => {
            const d = parseDateOnlyUTC(raw)
            if (!d) return null
            return { scenarioData: { lastContactDate: d.toISOString() } }
        },
    },
    {
        letter: 'M', header: 'Итог последнего контакта', block: 'manager_work', edit: 'YES',
        toExcel: t => (sd(t, 'lastContactResult') as string) ?? '',
        fromExcel: raw => {
            const s = str(raw); if (s === null) return null
            return { scenarioData: { lastContactResult: s } }
        },
    },
    {
        letter: 'N', header: 'Что сделать сейчас', block: 'manager_work', edit: 'YES',
        toExcel: t => t.title ?? '',
        fromExcel: raw => {
            const s = str(raw); if (s === null) return null
            return { task: { title: s } }
        },
    },
    {
        letter: 'O', header: 'Дедлайн следующего действия', block: 'manager_work', edit: 'YES', isDate: true,
        toExcel: t => dateOrEmpty(t.nextActionAt),
        fromExcel: raw => {
            const d = parseDateOnlyUTC(raw)
            if (!d) return null
            const iso = d.toISOString()
            return { task: { nextActionAt: iso, dueAt: iso } }
        },
    },

    // ─── Оффер и правила ─────────────────────────────────
    {
        letter: 'P', header: 'Что написать водителю (готовый текст)', block: 'offer', edit: 'YES',
        toExcel: t => (sd(t, 'messageTemplate') as string) ?? '',
        fromExcel: raw => {
            const s = str(raw); if (s === null) return null
            return { scenarioData: { messageTemplate: s } }
        },
    },
    {
        letter: 'Q', header: 'Оффер менеджеру', block: 'offer', edit: 'YES',
        toExcel: t => (sd(t, 'offerType') as string) ?? '',
        fromExcel: raw => {
            const s = str(raw); if (s === null) return null
            return { scenarioData: { offerType: s } }
        },
    },
    {
        // R is editable: the manager's final verdict on the offer. On
        // import it writes scenarioData.offerAllowedOverride, which
        // resolveOfferAllowed() already respects (see offer-rules.ts).
        // Computed verdict stays derived — export reads the resolved
        // value (override if set, else computed).
        letter: 'R', header: 'Можно давать акцию?', block: 'offer', edit: 'YES',
        toExcel: t => {
            const v = t.offerAllowed?.verdict
            if (v === 'yes') return OFFER_ALLOWED_LABELS.yes
            if (v === 'no')  return OFFER_ALLOWED_LABELS.no
            return ''
        },
        fromExcel: raw => {
            const s = str(raw); if (s === null) return null
            const u = s.toUpperCase()
            if (u === 'ДА')  return { scenarioData: { offerAllowedOverride: 'yes' } }
            if (u === 'НЕТ') return { scenarioData: { offerAllowedOverride: 'no' } }
            return null
        },
    },
    {
        // S is editable: manager explains why. Stored as
        // scenarioData.offerOverrideReason (used by resolveOfferAllowed).
        letter: 'S', header: 'Почему даем / не даем оффер', block: 'offer', edit: 'YES',
        toExcel: t => t.offerAllowed?.reason ?? '',
        fromExcel: raw => {
            const s = str(raw); if (s === null) return null
            return { scenarioData: { offerOverrideReason: s } }
        },
    },

    // ─── Закрытие ────────────────────────────────────────
    {
        letter: 'T', header: 'Приоритет / статус возврата', block: 'closing', edit: 'YES',
        toExcel: t => (sd(t, 'returnPriority') as string) ?? '',
        fromExcel: raw => {
            const s = str(raw); if (s === null) return null
            return { scenarioData: { returnPriority: s } }
        },
    },
    {
        letter: 'U', header: 'Результат контакта', block: 'closing', edit: 'YES',
        toExcel: t => (sd(t, 'contactResult') as string) ?? '',
        fromExcel: raw => {
            const s = str(raw); if (s === null) return null
            return { scenarioData: { contactResult: s } }
        },
    },
    {
        letter: 'V', header: 'Дата закрытия', block: 'closing', edit: 'YES', isDate: true,
        toExcel: t => dateOrEmpty(t.resolvedAt),
        fromExcel: raw => {
            const d = parseDateOnlyUTC(raw)
            if (!d) return null
            return { task: { resolvedAt: d.toISOString() } }
        },
    },
    {
        letter: 'W', header: 'Итог закрытия', block: 'closing', edit: 'YES',
        toExcel: t => {
            if (!t.closedReason) return ''
            return CLOSE_RESULT_LABEL_BY_ID[t.closedReason] ?? t.closedReason
        },
        fromExcel: raw => {
            const label = str(raw); if (label === null) return null
            const id = CLOSE_RESULT_ID_BY_LABEL[label]
            if (!id) return null
            return { task: { closedReason: id } }
        },
    },
]

export const CHURN_COLUMN_BY_LETTER: Record<string, ExcelColumnDef> =
    Object.fromEntries(CHURN_COLUMNS.map(c => [c.letter, c]))

export const CHURN_COLUMN_BY_HEADER: Record<string, ExcelColumnDef> =
    Object.fromEntries(CHURN_COLUMNS.map(c => [c.header, c]))
