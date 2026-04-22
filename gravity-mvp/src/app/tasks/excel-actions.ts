'use server'

// ═══════════════════════════════════════════════════════════════════
// Excel import/export server actions for the Отток (churn) list.
//
// Built on exceljs — it preserves everything SheetJS CE drops on write:
// cell styles, merged cells, data-validations (dropdown lists), column
// widths, fills.
//
// Flow:
//   Export:       template → clone → append rows → serialize → base64
//   Import (2-step):
//     • previewChurnImport  — parse, compute diff vs DB, no writes
//     • applyChurnImport    — apply payload token to editable fields
// ═══════════════════════════════════════════════════════════════════

import ExcelJS from 'exceljs'
import * as XLSX from 'xlsx'
import JSZip from 'jszip'
import { prisma } from '@/lib/prisma'
import {
    CHURN_COLUMNS,
    CHURN_COLUMN_BY_LETTER,
    CHURN_COLUMN_BY_HEADER,
    TEMPLATE_SHEET_NAME,
    HEADER_ROW,
    FIRST_DATA_ROW,
    type ImportPatch,
} from '@/lib/tasks/excel-contract'
import { getTasks } from './actions'
import type { TaskFilters, TaskSort, TaskDTO } from '@/lib/tasks/types'

// Stale Prisma Client DLL (locked by parallel dev) doesn't know
// about the `scenarioData` column on Task. Schema + DB do. We read
// / write that column via raw SQL to bypass the outdated generated
// types and keep the rest of the code using regular Prisma queries.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const task$ = prisma.task as unknown as any

// Replace XML numeric entities for non-BMP code points (e.g. &#128081;
// for 👑) with the actual UTF-8 character. Workaround for a SheetJS CE
// bug that uses String.fromCharCode on the raw integer → low 16 bits →
// PUA garbage.
async function sanitizeXlsxBuffer(buf: Buffer): Promise<Buffer> {
    try {
        const zip = await JSZip.loadAsync(buf)
        const names = Object.keys(zip.files)
        for (const name of names) {
            if (!/\.(xml|rels)$/i.test(name)) continue
            const entry = zip.file(name)
            if (!entry) continue
            let xml = await entry.async('string')
            const decimal = xml.replace(/&#(\d+);/g, (m, n: string) => {
                const cp = parseInt(n, 10)
                return cp > 0xFFFF ? String.fromCodePoint(cp) : m
            })
            const hex = decimal.replace(/&#x([0-9a-fA-F]+);/g, (m, h: string) => {
                const cp = parseInt(h, 16)
                return cp > 0xFFFF ? String.fromCodePoint(cp) : m
            })
            if (hex !== xml) zip.file(name, hex)
        }
        return await zip.generateAsync({ type: 'nodebuffer' })
    } catch {
        // On any zip-level failure fall through — XLSX.read will raise a
        // cleaner error than we could.
        return buf
    }
}

async function readScenarioDataMap(ids: string[]): Promise<Map<string, Record<string, { value: unknown }>>> {
    if (ids.length === 0) return new Map()
    const rows = await prisma.$queryRawUnsafe<Array<{ id: string; scenarioData: Record<string, unknown> | null }>>(
        `SELECT "id", "scenarioData" FROM "tasks" WHERE "id" = ANY($1::text[])`,
        ids,
    )
    const m = new Map<string, Record<string, { value: unknown }>>()
    for (const r of rows) m.set(r.id, (r.scenarioData ?? {}) as Record<string, { value: unknown }>)
    return m
}

async function writeScenarioData(taskId: string, data: Record<string, unknown>): Promise<void> {
    await prisma.$executeRawUnsafe(
        `UPDATE "tasks" SET "scenarioData" = $1::jsonb, "updatedAt" = NOW() WHERE "id" = $2`,
        JSON.stringify(data),
        taskId,
    )
}

// ─── Workbook skeleton builder ───────────────────────────────────────
//
// We build the workbook from scratch rather than clone the reference
// xlsx because exceljs 4.4 throws on load() of some legacy files (a
// known comments-relation bug). Building fresh every export guarantees
// the file is always well-formed and round-trips through exceljs.

