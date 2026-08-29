import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  enqueueTranscribe: vi.fn(),
  closeQueues: vi.fn(),
  closeRedisConnection: vi.fn(),
  getEslConnection: vi.fn(),
  processRecording: vi.fn(),
  startCallProcessingWorkers: vi.fn(),
  stopAnalyzeWorker: vi.fn(),
  stopTranscribeWorker: vi.fn(),
  startEslListener: vi.fn(),
  startAiCallFinalizationRecovery: vi.fn(() => 1 as unknown as ReturnType<typeof setInterval>),
  syncCallToChat: vi.fn(),
}))

vi.mock('@/lib/freeswitch/EslClient', () => ({
  getEslConnection: mocks.getEslConnection,
  startEslListener: mocks.startEslListener,
  syncCallToChat: mocks.syncCallToChat,
}))
vi.mock('@/lib/freeswitch/recordingProcessor', () => ({ processRecording: mocks.processRecording }))
vi.mock('@/lib/queue', () => ({
  closeQueues: mocks.closeQueues,
  closeRedisConnection: mocks.closeRedisConnection,
  startCallProcessingWorkers: mocks.startCallProcessingWorkers,
  stopAnalyzeWorker: mocks.stopAnalyzeWorker,
  stopTranscribeWorker: mocks.stopTranscribeWorker,
}))
vi.mock('@/lib/queue/queues', () => ({ enqueueTranscribe: mocks.enqueueTranscribe }))
vi.mock('../../application/ai-call-finalization-runtime', () => ({
  startAiCallFinalizationRecovery: mocks.startAiCallFinalizationRecovery,
}))

import {
  backfillCompletedCallTimelineV1,
  enqueueRecoveredCallTranscriptionV1,
  recoverCallRecordingV1,
} from './recording-recovery'
import {
  startCallingEslRuntimeV1,
  startAiCallFinalizationRecoveryV1,
  startCallingProcessingRuntimeV1,
  stopCallingProcessingRuntimeV1,
} from './runtime-startup'
import { readMegafonTelephonyHealthV1 } from './telephony-provider-health'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('Calling provider capabilities', () => {
  it('delegates only the exact startup and recording recovery operations', async () => {
    const call = {
      id: 'call-1', contactId: 'contact-1', driverId: null, direction: 'inbound',
      fromNumber: '+70000000001', toNumber: '+70000000002', status: 'completed',
      durationSec: 20, hangupCause: 'NORMAL_CLEARING', startedAt: new Date('2026-08-11T00:00:00Z'),
      endedAt: new Date('2026-08-11T00:00:20Z'),
    }
    const recording = { callId: 'call-1', fsUuid: 'fs-1', recordingFile: '/recordings/fs-1.wav' }

    await startCallingEslRuntimeV1()
    const finalizationRecoveryInterval = startAiCallFinalizationRecoveryV1()
    clearInterval(finalizationRecoveryInterval)
    startCallingProcessingRuntimeV1()
    await stopCallingProcessingRuntimeV1()
    await backfillCompletedCallTimelineV1(call)
    await recoverCallRecordingV1(recording)
    await enqueueRecoveredCallTranscriptionV1('call-1')

    expect(mocks.startEslListener).toHaveBeenCalledOnce()
    expect(mocks.startCallProcessingWorkers).toHaveBeenCalledOnce()
    expect(mocks.startAiCallFinalizationRecovery).toHaveBeenCalledOnce()
    expect(mocks.stopTranscribeWorker).toHaveBeenCalledOnce()
    expect(mocks.stopAnalyzeWorker).toHaveBeenCalledOnce()
    expect(mocks.closeQueues).toHaveBeenCalledOnce()
    expect(mocks.closeRedisConnection).toHaveBeenCalledOnce()
    expect(mocks.syncCallToChat).toHaveBeenCalledWith(call)
    expect(mocks.processRecording).toHaveBeenCalledWith(recording)
    expect(mocks.enqueueTranscribe).toHaveBeenCalledWith('call-1')
  })

  it('projects fixed Megafon state without exposing the raw ESL connection', async () => {
    const api = vi.fn((
      _command: string,
      respond: (response: { getBody: () => string }) => void,
    ) => respond({ getBody: () => 'Status UP\nState REGED\n' }))
    mocks.getEslConnection.mockReturnValue({ api })

    await expect(readMegafonTelephonyHealthV1()).resolves.toEqual({
      eslConnected: true,
      megafonRegistrationState: 'REGED',
    })
    expect(api).toHaveBeenCalledWith('sofia status gateway megafon', expect.any(Function))
  })

  it('reports a disconnected ESL provider without invoking an API command', async () => {
    mocks.getEslConnection.mockReturnValue(null)
    await expect(readMegafonTelephonyHealthV1()).resolves.toEqual({
      eslConnected: false,
      megafonRegistrationState: null,
    })
  })
})
