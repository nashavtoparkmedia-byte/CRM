export { callingOutboxPublishersV1 } from './outbox-consumers'
export { persistRecordingReadyV1 } from '../../internal/recording-ready-prisma-adapter'
import{createCreateAiAgentProfileHandlerV1,createDeleteAiAgentProfileHandlerV1,createUpdateAiAgentProfileHandlerV1}from'./ai-agent-profile-handler'
import{legacyPrismaAiAgentProfilePortV1}from'./legacy-prisma-ai-agent-profile-adapter'
export{createCreateAiAgentProfileHandlerV1,createDeleteAiAgentProfileHandlerV1,createUpdateAiAgentProfileHandlerV1}from'./ai-agent-profile-handler'
export type{AiAgentProfilePersistencePortV1}from'./ai-agent-profile-handler'
export const createAiAgentProfileV1=createCreateAiAgentProfileHandlerV1(legacyPrismaAiAgentProfilePortV1)
export const updateAiAgentProfileV1=createUpdateAiAgentProfileHandlerV1(legacyPrismaAiAgentProfilePortV1)
export const deleteAiAgentProfileV1=createDeleteAiAgentProfileHandlerV1(legacyPrismaAiAgentProfilePortV1)
