import {
    getDecisionExplainability,
    type ExplainabilityBundle,
    type ExplainAuditRow,
    type ExplainDecisionRow,
    type ExplainMessageRow,
    type ExplainSourceRow,
    type ExplainUsageRow,
} from '@/lib/ai/knowledge/explainability'
import type { KnowledgeItemSourceAccessV1 } from './knowledge-source-access'

export type {
    ExplainabilityBundle as KnowledgeExplainabilityBundleV1,
    ExplainAuditRow as KnowledgeExplainAuditRowV1,
    ExplainDecisionRow as KnowledgeExplainDecisionRowV1,
    ExplainMessageRow as KnowledgeExplainMessageRowV1,
    ExplainSourceRow as KnowledgeExplainSourceRowV1,
    ExplainUsageRow as KnowledgeExplainUsageRowV1,
}

export async function getKnowledgeDecisionExplainabilityV1(
    decisionLogId: string,
    access: KnowledgeItemSourceAccessV1,
): Promise<ExplainabilityBundle> {
    const bundle = await getDecisionExplainability(decisionLogId)
    return access.includeSourceExcerpts === true
        ? bundle
        : { ...bundle, sources: [] }
}