const BLOCK_HEADERS: Array<{ title: string; from: string; to: string; fill: string }> = [
    { title: 'Идентификация',     from: 'A', to: 'C', fill: 'FFF3F4F6' },
    { title: 'Управление кейсом', from: 'D', to: 'F', fill: 'FFEDE9FE' },
    { title: 'Контекст водителя', from: 'G', to: 'I', fill: 'FFEAF2FF' },
    { title: 'Работа менеджера',  from: 'J', to: 'O', fill: 'FFFFF4CC' },
    { title: 'Оффер и правила',   from: 'P', to: 'S', fill: 'FFE8F5E9' },
    { title: 'Закрытие',          from: 'T', to: 'W', fill: 'FFFDECEA' },
]

const COLUMN_WIDTHS: Record<string, number> = {
    A: 14, B: 30, C: 14, D: 10, E: 16, F: 18, G: 14, H: 22, I: 22,
    J: 26, K: 24, L: 16, M: 30, N: 24, O: 18, P: 48, Q: 24, R: 16,
    S: 28, T: 26, U: 20, V: 16, W: 20,
}

const REFS = {
    project: ['Отток'],
    stage: ['Обнаружен','Связываемся','Причина собрана','Предложение сделано','Ждём возврата','Контроль','Вернулся','Потерян'],
    yandex: ['да','нет'],
    offer:  ['ДА','НЕТ'],
    close:  ['Вернулся','Потерян','Ушёл в другой парк','Неактуально'],
}

function buildSkeleton(): ExcelJS.Workbook {
    const wb = new ExcelJS.Workbook()
    wb.creator = 'Yoko CRM'
    wb.created = new Date()

    // ─ Справочники ─
    const refs = wb.addWorksheet('Справочники')
    refs.getCell('A1').value = 'Проект'
    REFS.project.forEach((v, i) => { refs.getCell(`A${i + 2}`).value = v })
    refs.getCell('C1').value = 'Этап воронки'
    REFS.stage.forEach((v, i) => { refs.getCell(`C${i + 2}`).value = v })
    refs.getCell('E1').value = 'Катает в Яндекс?'
    REFS.yandex.forEach((v, i) => { refs.getCell(`E${i + 2}`).value = v })
    refs.getCell('G1').value = 'Можно давать акцию?'
    REFS.offer.forEach((v, i) => { refs.getCell(`G${i + 2}`).value = v })
    refs.getCell('I1').value = 'Итог закрытия'
    REFS.close.forEach((v, i) => { refs.getCell(`I${i + 2}`).value = v })
    for (const letter of 'ACEGI') {
        const c = refs.getCell(`${letter}1`)
        c.font = { bold: true }
    }

    // ─ Отток_шаблон ─
    const ws = wb.addWorksheet(TEMPLATE_SHEET_NAME)

    for (const [letter, width] of Object.entries(COLUMN_WIDTHS)) {
        ws.getColumn(letter).width = width
    }

    // Row 1: title
    ws.mergeCells('A1:W1')
    const title = ws.getCell('A1')
    title.value = 'Список кейсов — Отток'
    title.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 14 }
    title.alignment = { vertical: 'middle', horizontal: 'center' }
    title.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E78' } }
    ws.getRow(1).height = 22

    // Row 2: block headers
    for (const b of BLOCK_HEADERS) {
        ws.mergeCells(`${b.from}2:${b.to}2`)
        const c = ws.getCell(`${b.from}2`)
        c.value = b.title
        c.font = { bold: true, color: { argb: 'FF0F172A' } }
        c.alignment = { vertical: 'middle', horizontal: 'center' }
        c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: b.fill } }
    }

    // Row 3: column headers (must match excel-contract headers)
    for (const col of CHURN_COLUMNS) {
        const c = ws.getCell(`${col.letter}3`)
        c.value = col.header
        c.font = { bold: true, color: { argb: 'FFFFFFFF' } }
        c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E78' } }
        c.alignment = { wrapText: true, vertical: 'middle', horizontal: 'left' }
    }
    ws.getRow(3).height = 42

    // Freeze header rows
    ws.views = [{ state: 'frozen', ySplit: 3 }]

    // Data validations (dropdown)
    const dv = (formula: string, ref: string): ExcelJS.DataValidation => ({
        type: 'list', allowBlank: true, showErrorMessage: true,
        formulae: [formula], error: 'Значение не из справочника',
    } as unknown as ExcelJS.DataValidation)

    // exceljs typings don't expose dataValidations.add publicly; the runtime
    // API is documented and stable. Narrow cast.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wsAny = ws as unknown as { dataValidations: { add: (ref: string, v: ExcelJS.DataValidation) => void } }
    wsAny.dataValidations.add('D4:D1048576', dv("=Справочники!$A$2:$A$2", 'D4:D1048576'))
    wsAny.dataValidations.add('F4:F1048576', dv(`=Справочники!$C$2:$C$${REFS.stage.length + 1}`, 'F4:F1048576'))
    wsAny.dataValidations.add('G4:G1048576', dv(`=Справочники!$E$2:$E$${REFS.yandex.length + 1}`, 'G4:G1048576'))
    wsAny.dataValidations.add('R4:R1048576', dv(`=Справочники!$G$2:$G$${REFS.offer.length + 1}`, 'R4:R1048576'))
    wsAny.dataValidations.add('W4:W1048576', dv(`=Справочники!$I$2:$I$${REFS.close.length + 1}`, 'W4:W1048576'))

    // ─ Инструкция ─
    const howto = wb.addWorksheet('Как_пользоваться')
    howto.getColumn('A').width = 110
    howto.getCell('A1').value = 'Шаблон Отток — CRM ↔ Excel'
    howto.getCell('A1').font = { bold: true, size: 14 }
    const lines = [
        '',
        '• Ключ кейса — колонка A (ID кейса). Не менять, иначе обратный импорт не найдёт задачу.',
        '• Dropdown-валидации стоят на Этапе воронки, «Катает в Яндекс?», «Можно давать акцию?» и «Итог закрытия».',
        '• Значение для «Можно давать акцию?» система выставляет сама. Пустая ячейка = требуется согласование.',
        '• Даты вводите в формате YYYY-MM-DD. Пустая ячейка = значение не задано.',
        '• Столбцы B (ФИО) и C (Номер ВУ) — служебные, читаются из карточки водителя. На импорте они не применяются.',
        '• После редактирования загрузите файл обратно через «Импорт» — система покажет предпросмотр изменений до применения.',
    ]
    lines.forEach((line, i) => { howto.getCell(`A${i + 1}`).value = line })

    return wb
}

