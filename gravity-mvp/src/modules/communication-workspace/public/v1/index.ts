// Communication Workspace public v1 facade. Business hosts submit WHO and WHY
// through communication-workspace.HostAudienceSubmission.v1 and read Runs back;
// no persistence, provider or transaction type crosses this surface.
export {
  advanceCommunicationRunV1,
  communicationEffectsModeForDisplayV1,
  getCommunicationParticipantTimelineV1,
  getCommunicationRunReportV1,
  listCommunicationRunParticipantsV1,
  listCommunicationRunsV1,
  simulateCommunicationSandboxReplyV1,
  startCommunicationRunV1,
} from '../../application/communication-workspace-operations'
export {
  CHURN_RETURN_PROJECT_V1,
  DOCUMENTS_REMINDER_PROJECT_V1,
} from '../../application/communication-policy'
export * from '../../../../contracts/communication-workspace/v1'
