import {
    runExtraction,
    type ExtractionJobProgress,
} from '@/lib/ai/knowledge/Extractor'
import type { ExtractionScope } from '@/lib/ai/knowledge/pairBuilder'

export type {
    ExtractionJobProgress as KnowledgeExtractionJobProgressV1,
    ExtractionScope as KnowledgeExtractionScopeV1,
}

export async function runQueuedKnowledgeExtractionV1(jobId: string): Promise<void> {
    return runExtraction(jobId)
}
