import { describe, expect, it } from 'vitest'
import * as surface from './index'

/**
 * The public surface is a boundary, so its shape is a test. A consuming context
 * must be able to learn whether delivery is on and obtain a transport - and must
 * NOT be able to reach a configuration value, a credential or an endpoint.
 */

describe('mobile_delivery public surface', () => {
    it('exposes exactly the two capabilities consumers need', () => {
        expect(typeof surface.isMobileDeliveryEnabledV1).toBe('function')
        expect(typeof surface.resolveMobileDeliveryTransportV1).toBe('function')
    })

    it('exposes no configuration reader, credential or endpoint', () => {
        const exported = Object.keys(surface)
        for (const forbidden of [
            'readFcmTransportConfigV1', 'currentEnvironment', 'loopbackOverrideAllowedV1',
            'createFcmHttpV1TransportV1', 'FcmTransportConfigV1',
        ]) {
            expect(exported).not.toContain(forbidden)
        }
        for (const name of exported) {
            expect(name).not.toMatch(/privateKey|clientEmail|projectId|password|secret|credential/i)
        }
    })

    it('the enablement switch is off unless the value is exactly true', () => {
        const previous = process.env.MOBILE_PUSH_ENABLED
        try {
            for (const value of [undefined, '', 'false', 'TRUE', '1', 'yes', 'true-ish']) {
                if (value === undefined) delete process.env.MOBILE_PUSH_ENABLED
                else process.env.MOBILE_PUSH_ENABLED = value
                expect(surface.isMobileDeliveryEnabledV1()).toBe(false)
            }
            process.env.MOBILE_PUSH_ENABLED = 'true'
            expect(surface.isMobileDeliveryEnabledV1()).toBe(true)
            process.env.MOBILE_PUSH_ENABLED = '  true  '
            expect(surface.isMobileDeliveryEnabledV1()).toBe(true)
        } finally {
            if (previous === undefined) delete process.env.MOBILE_PUSH_ENABLED
            else process.env.MOBILE_PUSH_ENABLED = previous
        }
    })

    it('reports a named problem rather than a credential when configuration is unusable', () => {
        const saved = { ...process.env }
        try {
            for (const key of ['MOBILE_PUSH_FCM_PROJECT_ID', 'MOBILE_PUSH_FCM_CLIENT_EMAIL', 'MOBILE_PUSH_FCM_PRIVATE_KEY']) {
                delete process.env[key]
            }
            const resolved = surface.resolveMobileDeliveryTransportV1()
            expect(resolved.ok).toBe(false)
            if (!resolved.ok) expect(resolved.problem).toBe('missing_project_id')
        } finally {
            process.env = saved
        }
    })
})
