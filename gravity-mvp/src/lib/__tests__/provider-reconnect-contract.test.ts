import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as registry from '@/lib/TransportRegistry'

describe('provider reconnect contract', () => {
    beforeEach(() => {
        vi.useFakeTimers()
        vi.spyOn(Math, 'random').mockReturnValue(0.5)
    })

    afterEach(() => {
        vi.useRealTimers()
        vi.restoreAllMocks()
    })

    it.each(['whatsapp', 'telegram'] as const)(
        'coalesces duplicate %s reconnect schedules',
        async channel => {
            const connectionId = `contract-${channel}-${Date.now()}`
            registry.ensureEntry(connectionId, channel)
            const instanceId = registry.beginNewInstance(connectionId)
            registry.setReconnecting(connectionId, instanceId)

            const reconnect = vi.fn(async () => {
                registry.setReady(connectionId, instanceId)
            })
            registry.scheduleReconnect(connectionId, instanceId, reconnect)
            registry.scheduleReconnect(connectionId, instanceId, reconnect)

            expect(registry.getEntry(connectionId)).toMatchObject({
                state: 'reconnecting',
                retryAttempt: 1,
                reconnectInFlight: true,
            })

            await vi.advanceTimersByTimeAsync(2000)

            expect(reconnect).toHaveBeenCalledTimes(1)
            expect(registry.getEntry(connectionId)).toMatchObject({
                state: 'ready',
                retryAttempt: 0,
                reconnectInFlight: false,
            })
            registry.setStopped(connectionId)
        },
    )

    it('cancels a stale reconnect when a new lifecycle instance starts', async () => {
        const connectionId = `contract-stale-${Date.now()}`
        registry.ensureEntry(connectionId, 'whatsapp')
        const staleInstance = registry.beginNewInstance(connectionId)
        registry.setReconnecting(connectionId, staleInstance)
        const reconnect = vi.fn(async () => undefined)

        registry.scheduleReconnect(connectionId, staleInstance, reconnect)
        const currentInstance = registry.beginNewInstance(connectionId)
        await vi.advanceTimersByTimeAsync(5000)

        expect(reconnect).not.toHaveBeenCalled()
        expect(registry.getInstanceId(connectionId)).toBe(currentInstance)
        registry.setStopped(connectionId)
    })
})
