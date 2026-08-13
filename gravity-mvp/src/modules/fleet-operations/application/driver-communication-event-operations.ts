import {
    createGetDriverCommunicationTimelineHandlerV1,
    createRecordDriverCommunicationEventHandlerV1,
} from '../public/v1/driver-communication-event-handler'
import { legacyPrismaDriverCommunicationEventPortV1 } from '../public/v1/legacy-prisma-driver-communication-event-adapter'

const recordDriverCommunicationEvent = createRecordDriverCommunicationEventHandlerV1(
    legacyPrismaDriverCommunicationEventPortV1,
)
const getDriverCommunicationTimeline = createGetDriverCommunicationTimelineHandlerV1(
    legacyPrismaDriverCommunicationEventPortV1,
)

export const recordDriverCommunicationEventV1 = (...args: Parameters<typeof recordDriverCommunicationEvent>) => recordDriverCommunicationEvent(...args)
export const getDriverCommunicationTimelineV1 = (...args: Parameters<typeof getDriverCommunicationTimeline>) => getDriverCommunicationTimeline(...args)
