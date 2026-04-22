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
    matchedRows: number
    unmatchedRows: number
    rowsWithChanges: number
    rowsWithErrors: number
    sampleDiffs: ImportDiffRow[]
    token: string
}

interface PreparedRow {
    rowNumber: number
    taskId: string
    patches: Array<{ colLetter: string; patch: ImportPatch }>
    errors: string[]
}

export async function previewChurnImport(base64: string): Promise<ImportPreviewResult> {
    const bufferNode = Buffer.from(base64, 'base64')
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(bufferNode.buffer.slice(bufferNode.byteOffset, bufferNode.byteOffset + bufferNode.byteLength))
    const ws = wb.getWorksheet(TEMPLATE_SHEET_NAME)
    if (!ws) throw new Error(`Лист «${TEMPLATE_SHEET_NAME}» не найден в файле`)

    // Build letter → ExcelColumnDef from the header row (row 3)
    const headerMap = new Map<string, (typeof CHURN_COLUMNS)[number]>()
    const headerRow = ws.getRow(HEADER_ROW)
    headerRow.eachCell((cell, colNumber) => {
        const letter = colNumberToLetter(colNumber)
        const header = String(cell.value ?? '').trim()
        const col = CHURN_COLUMN_BY_HEADER[header] ?? CHURN_COLUMN_BY_LETTER[letter]
        if (col) headerMap.set(letter, col)
    })

    // Collect rows
    const prepared: PreparedRow[] = []
    for (let r = FIRST_DATA_ROW; r <= ws.rowCount; r++) {
        const row = ws.getRow(r)
        const idCellVal = row.getCell('A').value
        const taskId = idCellVal == null ? '' : String(idCellVal).trim()
        if (!taskId) continue

        const prow: PreparedRow = { rowNumber: r, taskId, patches: [], errors: [] }
        for (const [letter, col] of headerMap) {
            if (!col.fromExcel) continue
            const cellVal = row.getCell(letter).value
            if (cellVal === null || cellVal === undefined || cellVal === '') continue
            const raw = normalizeCell(cellVal)
            const patch = col.fromExcel(raw)
            if (patch) prow.patches.push({ colLetter: letter, patch })
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

    // Current DB state for diff — regular typed fields via Prisma,
    // scenarioData separately via raw SQL (stale client workaround).
    const ids = [...new Set(prepared.map(r => r.taskId))]
    const dbRows = ids.length > 0 ? await prisma.task.findMany({
        where: { id: { in: ids } },
        select: {
            id: true, stage: true, title: true, nextActionAt: true, dueAt: true,
            resolvedAt: true, closedReason: true, assigneeId: true,
        },
    }) : []
    const sdMap = await readScenarioDataMap(ids)
    const dbById = new Map(dbRows.map(t => [t.id, { ...t, scenarioData: sdMap.get(t.id) ?? null }]))

    const diffs: ImportDiffRow[] = []
    let matched = 0, withChanges = 0, withErrors = 0
    for (const row of prepared) {
        const existing = dbById.get(row.taskId)
        const diff: ImportDiffRow = {
            rowNumber: row.rowNumber,
            taskId: row.taskId,
            matched: !!existing,
            changes: [],
            errors: [...row.errors],
        }
        if (!existing) {
            diff.errors.push('Кейс с таким ID не найден в базе')
            diffs.push(diff); withErrors++; continue
        }
        matched++
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
        if (diff.changes.length > 0) withChanges++
        if (diff.errors.length > 0) withErrors++
        diffs.push(diff)
    }

    const payload = {
        v: 1,
        rows: prepared.map(r => ({
            rowNumber: r.rowNumber,
            taskId: r.taskId,
            patches: r.patches.map(p => ({
                colLetter: p.colLetter,
                patch: resolveAssigneeInPatch(p.patch, assigneeByName),
            })),
        })),
    }

    return {
        totalRows: prepared.length,
        matchedRows: matched,
        unmatchedRows: prepared.length - matched,
        rowsWithChanges: withChanges,
        rowsWithErrors: withErrors,
        sampleDiffs: diffs.filter(d => d.changes.length > 0 || d.errors.length > 0).slice(0, 50),
        token: Buffer.from(JSON.stringify(payload), 'utf8').toString('base64'),
    }
}

function colNumberToLetter(n: number): string {
    let s = ''
    while (n > 0) {
        const rem = (n - 1) % 26
        s = String.fromCharCode(65 + rem) + s
        n = Math.floor((n - 1) / 26)
    }
    return s
}

function normalizeCell(v: unknown): unknown {
    if (v instanceof Date) return v
    if (v && typeof v === 'object') {
        // exceljs rich text / formula / shared string
        const obj = v as Record<string, unknown>
        if (typeof obj.text === 'string') return obj.text
        if (typeof obj.result !== 'undefined') return obj.result
        if (Array.isArray(obj.richText)) {
            return (obj.richText as Array<{ text?: string }>).map(t => t.text ?? '').join('')
        }
    }
    return v
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
    applied: number
    skipped: number
    errors: Array<{ taskId: string; message: string }>
}

export async function applyChurnImport(token: string): Promise<ApplyResult> {
    let payload: { v: number; rows: Array<{ rowNumber: number; taskId: string; patches: Array<{ patch: ImportPatch }> }> }
    try {
        payload = JSON.parse(Buffer.from(token, 'base64').toString('utf8'))
    } catch {
        throw new Error('Повреждённый токен импорта')
    }
    if (payload.v !== 1) throw new Error('Неподдерживаемая версия токена')

    let applied = 0, skipped = 0
    const errors: ApplyResult['errors'] = []

    for (const row of payload.rows) {
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
            const hasTask = Object.keys(taskPatch).length > 0
            const hasSd = Object.keys(sdPatch).length > 0
            if (!hasTask && !hasSd) { skipped++; continue }

            // Two-phase apply:
            //   1. typed fields via Prisma (stage/title/nextActionAt/…)
            //   2. scenarioData merge via raw UPDATE (stale Prisma Client
            //      DLL can't see the column).
            if (hasTask) {
                await prisma.task.update({
                    where: { id: row.taskId },
                    data: taskPatch as Parameters<typeof prisma.task.update>[0]['data'],
                })
            }
            if (hasSd) {
                const existing = await prisma.$queryRawUnsafe<Array<{ scenarioData: Record<string, unknown> | null }>>(
                    `SELECT "scenarioData" FROM "tasks" WHERE "id" = $1`,
                    row.taskId,
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
                await writeScenarioData(row.taskId, current)
            }
            applied++
        } catch (e) {
            errors.push({ taskId: row.taskId, message: (e as Error).message })
        }
    }
    return { applied, skipped, errors }
}
