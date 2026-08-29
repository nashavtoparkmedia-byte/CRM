import 'server-only'

import {
    getItemSourceBadges as getItemSourceBadgesImpl,
    getItemWithSources as getItemWithSourcesImpl,
    getKnowledgeStats as getKnowledgeStatsImpl,
    listExtractionJobs as listExtractionJobsImpl,
    listItemsBySection as listItemsBySectionImpl,
    listKnowledgeSections as listKnowledgeSectionsImpl,
    type ItemSourceBadgeRow,
    type ItemSourceBadges,
    type KnowledgeItem,
    type KnowledgeSection,
    type KnowledgeSource,
    type KnowledgeStats,
} from '@/lib/ai/knowledge/queries'
import {
    projectKnowledgeItemSourceAccessV1,
    type KnowledgeItemSourceAccessV1,
} from './knowledge-source-access'

export type {
    ItemSourceBadgeRow as KnowledgeItemSourceBadgeRowV1,
    ItemSourceBadges as KnowledgeItemSourceBadgesV1,
    KnowledgeItem as KnowledgeItemV1,
    KnowledgeSection as KnowledgeSectionV1,
    KnowledgeSource as KnowledgeSourceV1,
    KnowledgeStats as KnowledgeStatsV1,
}

export type { KnowledgeItemSourceAccessV1 } from './knowledge-source-access'

export async function listKnowledgeSectionsV1(): Promise<KnowledgeSection[]> {
    return listKnowledgeSectionsImpl()
}

export async function listKnowledgeItemsBySectionV1(
    sectionId: string,
    options: { includeArchived?: boolean } = {},
): Promise<KnowledgeItem[]> {
    return listItemsBySectionImpl(sectionId, options)
}

export async function getKnowledgeItemForControlCenterV1(
    itemId: string,
    access: KnowledgeItemSourceAccessV1,
): Promise<{ item: KnowledgeItem | null; sources: KnowledgeSource[] }> {
    const full = await getItemWithSourcesImpl(itemId)
    return projectKnowledgeItemSourceAccessV1(full, access)
}

export async function getKnowledgeStatsV1(): Promise<KnowledgeStats> {
    return getKnowledgeStatsImpl()
}

export async function listKnowledgeExtractionJobsV1(limit = 10): Promise<unknown[]> {
    return listExtractionJobsImpl(limit)
}

export async function getKnowledgeItemSourceBadgesV1(
    itemIds: string[],
): Promise<Map<string, ItemSourceBadges>> {
    return getItemSourceBadgesImpl(itemIds)
}
