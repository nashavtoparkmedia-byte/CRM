import { similarity } from '@/lib/ai/knowledge/textUtils'

export function compareKnowledgeTextSimilarityV1(left: string, right: string): number {
    return similarity(left, right)
}
