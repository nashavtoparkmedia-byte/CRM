'use client'

// ═══════════════════════════════════════════════════════════════════
// TaskCaseBlockHeader — single sticky row with colored block labels,
// shown above the list in Operational / Control modes.
//
// Mirrors the block-headers row (row 2) of the Excel template so the
// browser view reads the same way as the spreadsheet.
//
// In elastic (non-fixed) modes each block takes its flex-share, and
// in fixed mode (Table) the dedicated TaskCaseListHeader is used.
// ═══════════════════════════════════════════════════════════════════

import type { ResolvedLayout } from '@/lib/tasks/list-schema'

interface Props {
    layout: ResolvedLayout
}

export default function TaskCaseBlockHeader({ layout }: Props) {
    const blocksWithCols = layout.blocks.map(b => ({
        ...b,
        excludedCols: b.visibleColumns.filter(c => c.id !== 'fullName'),
    }))

    return (
        <div className="sticky top-0 z-20 bg-white border-b border-[#E2E8F0]">
            <div className="flex items-stretch w-full min-h-[28px]">
                {/* Left zone — identifies the ФИО column */}
                <div className="flex items-center shrink-0 pr-3"
                     style={{ backgroundColor: '#F3F4F6' }}>
                    <div className="w-[3px] self-stretch shrink-0 bg-transparent" />
                    <div className="flex items-center pl-2 text-[11px] uppercase tracking-wide text-[#334155] font-semibold"
                         style={{ width: '220px' }}>
                        Идентификация
                    </div>
                </div>

                {/* One cell per block, elastic sharing — mirrors TaskCaseBlock
                    flex policy so labels visually sit above the columns they describe. */}
                <div className="flex items-stretch flex-1 min-w-0">
                    {blocksWithCols.map(block => {
                        if (block.excludedCols.length === 0) return null
                        const flexGrow = block.excludedCols.reduce((sum, c) => sum + c.widthPx, 0)
                        return (
                            <div
                                key={block.id}
                                className="flex items-center justify-center px-2 text-[11px] uppercase tracking-wide text-[#334155] font-semibold border-l border-[#E2E8F0]"
                                style={{
                                    flex: `${flexGrow} 1 0`,
                                    minWidth: '60px',
                                    backgroundColor: block.color ?? '#F3F4F6',
                                }}
                                title={block.label}
                            >
                                <span className="truncate">{block.label}</span>
                            </div>
                        )
                    })}
                </div>
            </div>
        </div>
    )
}
