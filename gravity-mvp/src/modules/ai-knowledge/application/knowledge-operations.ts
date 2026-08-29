import { createRecordKnowledgeUsageHandlerV1 } from '../public/v1/record-knowledge-usage-handler'
import { legacyPrismaRecordKnowledgeUsagePortV1 } from '../public/v1/legacy-prisma-record-knowledge-usage-adapter'
import { createRecordAiDecisionHandlerV1 } from '../public/v1/record-ai-decision-handler'
import { legacyPrismaRecordAiDecisionPortV1 } from '../public/v1/legacy-prisma-record-ai-decision-adapter'
import { createReviewAiDecisionHandlerV1 } from '../public/v1/review-ai-decision-handler'
import { legacyPrismaReviewAiDecisionPortV1 } from '../public/v1/legacy-prisma-review-ai-decision-adapter'
import { createUpdateRetrievalPolicyHandlerV1 } from '../public/v1/update-retrieval-policy-handler'
import { legacyPrismaUpdateRetrievalPolicyPortV1 } from '../public/v1/legacy-prisma-update-retrieval-policy-adapter'
import { createQueueKnowledgeExtractionHandlerV1 } from '../public/v1/queue-knowledge-extraction-handler'
import { legacyPrismaQueueKnowledgeExtractionPortV1 } from '../public/v1/legacy-prisma-queue-knowledge-extraction-adapter'
import { createAttachManualKnowledgeSourceHandlerV1, createDisableKnowledgeSourcesHandlerV1 } from '../public/v1/knowledge-source-handler'
import { legacyPrismaKnowledgeSourcePortV1 } from '../public/v1/legacy-prisma-knowledge-source-adapter'
import { createApplyKnowledgeItemCoachEditHandlerV1, createVerifyKnowledgeItemHandlerV1 } from '../public/v1/knowledge-item-review-handler'
import { legacyPrismaKnowledgeItemReviewPortV1 } from '../public/v1/legacy-prisma-knowledge-item-review-adapter'
import { createPatchProposedReplyHandlerV1, createUpsertProposedReplyHandlerV1 } from '../public/v1/proposed-reply-handler'
import { legacyPrismaProposedReplyPortV1 } from '../public/v1/legacy-prisma-proposed-reply-adapter'
import { createCreateLegacyKnowledgeEntryHandlerV1, createDeleteLegacyKnowledgeEntryHandlerV1, createUpdateLegacyKnowledgeEntryHandlerV1 } from '../public/v1/legacy-knowledge-entry-handler'
import { legacyPrismaLegacyKnowledgeEntryPortV1 } from '../public/v1/legacy-prisma-legacy-knowledge-entry-adapter'
import {
    createArchiveGovernanceKnowledgeItemHandlerV1,
    createArchiveKnowledgeConflictMemberHandlerV1,
    createArchiveKnowledgeItemAfterSourceDisableHandlerV1,
    createArchiveKnowledgeItemForCoreResetHandlerV1,
    createClearKnowledgeConflictGroupHandlerV1,
    createClearKnowledgeConflictWinnerHandlerV1,
    createCreateManualGovernanceKnowledgeItemHandlerV1,
    createEditGovernanceKnowledgeItemHandlerV1,
    createMarkKnowledgeItemSourcesDisabledHandlerV1,
    createRestoreGovernanceKnowledgeItemHandlerV1,
    createSupersedeGovernanceKnowledgeItemHandlerV1,
    createUnverifyGovernanceKnowledgeItemHandlerV1,
    createVerifyGovernanceKnowledgeItemHandlerV1,
} from '../public/v1/knowledge-governance-handler'
import { legacyPrismaKnowledgeGovernancePortV1 } from '../public/v1/legacy-prisma-knowledge-governance-adapter'

