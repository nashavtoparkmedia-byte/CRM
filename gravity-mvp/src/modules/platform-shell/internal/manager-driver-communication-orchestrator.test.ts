import { describe, expect, it, vi } from 'vitest'

import { RECORD_DRIVER_DAILY_ACTIVITY_RESULT_V1 } from '@/contracts/fleet-operations/v1'
import { RECORD_MANAGER_DRIVER_COMMUNICATION_RESULT_V1 } from '@/contracts/messaging/v1'

import {
    createManagerDriverCommunicationOrchestratorV1,
    type ManagerDriverCommunicationOwnerApiV1,
} from './manager-driver-communication-orchestrator'

const CLOCK_TIME = new Date(2026, 6, 18, 17, 42, 33, 123).getTime()

function localMidnightIso(timestamp: number): string {
    const date = new Date(timestamp)
    date.setHours(0, 0, 0, 0)
    return date.toISOString()
}

function fixture(options: {
    fleetError?: unknown
    messagingError?: unknown
} = {}) {
    const order: string[] = []
    const owners: ManagerDriverCommunicationOwnerApiV1 = {
        recordDriverDailyActivityV1: vi.fn(async () => {
            order.push('fleet')
            if (options.fleetError) throw options.fleetError
            return {
                contract: RECORD_DRIVER_DAILY_ACTIVITY_RESULT_V1,
                recorded: true as const,
            }
        }),
        recordManagerDriverCommunicationV1: vi.fn(async () => {
            order.push('messaging')
            if (options.messagingError) throw options.messagingError
            return {
                contract: RECORD_MANAGER_DRIVER_COMMUNICATION_RESULT_V1,
                logged: true as const,
            }
        }),
    }
    const clock = { now: vi.fn(() => CLOCK_TIME) }

    return {
        clock,
        order,
        owners,
        orchestrator: createManagerDriverCommunicationOrchestratorV1(owners, clock),
    }
}

describe('manager driver communication Platform orchestration', () => {
    it('records a call at one computed local midnight before logging its exact Messaging command', async () => {
        const current = fixture()

        await expect(current.orchestrator('driver-call', 'call')).resolves.toBeUndefined()

        expect(current.clock.now).toHaveBeenCalledTimes(1)
        expect(current.owners.recordDriverDailyActivityV1).toHaveBeenCalledWith({
            contract: 'fleet_operations.RecordDriverDailyActivityCommand.v1',
            driverId: 'driver-call',
            dayStart: localMidnightIso(CLOCK_TIME),
            activity: 'manager_call',
        })
        expect(current.owners.recordManagerDriverCommunicationV1).toHaveBeenCalledWith({
            contract: 'messaging.RecordManagerDriverCommunicationCommand.v1',
            driverId: 'driver-call',
            activity: 'call',
        })
        expect(current.order).toEqual(['fleet', 'messaging'])
    })

    it('maps a message to manager_message and preserves the owner order', async () => {
        const current = fixture()

        await current.orchestrator('driver-message', 'message')

        expect(current.owners.recordDriverDailyActivityV1).toHaveBeenCalledWith({
            contract: 'fleet_operations.RecordDriverDailyActivityCommand.v1',
            driverId: 'driver-message',
            dayStart: localMidnightIso(CLOCK_TIME),
            activity: 'manager_message',
        })
        expect(current.owners.recordManagerDriverCommunicationV1).toHaveBeenCalledWith({
            contract: 'messaging.RecordManagerDriverCommunicationCommand.v1',
            driverId: 'driver-message',
            activity: 'message',
        })
        expect(current.order).toEqual(['fleet', 'messaging'])
    })

    it('propagates a Fleet failure and never calls Messaging', async () => {
        const failure = new Error('fleet write failed')
        const current = fixture({ fleetError: failure })

        await expect(current.orchestrator('driver-1', 'call')).rejects.toBe(failure)
        expect(current.clock.now).toHaveBeenCalledTimes(1)
        expect(current.owners.recordManagerDriverCommunicationV1).not.toHaveBeenCalled()
        expect(current.order).toEqual(['fleet'])
    })

    it('propagates a Messaging failure after the completed Fleet write', async () => {
        const failure = new Error('communication write failed')
        const current = fixture({ messagingError: failure })

        await expect(current.orchestrator('driver-1', 'message')).rejects.toBe(failure)
        expect(current.owners.recordDriverDailyActivityV1).toHaveBeenCalledTimes(1)
        expect(current.owners.recordManagerDriverCommunicationV1).toHaveBeenCalledTimes(1)
        expect(current.order).toEqual(['fleet', 'messaging'])
    })
})
