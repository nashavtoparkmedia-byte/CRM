import {
    PATCH_PROPOSED_REPLY_RESULT_V1,
    UPSERT_PROPOSED_REPLY_RESULT_V1,
    parsePatchProposedReplyCommandV1,
    parseUpsertProposedReplyCommandV1,
    type PatchProposedReplyCommandV1,
    type PatchProposedReplyResultV1,
    type ProposedReplyPatchV1,
    type UpsertProposedReplyCommandV1,
    type UpsertProposedReplyResultV1,
} from '../../../../contracts/ai-knowledge/v1'

export interface ProposedReplyPersistencePortV1 {
    upsert(input: Omit<UpsertProposedReplyCommandV1, 'contract'>): Promise<unknown>
    patch(proposalId: string, patch: ProposedReplyPatchV1): Promise<void>
}

export function createUpsertProposedReplyHandlerV1(port: ProposedReplyPersistencePortV1) {
    return async function upsertProposedReplyV1(command: UpsertProposedReplyCommandV1 | unknown): Promise<UpsertProposedReplyResultV1> {
        const parsed = parseUpsertProposedReplyCommandV1(command)
        const proposal = await port.upsert({
            messageId: parsed.messageId,
            chatId: parsed.chatId,
            text: parsed.text,
            confidence: parsed.confidence,
            decisionMode: parsed.decisionMode,
            reasoning: parsed.reasoning,
            sources: parsed.sources,
            expiresAt: parsed.expiresAt,
        })
        return { contract: UPSERT_PROPOSED_REPLY_RESULT_V1, proposal }
    }
}

export function createPatchProposedReplyHandlerV1(port: ProposedReplyPersistencePortV1) {
    return async function patchProposedReplyV1(command: PatchProposedReplyCommandV1 | unknown): Promise<PatchProposedReplyResultV1> {
        const parsed = parsePatchProposedReplyCommandV1(command)
        await port.patch(parsed.proposalId, parsed.patch)
        return { contract: PATCH_PROPOSED_REPLY_RESULT_V1, updated: true }
    }
}