// ─── Export ─────────────────────────────────────────────────────────

export interface ExportResult {
    filename: string
    base64: string
    rowCount: number
}

export async function exportChurnXlsx(
    filters: TaskFilters = {},
    sort?: TaskSort,
): Promise<ExportResult> {
    const wb = buildSkeleton()
    const ws = wb.getWorksheet(TEMPLATE_SHEET_NAME)!

    // Fetch data scoped to churn
    const result = await getTasks({ ...filters, scenario: 'churn' }, sort)
    const ids = result.tasks.map(t => t.id)
    const scenarioById = await readScenarioDataMap(ids)

    // Append data rows
    let rowNum = FIRST_DATA_ROW
    for (const task of result.tasks) {
        const enriched = { ...task, scenarioData: scenarioById.get(task.id) } as unknown as TaskDTO
        const row = ws.getRow(rowNum)
        // R=ДА/НЕТ drives the manager-work color convention on Q/R/S
        const verdict = enriched.offerAllowed?.verdict ?? null
        const offerFill = verdict === 'yes' ? 'FFE8F5E9'
            : verdict === 'no'  ? 'FFFFF4CC'
            : null

        for (const col of CHURN_COLUMNS) {
            const v = col.toExcel(enriched)
            if (v === null || v === '') continue
            const cell = row.getCell(col.letter)
            if (v instanceof Date) {
                cell.value = v
                cell.numFmt = 'yyyy-mm-dd'
            } else {
                cell.value = v as string | number
            }
            if (offerFill && (col.letter === 'Q' || col.letter === 'R' || col.letter === 'S')) {
                cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: offerFill } }
            }
        }
        row.commit()
        rowNum++
    }

    const out = await wb.xlsx.writeBuffer()
    const base64 = Buffer.from(out as ArrayBuffer).toString('base64')
    const stamp = new Date().toISOString().slice(0, 10)
    return {
        filename: `Отток_${stamp}.xlsx`,
        base64,
        rowCount: result.tasks.length,
    }
}

// ─── Import: preview ────────────────────────────────────────────────

