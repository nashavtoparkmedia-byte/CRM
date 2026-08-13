import { startEslListener } from '@/lib/freeswitch/EslClient'
import {
  closeQueues,
  closeRedisConnection,
  startCallProcessingWorkers,
  stopAnalyzeWorker,
  stopTranscribeWorker,
} from '@/lib/queue'

export async function startCallingEslRuntime(): Promise<void> {
  await startEslListener()
}

export function startCallingProcessingRuntime(): void {
  startCallProcessingWorkers()
}

export async function stopCallingProcessingRuntime(): Promise<void> {
  await stopTranscribeWorker()
  await stopAnalyzeWorker()
  await closeQueues()
  await closeRedisConnection()
}
