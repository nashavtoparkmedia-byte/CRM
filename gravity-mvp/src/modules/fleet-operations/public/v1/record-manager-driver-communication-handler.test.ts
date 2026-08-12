import { beforeEach, describe, expect, it, vi } from 'vitest'

const { communicationEventCreate } = vi.hoisted(() => ({
    communicationEventCreate: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({
    prisma: {
        communicationEvent: {
            create: communicationEventCreate,
        },
    },
}))

import {
    RECORD_MANAGER_DRIVER_COMMUNICATION_COMMAND_V1,
    RECORD_MANAGER_DRIVER_COMMUNICATION_RESULT_V1,
    RecordManagerDriverCommunicationValidationError,
    parseRecordManagerDriverCommunicationCommandV1,
} from '@/contracts/fleet-operations/v1'

import { legacyPrismaRecordManagerDriverCommunicationPortV1 } from './legacy-prisma-record-manager-driver-communication-adapter'
import { createRecordManagerDriverCommunicationHandlerV1 } from './record-manager-driver-communication-handler'

beforeEach(() => {
    vi.clearAllMocks()
})

describe('RecordManagerDriverCommunicationCommand.v1', () => {
    it('accepts only the closed call and message command shapes', () => {
        expect(parseRecordManagerDriverCommunicationCommandV1({
            contract: RECORD_MANAGER_DRIVER_COMMUNICATION_COMMAND_V1,
            driverId: 'driver-call',
            activity: 'call',
        })).toEqual({
            contract: RECORD_MANAGER_DRIVER_COMMUNICATION_COMMAND_V1,
            driverId: 'driver-call',
            activity: 'call',
        })
        expect(parseRecordManagerDriverCommunicationCommandV1({
            contract: RECORD_MANAGER_DRIVER_COMMUNICATION_COMMAND_V1,
            driverId: 'driver-message',
            activity: 'message',
        })).toEqual({
            contract: RECORD_MANAGER_DRIVER_COMMUNICATION_COMMAND_V1,
            driverId: 'driver-message',
            activity: 'message',
        })
    })

    it('rejects unsupported fields and activity values', () => {
        expect(() => parseRecordManagerDriverCommunicationCommandV1({
            contract: RECORD_MANAGER_DRIVER_COMMUNICATION_COMMAND_V1,
            driverId: 'driver-1',
            activity: 'call',
            content: 'arbitrary',
        })).toThrow('unsupported command field(s): content')
        expect(() => parseRecordManagerDriverCommunicationCommandV1({
            contract: RECORD_MANAGER_DRIVER_COMMUNICATION_COMMAND_V1,
            driverId: 'driver-1',
            activity: 'email',
        })).toThrow('activity is invalid')
    })

    it('distinguishes an unsupported contract version', () => {
        expect.assertions(2)
        try {
            parseRecordManagerDriverCommunicationCommandV1({
                contract: 'fleet_operations.RecordManagerDriverCommunicationCommand.v2',
                driverId: 'driver-1',
                activity: 'call',
            })
        } catch (error: unknown) {
            expect(error).toBeInstanceOf(RecordManagerDriverCommunicationValidationError)
            expect((error as RecordManagerDriverCommunicationValidationError).code)
                .toBe('UNSUPPORTED_CONTRACT_VERSION')
        }
    })
})

describe('manager driver communication owner', () => {
    it('passes the parsed closed input to its persistence port and returns logged:true', async () => {
        const recordManagerDriverCommunication = vi.fn(async () => undefined)
        const handler = createRecordManagerDriverCommunicationHandlerV1({
            recordManagerDriverCommunication,
        })

        await expect(handler({
            contract: RECORD_MANAGER_DRIVER_COMMUNICATION_COMMAND_V1,
            driverId: 'driver-1',
            activity: 'call',
        })).resolves.toEqual({
            contract: RECORD_MANAGER_DRIVER_COMMUNICATION_RESULT_V1,
            logged: true,
        })
        expect(recordManagerDriverCommunication).toHaveBeenCalledTimes(1)
        expect(recordManagerDriverCommunication).toHaveBeenCalledWith({
            driverId: 'driver-1',
            activity: 'call',
        })
    })

    it('keeps persistence failures visible', async () => {
        const failure = new Error('write failed')
        const handler = createRecordManagerDriverCommunicationHandlerV1({
            recordManagerDriverCommunication: vi.fn(async () => {
                throw failure
            }),
        })

        await expect(handler({
            contract: RECORD_MANAGER_DRIVER_COMMUNICATION_COMMAND_V1,
            driverId: 'driver-1',
            activity: 'message',
        })).rejects.toBe(failure)
    })

    it('maps a call to the exact legacy CommunicationEvent.create object', async () => {
        communicationEventCreate.mockResolvedValueOnce({ id: 'event-1' })

        await legacyPrismaRecordManagerDriverCommunicationPortV1.recordManagerDriverCommunication({
            driverId: 'driver-call',
            activity: 'call',
        })

        expect(communicationEventCreate).toHaveBeenCalledTimes(1)
        expect(communicationEventCreate).toHaveBeenCalledWith({
            data: {
                driverId: 'driver-call',
                channel: 'phone',
                direction: 'outbound',
                eventType: 'call',
                content: 'Звонок менеджера',
                createdBy: 'manager',
            },
        })
    })

    it('maps a message to the exact legacy CommunicationEvent.create object', async () => {
        communicationEventCreate.mockResolvedValueOnce({ id: 'event-2' })

        await legacyPrismaRecordManagerDriverCommunicationPortV1.recordManagerDriverCommunication({
            driverId: 'driver-message',
            activity: 'message',
        })

        expect(communicationEventCreate).toHaveBeenCalledTimes(1)
        expect(communicationEventCreate).toHaveBeenCalledWith({
            data: {
                driverId: 'driver-message',
                channel: 'telegram',
                direction: 'outbound',
                eventType: 'message',
                content: 'Сообщение менеджера',
                createdBy: 'manager',
            },
        })
    })

    it('does not catch a Prisma create failure', async () => {
        const failure = new Error('database unavailable')
        communicationEventCreate.mockRejectedValueOnce(failure)

        await expect(
            legacyPrismaRecordManagerDriverCommunicationPortV1.recordManagerDriverCommunication({
                driverId: 'driver-1',
                activity: 'call',
            }),
        ).rejects.toBe(failure)
        expect(communicationEventCreate).toHaveBeenCalledTimes(1)
    })
})