export interface ImportDiffRow {
    rowNumber: number
    taskId: string
    matched: boolean
    changes: Array<{ field: string; from: unknown; to: unknown }>
    errors: string[]
}

export interface ImportPreviewResult {
    totalRows: number
    updateRows: number
    createRows: number
    rowsWithChanges: number
    rowsWithErrors: number
    sampleDiffs: ImportDiffRow[]
    token: string
}

type RowMode = 'update' | 'create'

interface PreparedRow {
    rowNumber: number
    excelId: string               // raw value of column A
    mode: RowMode
    patches: Array<{ colLetter: string; patch: ImportPatch }>
    driverName: string | null     // column B (for create + display)
    licenseNumber: string | null  // column C (for create + driver lookup)
    errors: string[]
}

export async function previewChurnImport(base64: string): Promise<ImportPreviewResult> {
    // Reader: SheetJS — it tolerates arbitrary producer files (including
    // the reference template, which exceljs.load chokes on).
    //
    // SheetJS has a bug where numeric XML entities for non-BMP code points
    // (e.g. 👑 = &#128081;) get decoded via String.fromCharCode → low 16
    // bits only → ends up as U+F451 (PUA). We pre-sanitize the xlsx so
    // those entities become real UTF-8 characters before parsing.
    const buf = await sanitizeXlsxBuffer(Buffer.from(base64, 'base64'))
    const wb = XLSX.read(buf, { type: 'buffer', cellDates: true })
    const ws = wb.Sheets[TEMPLATE_SHEET_NAME]
    if (!ws) throw new Error(`Лист «${TEMPLATE_SHEET_NAME}» не найден в файле`)

    const range = XLSX.utils.decode_range(ws['!ref'] ?? 'A1:A1')

    // Header row (1-based) → letter → ExcelColumnDef
    const headerMap = new Map<string, (typeof CHURN_COLUMNS)[number]>()
    for (let c = range.s.c; c <= range.e.c; c++) {
        const letter = XLSX.utils.encode_col(c)
        const cell = ws[`${letter}${HEADER_ROW}`]
        if (!cell) continue
        const header = String(cell.v ?? '').trim()
        const col = CHURN_COLUMN_BY_HEADER[header] ?? CHURN_COLUMN_BY_LETTER[letter]
        if (col) headerMap.set(letter, col)
    }

    // Collect rows
    const prepared: PreparedRow[] = []
    for (let r0 = FIRST_DATA_ROW - 1; r0 <= range.e.r; r0++) {
        const rowNumber = r0 + 1
        const aCell = ws[`A${rowNumber}`]
        const bCell = ws[`B${rowNumber}`]
        const cCell = ws[`C${rowNumber}`]
        const excelId = aCell ? String(aCell.v ?? '').trim() : ''
        const driverName = bCell ? String(bCell.v ?? '').trim() : ''
        const licenseNumber = cCell ? String(cCell.v ?? '').trim() : ''

        // Skip truly empty rows
        if (!excelId && !driverName && !licenseNumber) {
            // also require at least one editable cell to be meaningful
            let anyFilled = false
            for (const letter of headerMap.keys()) {
                const v = ws[`${letter}${rowNumber}`]?.v
                if (v !== null && v !== undefined && v !== '') { anyFilled = true; break }
            }
            if (!anyFilled) continue
        }

        // Rules for row mode:
        //   empty A                         → create
        //   A matches cuid pattern          → update
        //   A non-empty but not a cuid      → create (with an info line
        //     so the user understands the ID from Excel is discarded)
        const looksLikeCuid = /^c[a-z0-9]{15,}$/.test(excelId)
        const mode: RowMode = !excelId ? 'create' : looksLikeCuid ? 'update' : 'create'
        const prow: PreparedRow = {
            rowNumber,
            excelId,
            mode,
            patches: [],
            driverName: driverName || null,
            licenseNumber: licenseNumber || null,
            errors: [],
        }
        if (mode === 'create' && excelId) {
            prow.errors.push(`ID «${excelId}» не является внутренним ID CRM — создастся новая задача`)
        }

        for (const [letter, col] of headerMap) {
            if (!col.fromExcel) continue
            const cell = ws[`${letter}${rowNumber}`]
            if (!cell || cell.v === null || cell.v === undefined || cell.v === '') continue
            const raw = cell.t === 'd' ? (cell.v as Date) : cell.v
            const patch = col.fromExcel(raw)
            if (patch) prow.patches.push({ colLetter: letter, patch })
        }

        // Create-mode requires at least a driver identifier
        if (prow.mode === 'create' && !prow.driverName && !prow.licenseNumber) {
            prow.errors.push('Создание: нужны «ФИО водителя» (B) или «Номер ВУ» (C)')
        }

        prepared.push(prow)
    }

    // Resolve assignee-name → id lookup
    const assigneeNames = new Set<string>()
    for (const row of prepared) {
        for (const p of row.patches) {
            const n = (p.patch.task as Record<string, unknown> | undefined)?.__assigneeName
            if (typeof n === 'string') assigneeNames.add(n)
        }
    }
    const assigneeByName = new Map<string, string>()
    if (assigneeNames.size > 0) {
        const users = await prisma.crmUser.findMany({
            where: { name: { in: [...assigneeNames] } },
            select: { id: true, name: true },
        })
        for (const u of users) assigneeByName.set(u.name, u.id)
    }

    // Diff: update-mode compares against DB, create-mode is straight insert.
    const updIds = [...new Set(prepared.filter(r => r.mode === 'update').map(r => r.excelId))]
    const dbRows = updIds.length > 0 ? await prisma.task.findMany({
        where: { id: { in: updIds } },
        select: {
            id: true, stage: true, title: true, nextActionAt: true, dueAt: true,
            resolvedAt: true, closedReason: true, assigneeId: true,
        },
    }) : []
    const sdMap = await readScenarioDataMap(updIds)
    const dbById = new Map(dbRows.map(t => [t.id, { ...t, scenarioData: sdMap.get(t.id) ?? null }]))

    const diffs: ImportDiffRow[] = []
    let updates = 0, creates = 0, withChanges = 0, withErrors = 0
    for (const row of prepared) {
        const diff: ImportDiffRow = {
            rowNumber: row.rowNumber,
            taskId: row.excelId || '(new)',
            matched: row.mode === 'update' && dbById.has(row.excelId),
            changes: [],
            errors: [...row.errors],
        }

        if (row.mode === 'create') {
            creates++
            diff.changes.push({
                field: '__create',
                from: null,
                to: `Новый кейс${row.driverName ? `: ${row.driverName}` : ''}${row.licenseNumber ? ` (ВУ ${row.licenseNumber})` : ''}`,
            })
            // show which editable fields will be populated on create
            for (const { patch } of row.patches) {
                if (patch.task) {
                    for (const [k, v] of Object.entries(patch.task)) {
                        if (k === '__assigneeName') {
                            if (!assigneeByName.has(v as string)) diff.errors.push(`Менеджер «${v}» не найден`)
                            continue
                        }
                        diff.changes.push({ field: k, from: null, to: v })
                    }
                }
                if (patch.scenarioData) {
                    for (const [k, v] of Object.entries(patch.scenarioData)) {
                        diff.changes.push({ field: `scenarioData.${k}`, from: null, to: v })
                    }
                }
            }
        } else {
            updates++
            const existing = dbById.get(row.excelId)
            if (!existing) {
                diff.errors.push('Кейс с таким ID не найден в базе')
                diffs.push(diff); withErrors++; continue
            }
            const sd = (existing.scenarioData ?? {}) as Record<string, { value?: unknown } | unknown>
            for (const { patch } of row.patches) {
                if (patch.task) {
                    for (const [k, v] of Object.entries(patch.task)) {
                        if (k === '__assigneeName') {
                            const name = v as string
                            const id = assigneeByName.get(name)
                            if (id) {
                                if (existing.assigneeId !== id) diff.changes.push({ field: 'assigneeId', from: existing.assigneeId, to: id })
                            } else {
                                diff.errors.push(`Менеджер «${name}» не найден`)
                            }
                            continue
                        }
                        const from = (existing as unknown as Record<string, unknown>)[k]
                        if (!sameValue(from, v)) diff.changes.push({ field: k, from, to: v })
                    }
                }
                if (patch.scenarioData) {
                    for (const [k, v] of Object.entries(patch.scenarioData)) {
                        const existingField = sd[k] as { value?: unknown } | undefined
                        const from = existingField && typeof existingField === 'object' && 'value' in existingField
                            ? existingField.value : undefined
                        if (!sameValue(from, v)) diff.changes.push({ field: `scenarioData.${k}`, from, to: v })
                    }
                }
            }
        }

        if (diff.changes.length > 0) withChanges++
        if (diff.errors.length > 0) withErrors++
        diffs.push(diff)
    }

    const payload = {
        v: 2,
        rows: prepared.map(r => ({
            rowNumber: r.rowNumber,
            excelId: r.excelId,
            mode: r.mode,
            driverName: r.driverName,
            licenseNumber: r.licenseNumber,
            patches: r.patches.map(p => ({
                colLetter: p.colLetter,
                patch: resolveAssigneeInPatch(p.patch, assigneeByName),
            })),
        })),
    }

    return {
        totalRows: prepared.length,
        updateRows: updates,
        createRows: creates,
        rowsWithChanges: withChanges,
        rowsWithErrors: withErrors,
        sampleDiffs: diffs.filter(d => d.changes.length > 0 || d.errors.length > 0).slice(0, 50),
        token: Buffer.from(JSON.stringify(payload), 'utf8').toString('base64'),
    }
}