const recordKnowledgeUsage = createRecordKnowledgeUsageHandlerV1(legacyPrismaRecordKnowledgeUsagePortV1)
const recordAiDecision = createRecordAiDecisionHandlerV1(legacyPrismaRecordAiDecisionPortV1)
const reviewAiDecision = createReviewAiDecisionHandlerV1(legacyPrismaReviewAiDecisionPortV1)
const updateRetrievalPolicy = createUpdateRetrievalPolicyHandlerV1(legacyPrismaUpdateRetrievalPolicyPortV1)
const queueKnowledgeExtraction = createQueueKnowledgeExtractionHandlerV1(legacyPrismaQueueKnowledgeExtractionPortV1)
const attachManualKnowledgeSource = createAttachManualKnowledgeSourceHandlerV1(legacyPrismaKnowledgeSourcePortV1)
const disableKnowledgeSources = createDisableKnowledgeSourcesHandlerV1(legacyPrismaKnowledgeSourcePortV1)
const verifyKnowledgeItem = createVerifyKnowledgeItemHandlerV1(legacyPrismaKnowledgeItemReviewPortV1)
const applyKnowledgeItemCoachEdit = createApplyKnowledgeItemCoachEditHandlerV1(legacyPrismaKnowledgeItemReviewPortV1)
const upsertProposedReply = createUpsertProposedReplyHandlerV1(legacyPrismaProposedReplyPortV1)
const patchProposedReply = createPatchProposedReplyHandlerV1(legacyPrismaProposedReplyPortV1)
const createLegacyKnowledgeEntry = createCreateLegacyKnowledgeEntryHandlerV1(legacyPrismaLegacyKnowledgeEntryPortV1)
const updateLegacyKnowledgeEntry = createUpdateLegacyKnowledgeEntryHandlerV1(legacyPrismaLegacyKnowledgeEntryPortV1)
const deleteLegacyKnowledgeEntry = createDeleteLegacyKnowledgeEntryHandlerV1(legacyPrismaLegacyKnowledgeEntryPortV1)
const editGovernanceKnowledgeItem = createEditGovernanceKnowledgeItemHandlerV1(legacyPrismaKnowledgeGovernancePortV1)
const archiveGovernanceKnowledgeItem = createArchiveGovernanceKnowledgeItemHandlerV1(legacyPrismaKnowledgeGovernancePortV1)
const restoreGovernanceKnowledgeItem = createRestoreGovernanceKnowledgeItemHandlerV1(legacyPrismaKnowledgeGovernancePortV1)
const verifyGovernanceKnowledgeItem = createVerifyGovernanceKnowledgeItemHandlerV1(legacyPrismaKnowledgeGovernancePortV1)
const unverifyGovernanceKnowledgeItem = createUnverifyGovernanceKnowledgeItemHandlerV1(legacyPrismaKnowledgeGovernancePortV1)
const supersedeGovernanceKnowledgeItem = createSupersedeGovernanceKnowledgeItemHandlerV1(legacyPrismaKnowledgeGovernancePortV1)
const archiveKnowledgeConflictMember = createArchiveKnowledgeConflictMemberHandlerV1(legacyPrismaKnowledgeGovernancePortV1)
const clearKnowledgeConflictWinner = createClearKnowledgeConflictWinnerHandlerV1(legacyPrismaKnowledgeGovernancePortV1)
const clearKnowledgeConflictGroup = createClearKnowledgeConflictGroupHandlerV1(legacyPrismaKnowledgeGovernancePortV1)
const createManualGovernanceKnowledgeItem = createCreateManualGovernanceKnowledgeItemHandlerV1(legacyPrismaKnowledgeGovernancePortV1)
const markKnowledgeItemSourcesDisabled = createMarkKnowledgeItemSourcesDisabledHandlerV1(legacyPrismaKnowledgeGovernancePortV1)
const archiveKnowledgeItemAfterSourceDisable = createArchiveKnowledgeItemAfterSourceDisableHandlerV1(legacyPrismaKnowledgeGovernancePortV1)
const archiveKnowledgeItemForCoreReset = createArchiveKnowledgeItemForCoreResetHandlerV1(legacyPrismaKnowledgeGovernancePortV1)

