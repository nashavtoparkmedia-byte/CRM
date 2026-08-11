import { startEslListener } from '@/lib/freeswitch/EslClient'
import {
  closeQueues,
  closeRedisConnection,
  startCallProcessingWorkers,
  stopAnalyzeWorker,
  stopTranscribeWorker,
} from '@/lib/queue'

/** Start the Calling-owned FreeSWITCH event listener. */
export async function startCallingEslRuntimeV1(): Promise<void> {
  await startEslListener()
}

/** Start the Calling-owned transcription and analysis workers. */
export function startCallingProcessingRuntimeV1(): void {
  startCallProcessingWorkers()
}

/** Stop Calling workers and their queue connections in the established order. */
export async function stopCallingProcessingRuntimeV1(): Promise<void> {
  await stopTranscribeWorker()
  await stopAnalyzeWorker()
  await closeQueues()
  await closeRedisConnection()
}