function resolveAssigneeInPatch(
    patch: ImportPatch,
    assigneeByName: Map<string, string>,
): ImportPatch {
    if (!patch.task?.__assigneeName) return patch
    const name = patch.task.__assigneeName as string
    const id = assigneeByName.get(name)
    const { __assigneeName, ...rest } = patch.task
    void __assigneeName
    return {
        ...patch,
        task: id ? { ...rest, assigneeId: id } : rest,
    }
}

function sameValue(a: unknown, b: unknown): boolean {
    if (a === b) return true
    if (a instanceof Date && typeof b === 'string') return a.toISOString() === b
    if (b instanceof Date && typeof a === 'string') return b.toISOString() === a
    return false
}

// ─── Import: apply ──────────────────────────────────────────────────

export interface ApplyResult {
    created: number
    updated: number
    skipped: number
    errors: Array<{ row: string; message: string }>
}

interface TokenRow {
    rowNumber: number
    excelId: string
    mode: RowMode
    driverName: string | null
    licenseNumber: string | null
    patches: Array<{ colLetter: string; patch: ImportPatch }>
}

export async function applyChurnImport(token: string): Promise<ApplyResult> {
    let payload: { v: number; rows: TokenRow[] }
    try {
        payload = JSON.parse(Buffer.from(token, 'base64').toString('utf8'))
    } catch {
        throw new Error('Повреждённый токен импорта')
    }
    if (payload.v !== 2) throw new Error('Неподдерживаемая версия токена (нужен v=2, этот v=' + payload.v + ')')

    let created = 0, updated = 0, skipped = 0
    const errors: ApplyResult['errors'] = []

    for (const row of payload.rows) {
        const label = `row ${row.rowNumber}${row.excelId ? ` (${row.excelId.slice(-6)})` : ' (new)'}`
        try {
            const taskPatch: Record<string, unknown> = {}
            const sdPatch: Record<string, unknown> = {}
            for (const { patch } of row.patches) {
                if (patch.task) Object.assign(taskPatch, patch.task)
                if (patch.scenarioData) Object.assign(sdPatch, patch.scenarioData)
            }
            for (const key of ['nextActionAt', 'dueAt', 'resolvedAt'] as const) {
                if (typeof taskPatch[key] === 'string') {
                    taskPatch[key] = new Date(taskPatch[key] as string)
                }
            }

            if (row.mode === 'create') {
                const taskId = await createChurnTaskFromRow(row, taskPatch, sdPatch)
                if (taskId) created++
                else skipped++
                continue
            }

            // update
            const hasTask = Object.keys(taskPatch).length > 0
            const hasSd = Object.keys(sdPatch).length > 0
            if (!hasTask && !hasSd) { skipped++; continue }

            if (hasTask) {
                await prisma.task.update({
                    where: { id: row.excelId },
                    data: taskPatch as Parameters<typeof prisma.task.update>[0]['data'],
                })
            }
            if (hasSd) {
                const existing = await prisma.$queryRawUnsafe<Array<{ scenarioData: Record<string, unknown> | null }>>(
                    `SELECT "scenarioData" FROM "tasks" WHERE "id" = $1`,
                    row.excelId,
                )
                const current = (existing[0]?.scenarioData ?? {}) as Record<string, { value?: unknown; source?: string; updatedAt?: string }>
                for (const [k, v] of Object.entries(sdPatch)) {
                    const prev = current[k]
                    current[k] = {
                        ...(prev && typeof prev === 'object' ? prev : {}),
                        value: v,
                        source: 'manual',
                        updatedAt: new Date().toISOString(),
                    }
                }
                await writeScenarioData(row.excelId, current)
            }
            updated++
        } catch (e) {
            errors.push({ row: label, message: (e as Error).message })
        }
    }
    return { created, updated, skipped, errors }
}

