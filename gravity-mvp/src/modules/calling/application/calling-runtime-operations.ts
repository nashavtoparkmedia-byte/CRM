import {
  backfillCompletedCallTimelineV1 as backfillCompletedCallTimeline,
  enqueueRecoveredCallTranscriptionV1 as enqueueRecoveredCallTranscription,
  recoverCallRecordingV1 as recoverCallRecording,
} from '../public/v1/recording-recovery'
import {
  getObject as getRecordingObject,
  getRecordingUrl as getRecordingUrlInternal,
  probeRecordingStorageV1 as probeRecordingStorage,
  uploadFile as uploadRecordingFile,
} from '../public/v1/recording-storage'
import {
  readMegafonTelephonyHealth,
  rescanMegafonTelephonyGateway,
  type MegafonTelephonyHealthV1,
} from '../internal/telephony-runtime'
import {
  startCallingEslRuntime,
  startCallingProcessingRuntime,
  stopCallingProcessingRuntime,
} from '../internal/calling-runtime'
import { startAiCallFinalizationRecovery } from './ai-call-finalization-runtime'

export const backfillCompletedCallTimelineV1 = (...args: Parameters<typeof backfillCompletedCallTimeline>) => backfillCompletedCallTimeline(...args)
export const enqueueRecoveredCallTranscriptionV1 = (...args: Parameters<typeof enqueueRecoveredCallTranscription>) => enqueueRecoveredCallTranscription(...args)
export const recoverCallRecordingV1 = (...args: Parameters<typeof recoverCallRecording>) => recoverCallRecording(...args)
export const getObject = (...args: Parameters<typeof getRecordingObject>) => getRecordingObject(...args)
export const getRecordingUrl = (...args: Parameters<typeof getRecordingUrlInternal>) => getRecordingUrlInternal(...args)
export const probeRecordingStorageV1 = (...args: Parameters<typeof probeRecordingStorage>) => probeRecordingStorage(...args)
export const uploadFile = (...args: Parameters<typeof uploadRecordingFile>) => uploadRecordingFile(...args)
export type { MegafonTelephonyHealthV1 }
export const readMegafonTelephonyHealthV1 = () => readMegafonTelephonyHealth()
export const rescanMegafonTelephonyGatewayV1 = () => rescanMegafonTelephonyGateway()
export const startCallingEslRuntimeV1 = () => startCallingEslRuntime()
export const startCallingProcessingRuntimeV1 = () => startCallingProcessingRuntime()
export const stopCallingProcessingRuntimeV1 = () => stopCallingProcessingRuntime()
export const startAiCallFinalizationRecoveryV1 = () => startAiCallFinalizationRecovery()
