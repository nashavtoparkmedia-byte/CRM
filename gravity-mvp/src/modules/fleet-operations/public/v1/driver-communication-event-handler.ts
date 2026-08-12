import {
    GET_DRIVER_COMMUNICATION_TIMELINE_RESULT_V1,
    RECORD_DRIVER_COMMUNICATION_EVENT_RESULT_V1,
    parseGetDriverCommunicationTimelineQueryV1,
    parseRecordDriverCommunicationEventCommandV1,
    type DriverCommunicationActivityV1,
    type DriverCommunicationTimelineEventV1,
    type GetDriverCommunicationTimelineQueryV1,
    type GetDriverCommunicationTimelineResultV1,
    type RecordDriverCommunicationEventCommandV1,
    type RecordDriverCommunicationEventResultV1,
} from '@/contracts/fleet-operations/v1'

export interface DriverCommunicationEventPersistencePortV1 {
    record(input: {
        driverId: string
        activity: DriverCommunicationActivityV1
        channel: string
        content: string
        recipientPhone?: string
    }): Promise<void>
    timeline(driverId: string, limit: number): Promise<DriverCommunicationTimelineEventV1[]>
}

export function createRecordDriverCommunicationEventHandlerV1(
    port: DriverCommunicationEventPersistencePortV1,
) {
    return async function recordDriverCommunicationEventV1(
        command: RecordDriverCommunicationEventCommandV1 | unknown,
    ): Promise<RecordDriverCommunicationEventResultV1> {
        const parsed = parseRecordDriverCommunicationEventCommandV1(command)
        await port.record({
            driverId: parsed.driverId,
            activity: parsed.activity,
            channel: parsed.channel,
            content: parsed.content,
            ...(parsed.recipientPhone === undefined ? {} : { recipientPhone: parsed.recipientPhone }),
        })
        return { contract: RECORD_DRIVER_COMMUNICATION_EVENT_RESULT_V1, logged: true }
    }
}

export function createGetDriverCommunicationTimelineHandlerV1(
    port: DriverCommunicationEventPersistencePortV1,
) {
    return async function getDriverCommunicationTimelineV1(
        query: GetDriverCommunicationTimelineQueryV1 | unknown,
    ): Promise<GetDriverCommunicationTimelineResultV1> {
        const parsed = parseGetDriverCommunicationTimelineQueryV1(query)
        const events = await port.timeline(parsed.driverId, parsed.limit ?? 50)
        return { contract: GET_DRIVER_COMMUNICATION_TIMELINE_RESULT_V1, events }
    }
}