async function createChurnTaskFromRow(
    row: TokenRow,
    taskPatch: Record<string, unknown>,
    sdPatch: Record<string, unknown>,
): Promise<string | null> {
    // ─ Resolve / create Driver by licenseNumber or fullName ─
    const driverId = await resolveDriverForImport(row)
    if (!driverId) return null

    // ─ Build scenarioData wrapped per field ─
    const scenarioData: Record<string, { value: unknown; source: string; updatedAt: string }> = {}
    const now = new Date().toISOString()
    for (const [k, v] of Object.entries(sdPatch)) {
        scenarioData[k] = { value: v, source: 'manual', updatedAt: now }
    }
    // Also stamp licenseNumber so list exports later show it
    if (row.licenseNumber && !scenarioData.licenseNumber) {
        scenarioData.licenseNumber = { value: row.licenseNumber, source: 'manual', updatedAt: now }
    }

    // ─ Build Task create data ─
    const title = (taskPatch.title as string | undefined) ?? 'Импорт Excel'
    const stage = (taskPatch.stage as string | undefined) ?? 'detected'
    const nextActionAt = (taskPatch.nextActionAt as Date | undefined) ?? null
    const dueAt = (taskPatch.dueAt as Date | undefined) ?? nextActionAt
    const resolvedAt = (taskPatch.resolvedAt as Date | undefined) ?? null
    const closedReason = (taskPatch.closedReason as string | undefined) ?? null
    const assigneeId = (taskPatch.assigneeId as string | undefined) ?? null

    // Use Prisma for everything except scenarioData (stale client doesn't know it),
    // then raw-write scenarioData in the same transaction-ish sequence.
    const task = await prisma.task.create({
        data: {
            driverId,
            source: 'manual',
            type: 'other',
            title,
            status: closedReason ? 'done' : 'todo',
            priority: 'medium',
            isActive: !closedReason,
            scenario: 'churn',
            stage,
            nextActionAt,
            dueAt,
            resolvedAt,
            closedReason,
            assigneeId,
            stageEnteredAt: new Date(),
        },
    })
    await writeScenarioData(task.id, scenarioData)
    return task.id
}