export const recordKnowledgeUsageV1 = (...args: Parameters<typeof recordKnowledgeUsage>) => recordKnowledgeUsage(...args)
export const recordAiDecisionV1 = (...args: Parameters<typeof recordAiDecision>) => recordAiDecision(...args)
export const reviewAiDecisionV1 = (...args: Parameters<typeof reviewAiDecision>) => reviewAiDecision(...args)
export const updateRetrievalPolicyV1 = (...args: Parameters<typeof updateRetrievalPolicy>) => updateRetrievalPolicy(...args)
export const queueKnowledgeExtractionV1 = (...args: Parameters<typeof queueKnowledgeExtraction>) => queueKnowledgeExtraction(...args)
export const attachManualKnowledgeSourceV1 = (...args: Parameters<typeof attachManualKnowledgeSource>) => attachManualKnowledgeSource(...args)
export const disableKnowledgeSourcesV1 = (...args: Parameters<typeof disableKnowledgeSources>) => disableKnowledgeSources(...args)
export const verifyKnowledgeItemV1 = (...args: Parameters<typeof verifyKnowledgeItem>) => verifyKnowledgeItem(...args)
export const applyKnowledgeItemCoachEditV1 = (...args: Parameters<typeof applyKnowledgeItemCoachEdit>) => applyKnowledgeItemCoachEdit(...args)
export const upsertProposedReplyV1 = (...args: Parameters<typeof upsertProposedReply>) => upsertProposedReply(...args)
export const patchProposedReplyV1 = (...args: Parameters<typeof patchProposedReply>) => patchProposedReply(...args)
export const createLegacyKnowledgeEntryV1 = (...args: Parameters<typeof createLegacyKnowledgeEntry>) => createLegacyKnowledgeEntry(...args)
export const updateLegacyKnowledgeEntryV1 = (...args: Parameters<typeof updateLegacyKnowledgeEntry>) => updateLegacyKnowledgeEntry(...args)
export const deleteLegacyKnowledgeEntryV1 = (...args: Parameters<typeof deleteLegacyKnowledgeEntry>) => deleteLegacyKnowledgeEntry(...args)
export const editGovernanceKnowledgeItemV1 = (...args: Parameters<typeof editGovernanceKnowledgeItem>) => editGovernanceKnowledgeItem(...args)
export const archiveGovernanceKnowledgeItemV1 = (...args: Parameters<typeof archiveGovernanceKnowledgeItem>) => archiveGovernanceKnowledgeItem(...args)
export const restoreGovernanceKnowledgeItemV1 = (...args: Parameters<typeof restoreGovernanceKnowledgeItem>) => restoreGovernanceKnowledgeItem(...args)
export const verifyGovernanceKnowledgeItemV1 = (...args: Parameters<typeof verifyGovernanceKnowledgeItem>) => verifyGovernanceKnowledgeItem(...args)
export const unverifyGovernanceKnowledgeItemV1 = (...args: Parameters<typeof unverifyGovernanceKnowledgeItem>) => unverifyGovernanceKnowledgeItem(...args)
export const supersedeGovernanceKnowledgeItemV1 = (...args: Parameters<typeof supersedeGovernanceKnowledgeItem>) => supersedeGovernanceKnowledgeItem(...args)
export const archiveKnowledgeConflictMemberV1 = (...args: Parameters<typeof archiveKnowledgeConflictMember>) => archiveKnowledgeConflictMember(...args)
export const clearKnowledgeConflictWinnerV1 = (...args: Parameters<typeof clearKnowledgeConflictWinner>) => clearKnowledgeConflictWinner(...args)
export const clearKnowledgeConflictGroupV1 = (...args: Parameters<typeof clearKnowledgeConflictGroup>) => clearKnowledgeConflictGroup(...args)
export const createManualGovernanceKnowledgeItemV1 = (...args: Parameters<typeof createManualGovernanceKnowledgeItem>) => createManualGovernanceKnowledgeItem(...args)
export const markKnowledgeItemSourcesDisabledV1 = (...args: Parameters<typeof markKnowledgeItemSourcesDisabled>) => markKnowledgeItemSourcesDisabled(...args)
export const archiveKnowledgeItemAfterSourceDisableV1 = (...args: Parameters<typeof archiveKnowledgeItemAfterSourceDisable>) => archiveKnowledgeItemAfterSourceDisable(...args)
export const archiveKnowledgeItemForCoreResetV1 = (...args: Parameters<typeof archiveKnowledgeItemForCoreReset>) => archiveKnowledgeItemForCoreReset(...args)
