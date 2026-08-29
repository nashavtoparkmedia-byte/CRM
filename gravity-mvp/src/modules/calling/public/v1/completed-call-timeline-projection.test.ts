import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  projectCompletedCallTimelineV1,
  registerCompletedCallTimelineProjectorV1,
  type CompletedCallTimelineProjectionV1,
} from './completed-call-timeline-projection'

const projection = (): CompletedCallTimelineProjectionV1 => ({
  externalChatId: 'phone:+79990000000',
  contactId: 'contact-1',
  driverId: null,
  peer: '+79990000000',
  callId: 'call-1',
  direction: 'outbound',
  callStatus: 'completed',
  durationSec: 42,
  content: 'Звонок завершён',
  disposition: 'answered',
  startedAt: new Date('2026-08-11T10:00:00.000Z'),
  endedAt: new Date('2026-08-11T10:00:42.000Z'),
})

afterEach(() => {
  globalThis.__completedCallTimelineProjectorV1 = undefined
})

describe('completed call timeline projection port', () => {
  it('fails closed until Platform Shell registers the exact projector', async () => {
    await expect(projectCompletedCallTimelineV1(projection())).rejects.toThrow('not registered')
  })

  it('passes the validated projection to the registered projector', async () => {
    const projector = vi.fn(async () => undefined)
    const unregister = registerCompletedCallTimelineProjectorV1(projector)
    const input = projection()
    await projectCompletedCallTimelineV1(input)
    expect(projector).toHaveBeenCalledWith(input)
    unregister()
    await expect(projectCompletedCallTimelineV1(input)).rejects.toThrow('not registered')
  })

  it('rejects a widened or malformed projection before invoking the projector', async () => {
    const projector = vi.fn(async () => undefined)
    registerCompletedCallTimelineProjectorV1(projector)
    await expect(projectCompletedCallTimelineV1({ ...projection(), durationSec: -1 })).rejects.toThrow('durationSec')
    await expect(projectCompletedCallTimelineV1({ ...projection(), direction: 'sideways' as 'inbound' })).rejects.toThrow('direction')
    expect(projector).not.toHaveBeenCalled()
  })
})
