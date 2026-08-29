import 'server-only'

import {
    getKnowledgeRuntimeMode,
    isRuntimeEnabled,
    isShadowModeEnabled,
} from '@/lib/ai/knowledge/featureFlags'
import {
    getKnowledgeReadiness,
    type KnowledgeActivity7d,
    type KnowledgeHealth7d,
    type KnowledgeLastExtraction,
    type KnowledgeReadinessBundle,
    type KnowledgeReadinessCounts,
    type ReadinessCheck,
    type ReadinessCheckStatus,
} from '@/lib/ai/knowledge/readiness'

export type {
    KnowledgeActivity7d as KnowledgeActivity7dV1,
    KnowledgeHealth7d as KnowledgeHealth7dV1,
    KnowledgeLastExtraction as KnowledgeLastExtractionV1,
    KnowledgeReadinessBundle as KnowledgeReadinessBundleV1,
    KnowledgeReadinessCounts as KnowledgeReadinessCountsV1,
    ReadinessCheck as KnowledgeReadinessCheckV1,
    ReadinessCheckStatus as KnowledgeReadinessCheckStatusV1,
}

export function isKnowledgeShadowModeEnabledV1(): boolean {
    return isShadowModeEnabled()
}

export function isKnowledgeRuntimeEnabledV1(): boolean {
    return isRuntimeEnabled()
}

export function getKnowledgeRuntimeModeV1(): 'legacy' | 'shadow' | 'runtime' {
    return getKnowledgeRuntimeMode()
}

export async function getKnowledgeReadinessV1(): Promise<KnowledgeReadinessBundle> {
    return getKnowledgeReadiness()
}
