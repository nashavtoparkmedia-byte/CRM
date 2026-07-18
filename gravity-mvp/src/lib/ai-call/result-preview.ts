import type { PreviewMockRun } from './mock-preview'
import type { AiCallProjectType } from './product-preview'

export function managerActionForResult(
    projectType: AiCallProjectType,
    result: PreviewMockRun,
): string {
    if (result.decision.kind === 'failed') return 'Проверить сценарий и повторить mock-запуск.'
    if (result.transfer.requested) return result.transfer.unavailableFallback ?? 'Связаться с Contact.'
    if (projectType === 'qualification') return 'Зафиксировать результат квалификации.'
    if (projectType === 'churn') return 'Добавить причину оттока в план возврата.'
    return 'Учесть оценку в отчёте качества.'
}

export function resultTone(result: PreviewMockRun): 'success' | 'attention' | 'failed' {
    if (result.decision.kind === 'failed') return 'failed'
    if (result.transfer.requested) return 'attention'
    return 'success'
}
