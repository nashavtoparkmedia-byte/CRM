import { describe, expect, it, vi } from 'vitest'
import {
  SYNC_CALL_TIMELINE_RESULT_V1,
  type CallTimelineMessageV1,
  type SyncCallTimelineResultV1,
} from '../../../../contracts/messaging/v1'
import { createCompletedCallTimelineMessagingProjectorV1 } from './completed-call-timeline-projector'

const projection = {
  externalChatId: 'phone:+79990000000', contactId: 'contact-1', driverId: 'driver-1', peer: '+79990000000',
  callId: 'call-1', direction: 'inbound' as const, callStatus: 'completed', durationSec: 10,
  content: 'Входящий звонок', disposition: 'answered', startedAt: new Date('2026-08-11T10:00:00Z'),
  endedAt: new Date('2026-08-11T10:00:10Z'),
}
const message: CallTimelineMessageV1 = {
  id: 'message-1', chatId: 'chat-1', channel: 'phone', type: 'call', direction: 'inbound',
  content: 'Входящий звонок', sentAt: projection.startedAt, metadata: { callId: 'call-1' },
}

describe('Messaging completed call timeline projector', () => {
  it.each<SyncCallTimelineResultV1>([
    { contract: SYNC_CALL_TIMELINE_RESULT_V1, action: 'created', chatId: 'chat-1', message },
    { contract: SYNC_CALL_TIMELINE_RESULT_V1, action: 'updated', chatId: 'chat-1', message },
  ])('broadcasts only a material timeline change: $action', async (result) => {
    const sync = vi.fn(async () => result)
    const broadcast = vi.fn()
    await createCompletedCallTimelineMessagingProjectorV1({ sync, broadcast })(projection)
    expect(sync).toHaveBeenCalledWith(expect.objectContaining({ contract: 'messaging.SyncCallTimelineCommand.v1', callId: 'call-1' }))
    expect(broadcast).toHaveBeenCalledWith('chat-1', message)
  })

  it('preserves idempotent unchanged behavior without a duplicate broadcast', async () => {
    const sync = vi.fn(async (): Promise<SyncCallTimelineResultV1> => ({
      contract: SYNC_CALL_TIMELINE_RESULT_V1, action: 'unchanged', chatId: 'chat-1',
    }))
    const broadcast = vi.fn()
    await createCompletedCallTimelineMessagingProjectorV1({ sync, broadcast })(projection)
    expect(broadcast).not.toHaveBeenCalled()
  })
})
