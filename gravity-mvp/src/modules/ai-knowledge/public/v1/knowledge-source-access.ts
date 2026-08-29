export interface KnowledgeItemSourceAccessV1 {
    includeSourceExcerpts: boolean
}

export function projectKnowledgeItemSourceAccessV1<TItem, TSource>(
    full: { item: TItem | null; sources: TSource[] },
    access: KnowledgeItemSourceAccessV1,
): { item: TItem | null; sources: TSource[] } {
    return access.includeSourceExcerpts === true
        ? full
        : { item: full.item, sources: [] }
}
