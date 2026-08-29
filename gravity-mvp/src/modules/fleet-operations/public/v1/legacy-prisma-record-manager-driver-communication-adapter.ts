import { prisma } from '@/lib/prisma'

import type { RecordManagerDriverCommunicationPersistencePortV1 } from './record-manager-driver-communication-handler'

export const legacyPrismaRecordManagerDriverCommunicationPortV1:
    RecordManagerDriverCommunicationPersistencePortV1 = {
    async recordManagerDriverCommunication({ driverId, activity }) {
        await prisma.communicationEvent.create({
            data: activity === 'call'
                ? {
                    driverId,
                    channel: 'phone',
                    direction: 'outbound',
                    eventType: 'call',
                    content: 'Звонок менеджера',
                    createdBy: 'manager',
                }
                : {
                    driverId,
                    channel: 'telegram',
                    direction: 'outbound',
                    eventType: 'message',
                    content: 'Сообщение менеджера',
                    createdBy: 'manager',
                },
        })
    },
}
