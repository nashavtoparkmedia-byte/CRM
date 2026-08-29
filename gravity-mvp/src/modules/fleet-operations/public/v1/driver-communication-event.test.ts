import { beforeEach, describe, expect, it, vi } from 'vitest'

const operations = vi.hoisted(() => ({
    create: vi.fn(),
    findMany: vi.fn(),
}))
vi.mock('@/lib/prisma', () => ({
    prisma: { communicationEvent: operations },
}))

import {
    GET_DRIVER_COMMUNICATION_TIMELINE_QUERY_V1,
    RECORD_DRIVER_COMMUNICATION_EVENT_COMMAND_V1,
    parseRecordDriverCommunicationEventCommandV1,
} from '@/contracts/fleet-operations/v1'
import {
    createGetDriverCommunicationTimelineHandlerV1,
    createRecordDriverCommunicationEventHandlerV1,
} from './driver-communication-event-handler'
import { legacyPrismaDriverCommunicationEventPortV1 } from './legacy-prisma-driver-communication-event-adapter'

describe('DriverCommunicationEvent.v1', () => {
    beforeEach(() => vi.clearAllMocks())

    it('rejects unrelated event and ownership fields', () => {
        expect(() => parseRecordDriverCommunicationEventCommandV1({
            contract: RECORD_DRIVER_COMMUNICATION_EVENT_COMMAND_V1,
            driverId: 'driver-1',
            activity: 'manager_message',
            channel: 'telegram',
            content: 'hello',
            recipientPhone: '+79990000000',
            eventType: 'trigger_fired',
        })).toThrow('unsupported field(s): eventType')
        expect(() => parseRecordDriverCommunicationEventCommandV1({
            contract: RECORD_DRIVER_COMMUNICATION_EVENT_COMMAND_V1,
            driverId: 'driver-1',
            activity: 'auto_message',
            channel: 'telegram',
            content: 'hello',
            recipientPhone: '+79990000000',
        })).toThrow('activity is invalid')
    })

    it('maps manager message and call to the exact legacy event objects', async () => {
        operations.create.mockResolvedValue({ id: 'event-1' })
        await legacyPrismaDriverCommunicationEventPortV1.record({
            driverId: 'driver-message',
            activity: 'manager_message',
            channel: 'telegram',
            content: 'hello',
            recipientPhone: '+79990000000',
        })
        await legacyPrismaDriverCommunicationEventPortV1.record({
            driverId: 'driver-call',
            activity: 'manager_call',
            channel: 'phone',
            content: 'note',
        })
        expect(operations.create.mock.calls).toEqual([
            [{ data: {
                driverId: 'driver-message',
                channel: 'telegram',
                direction: 'outbound',
                eventType: 'message',
                content: 'hello',
                metadata: { recipientPhone: '+79990000000' },
                createdBy: 'manager',
            } }],
            [{ data: {
                driverId: 'driver-call',
                channel: 'phone',
                direction: 'outbound',
                eventType: 'call',
                content: 'note',
                createdBy: 'manager',
            } }],
        ])
    })

    it('keeps handler failures visible and defaults timeline limit to 50', async () => {
        const failure = new Error('database unavailable')
        const record = createRecordDriverCommunicationEventHandlerV1({
            record: vi.fn(async () => { throw failure }),
            timeline: vi.fn(),
        })
        await expect(record({
            contract: RECORD_DRIVER_COMMUNICATION_EVENT_COMMAND_V1,
            driverId: 'driver-1',
            activity: 'manager_call',
            channel: 'phone',
            content: 'call',
        })).rejects.toBe(failure)

        const timeline = vi.fn(async () => [])
        const query = createGetDriverCommunicationTimelineHandlerV1({ record: vi.fn(), timeline })
        await query({ contract: GET_DRIVER_COMMUNICATION_TIMELINE_QUERY_V1, driverId: 'driver-1' })
        expect(timeline).toHaveBeenCalledWith('driver-1', 50)
    })

    it('retains descending query, limit, ISO timestamp and metadata mapping', async () => {
        operations.findMany.mockResolvedValue([{ id: 'event-1', channel: 'phone', direction: 'outbound', eventType: 'call', content: null, createdBy: null, createdAt: new Date('2026-08-12T00:00:00Z'), metadata: { note: true } }])
        await expect(legacyPrismaDriverCommunicationEventPortV1.timeline('driver-1', 7)).resolves.toEqual([{
            id: 'event-1', channel: 'phone', direction: 'outbound', eventType: 'call', content: null, createdBy: null, createdAt: '2026-08-12T00:00:00.000Z', metadata: { note: true },
        }])
        expect(operations.findMany).toHaveBeenCalledWith({ where: { driverId: 'driver-1' }, orderBy: { createdAt: 'desc' }, take: 7 })
    })
})
