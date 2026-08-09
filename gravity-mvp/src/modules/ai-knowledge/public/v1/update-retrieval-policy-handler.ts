import { RETRIEVAL_POLICY_FIELDS_V1, UPDATE_RETRIEVAL_POLICY_RESULT_V1, parseUpdateRetrievalPolicyCommandV1, type UpdateRetrievalPolicyCommandV1, type UpdateRetrievalPolicyPatchV1, type UpdateRetrievalPolicyResultV1 } from '../../../../contracts/ai-knowledge/v1'
export interface UpdateRetrievalPolicyPersistencePortV1 { update(input: { actorId: string; patch: UpdateRetrievalPolicyPatchV1 }): Promise<void> }
export function createUpdateRetrievalPolicyHandlerV1(port: UpdateRetrievalPolicyPersistencePortV1) {
    return async function updateRetrievalPolicyV1(command: UpdateRetrievalPolicyCommandV1 | unknown): Promise<UpdateRetrievalPolicyResultV1> {
        const parsed = parseUpdateRetrievalPolicyCommandV1(command)
        const updated = RETRIEVAL_POLICY_FIELDS_V1.some(field => parsed.patch[field] !== undefined)
        if (updated) await port.update({ actorId: parsed.actorId, patch: parsed.patch })
        return { contract: UPDATE_RETRIEVAL_POLICY_RESULT_V1, updated }
    }
}
