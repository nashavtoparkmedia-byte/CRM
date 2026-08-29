export interface CompletedCallTimelineProjectionV1 {
  externalChatId: string
  contactId: string
  driverId: string | null
  peer: string
  callId: string
  direction: 'inbound' | 'outbound'
  callStatus: string
  durationSec: number | null
  content: string
  disposition: string
  startedAt: Date
  endedAt: Date | null
}

export type CompletedCallTimelineProjectorV1 = (
  projection: CompletedCallTimelineProjectionV1,
) => Promise<void>

declare global {
  // eslint-disable-next-line no-var
  var __completedCallTimelineProjectorV1: CompletedCallTimelineProjectorV1 | undefined
}

function requireText(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${field} must be a non-empty string`)
}

function validateProjection(projection: CompletedCallTimelineProjectionV1): void {
  for (const field of ['externalChatId', 'contactId', 'peer', 'callId', 'callStatus', 'content', 'disposition'] as const) {
    requireText(projection[field], field)
  }
  if (projection.driverId !== null) requireText(projection.driverId, 'driverId')
  if (projection.direction !== 'inbound' && projection.direction !== 'outbound') {
    throw new TypeError('direction must be inbound or outbound')
  }
  if (projection.durationSec !== null && (!Number.isFinite(projection.durationSec) || projection.durationSec < 0)) {
    throw new TypeError('durationSec must be a finite non-negative number or null')
  }
  if (!(projection.startedAt instanceof Date) || Number.isNaN(projection.startedAt.getTime())) {
    throw new TypeError('startedAt must be a valid Date')
  }
  if (projection.endedAt !== null && (!(projection.endedAt instanceof Date) || Number.isNaN(projection.endedAt.getTime()))) {
    throw new TypeError('endedAt must be a valid Date or null')
  }
}

export function registerCompletedCallTimelineProjectorV1(projector: CompletedCallTimelineProjectorV1): () => void {
  if (typeof projector !== 'function') throw new TypeError('projector must be a function')
  globalThis.__completedCallTimelineProjectorV1 = projector
  return () => {
    if (globalThis.__completedCallTimelineProjectorV1 === projector) {
      globalThis.__completedCallTimelineProjectorV1 = undefined
    }
  }
}

export async function projectCompletedCallTimelineV1(projection: CompletedCallTimelineProjectionV1): Promise<void> {
  validateProjection(projection)
  const projector = globalThis.__completedCallTimelineProjectorV1
  if (!projector) throw new Error('completed call timeline projector is not registered')
  await projector(projection)
}
