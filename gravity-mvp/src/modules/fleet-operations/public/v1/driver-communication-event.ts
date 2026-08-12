import {
    createGetDriverCommunicationTimelineHandlerV1,
    createRecordDriverCommunicationEventHandlerV1,
} from './driver-communication-event-handler'
import { legacyPrismaDriverCommunicationEventPortV1 } from './legacy-prisma-driver-communication-event-adapter'

export const recordDriverCommunicationEventV1 = createRecordDriverCommunicationEventHandlerV1(
    legacyPrismaDriverCommunicationEventPortV1,
)
export const getDriverCommunicationTimelineV1 = createGetDriverCommunicationTimelineHandlerV1(
    legacyPrismaDriverCommunicationEventPortV1,
)
