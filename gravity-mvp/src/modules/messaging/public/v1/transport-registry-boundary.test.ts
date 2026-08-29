import { describe, expect, it, vi } from 'vitest'

const registry = vi.hoisted(() => ({
    beginNewInstance: vi.fn(() => 'instance-1'),
    ensureEntry: vi.fn(),
    getAllEntries: vi.fn((): unknown[] => []),
    getDegradedDuration: vi.fn(() => 123),
    getEntry: vi.fn(() => null),
    getInstanceId: vi.fn(() => 'instance-1'),
    isCurrentInstance: vi.fn(() => true),
    scheduleReconnect: vi.fn(),
    setFailed: vi.fn(),
    setReady: vi.fn(),
    setReconnecting: vi.fn(),
    setStopped: vi.fn(),
    touch: vi.fn(),
    touchLastSeen: vi.fn(),
}))

vi.mock('@/lib/TransportRegistry', () => registry)

import { transportRegistryHealthV1 } from './transport-registry-health'
import { transportRegistryLifecycleV1 } from './transport-registry-lifecycle'

describe('Messaging transport registry boundaries', () => {
    it('exposes a two-operation read-only health projection', () => {
        expect(transportRegistryHealthV1.getAllEntries()).toEqual([])
        expect(transportRegistryHealthV1.getDegradedDuration('connection-1')).toBe(123)
        expect(registry.getAllEntries).toHaveBeenCalledOnce()
        expect(registry.getDegradedDuration).toHaveBeenCalledWith('connection-1')
    })

    it('does not expose mutable registry entries through a projection', () => {
        const lastSeen = new Date('2026-08-11T00:00:00.000Z')
        const entry = {
            connectionId: 'connection-1',
            channel: 'whatsapp' as const,
            instanceId: 'instance-1',
            state: 'ready' as const,
            lastSeen,
            lastError: null,
            retryAttempt: 0,
            startedAt: new Date('2026-08-10T00:00:00.000Z'),
            readyAt: new Date('2026-08-10T00:01:00.000Z'),
            reconnectInFlight: false,
            degradedAt: null,
        }
        registry.getAllEntries.mockReturnValueOnce([entry])

        const [projection] = transportRegistryHealthV1.getAllEntries()

        expect(projection).not.toBe(entry)
        expect(projection.lastSeen).not.toBe(lastSeen)
        expect(Object.isFrozen(projection)).toBe(true)
        expect(() => { (projection as { state: string }).state = 'failed' }).toThrow()
        expect(entry.state).toBe('ready')
    })

    it('delegates the exact provider lifecycle operations', () => {
        const reconnect = vi.fn(async () => undefined)

        expect(transportRegistryLifecycleV1.beginNewInstance('connection-1')).toBe('instance-1')
        transportRegistryLifecycleV1.ensureEntry('connection-1', 'telegram')
        expect(transportRegistryLifecycleV1.getAllEntries()).toEqual([])
        expect(transportRegistryLifecycleV1.getDegradedDuration('connection-1')).toBe(123)
        expect(transportRegistryLifecycleV1.getEntry('connection-1')).toBeNull()
        expect(transportRegistryLifecycleV1.getInstanceId('connection-1')).toBe('instance-1')
        expect(transportRegistryLifecycleV1.isCurrentInstance('connection-1', 'instance-1')).toBe(true)
        transportRegistryLifecycleV1.scheduleReconnect('connection-1', 'instance-1', reconnect)
        transportRegistryLifecycleV1.setFailed('connection-1', 'instance-1', 'failed')
        transportRegistryLifecycleV1.setReady('connection-1', 'instance-1')
        transportRegistryLifecycleV1.setReconnecting('connection-1', 'instance-1')
        transportRegistryLifecycleV1.setStopped('connection-1')
        transportRegistryLifecycleV1.touch('connection-1', 'instance-1')
        transportRegistryLifecycleV1.touchLastSeen('connection-1')

        expect(registry.ensureEntry).toHaveBeenCalledWith('connection-1', 'telegram')
        expect(registry.scheduleReconnect).toHaveBeenCalledWith('connection-1', 'instance-1', reconnect)
        expect(registry.setFailed).toHaveBeenCalledWith('connection-1', 'instance-1', 'failed')
        expect(registry.setReady).toHaveBeenCalledWith('connection-1', 'instance-1')
        expect(registry.setReconnecting).toHaveBeenCalledWith('connection-1', 'instance-1')
        expect(registry.setStopped).toHaveBeenCalledWith('connection-1')
        expect(registry.touch).toHaveBeenCalledWith('connection-1', 'instance-1')
        expect(registry.touchLastSeen).toHaveBeenCalledWith('connection-1')
    })
})