async function resolveDriverForImport(row: TokenRow): Promise<string | null> {
    const license = (row.licenseNumber ?? '').trim()
    const name = (row.driverName ?? '').trim()

    // Match by license — authoritative when present. If a longer
    // (or different) name comes from Excel, propagate it back so the
    // export round-trip is lossless on column B.
    if (license) {
        const hit = await prisma.driver.findFirst({
            where: { licenseNumber: license },
            select: { id: true, fullName: true },
        })
        if (hit) {
            if (name && name !== hit.fullName) {
                await prisma.driver.update({
                    where: { id: hit.id },
                    data: { fullName: name },
                })
            }
            return hit.id
        }
    }
    if (name) {
        const hit = await prisma.driver.findFirst({
            where: { fullName: name },
            select: { id: true },
        })
        if (hit) return hit.id
    }

    // Not found — create a synthetic driver so the test of the Excel
    // contract can proceed without hand-seeding driver tables.
    const syntheticYandexId = `excel-import:${license || name || 'unknown'}:${Date.now()}:${Math.random().toString(36).slice(2, 6)}`
    const created = await prisma.driver.create({
        data: {
            yandexDriverId: syntheticYandexId,
            fullName: name || `Без имени (${license || 'no-license'})`,
            licenseNumber: license || null,
            segment: 'unknown',
        },
        select: { id: true },
    })
    return created.id
}
