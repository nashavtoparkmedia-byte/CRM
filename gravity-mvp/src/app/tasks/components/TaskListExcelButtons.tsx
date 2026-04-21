'use client'

// ═══════════════════════════════════════════════════════════════════
// TaskListExcelButtons — Export / Import stubs.
// Wired to toasts for now so the buttons feel live; the real pipeline
// will land on the next stage (canonical + working workbook + diff
// preview + conflict detection).
// ═══════════════════════════════════════════════════════════════════

import { Upload, Download } from 'lucide-react'
import { pushToast } from '@/lib/tasks/toast-store'
import { recordUsage } from '@/lib/tasks/usage'

export default function TaskListExcelButtons() {
    const notReady = (kind: 'export' | 'import') => {
        void recordUsage('excel_click', { kind })
        pushToast('Функция в разработке — появится на следующем этапе', 'info')
    }

    return (
        <div className="flex items-center gap-1">
            <button
                onClick={() => notReady('export')}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-[#E4ECFC] text-[#64748B] text-[12px] font-medium hover:bg-[#F1F5FD] transition-colors"
                title="Экспортировать список в Excel"
            >
                <Download className="w-3.5 h-3.5" />
                Экспорт
            </button>
            <button
                onClick={() => notReady('import')}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-[#E4ECFC] text-[#64748B] text-[12px] font-medium hover:bg-[#F1F5FD] transition-colors"
                title="Импортировать Excel-файл"
            >
                <Upload className="w-3.5 h-3.5" />
                Импорт
            </button>
        </div>
    )
}
