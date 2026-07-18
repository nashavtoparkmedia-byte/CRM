import type { PreviewMockRun } from './mock-preview'

export interface PreviewHandoff {
    state: 'not_requested' | 'transferring'
    reason: string | null
    target: string | null
    collectedData: Record<string, string>
    summary: string | null
    unavailableFallback: string | null
    liveSipExecuted: false
}

export function buildHandoffPreview(result: PreviewMockRun): PreviewHandoff {
    return {
        state: result.transfer.requested ? 'transferring' : 'not_requested',
        reason: result.transfer.reason,
        target: result.transfer.target,
        collectedData: result.extractedData,
        summary: result.transfer.summary,
        unavailableFallback: result.transfer.unavailableFallback,
        liveSipExecuted: false,
    }
}
