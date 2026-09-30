import { describe, expect, it } from 'vitest'
import {
    makeCallAlertDeliveryRequestedEventV1,
    makeCallAlertRequestedEventV1,
    type CallAlertDeliveryRequestedEventV1,
} from '@/contracts/calling/v1'
import type { MobilePushEligibleDeviceV1, MobilePushTargetResolutionV1 } from '@/contracts/identity-access/v1'
import type { MobilePushSendOutcomeV1 } from '@/contracts/identity-access/v1'
import { CallAlertRetryError, callAlertDataPayloadV1, createCallAlertDispatchV1 } from './call-alert-dispatch'

const CALL = 'call_0001'
const AT = '2026-09-27T10:00:00.000Z'

function harness(overrides: {
    enabled?: boolean
    devices?: MobilePushEligibleDeviceV1[]
    target?: MobilePushTargetResolutionV1
    outcome?: MobilePushSendOutcomeV1
    transportProblem?: 'missing_project_id' | 'endpoint_override_refused'
} = {}) {
    const appended: CallAlertDeliveryRequestedEventV1[] = []
    const seenIds = new Set<string>()
    const sent: Array<Readonly<Record<string, string>>> = []
    const rejected: string[] = []
    const revoked: string[] = []
    const logs: Array<{ level: string, event: string }> = []

    const dispatch = createCallAlertDispatchV1({
        isEnabled: () => overrides.enabled ?? true,
        now: () => new Date(AT),
        listEligibleDevices: async () => overrides.devices ?? [{ registrationId: 'reg_a', sessionBindingId: 'bind_a' }],
        // Mirrors the real append: skipDuplicates, so the event id is the dedup.
        appendDeliveryEvents: async (events) => {
            let count = 0
            for (const event of events) {
                if (seenIds.has(event.eventId)) continue
                seenIds.add(event.eventId)
                appended.push(event)
                count++
            }
            return count
        },
        resolveTarget: async () => overrides.target ?? { kind: 'send', token: 'tok_a' },
        markTokenRejected: async (registrationId) => {
            rejected.push(registrationId)
            return { result: 'cleared' }
        },
        revokeSenderMismatch: async (registrationId) => {
            revoked.push(registrationId)
            return { result: 'revoked' }
        },
        transport: () => overrides.transportProblem
            ? { ok: false, problem: overrides.transportProblem }
            : {
                ok: true,
                transport: {
                    send: async (message) => {
                        sent.push(message.data)
                        return overrides.outcome ?? { kind: 'delivered' }
                    },
                },
            },
        log: (level, event) => logs.push({ level, event }),
    })
    return { dispatch, appended, sent, rejected, revoked, logs }
}

const alert = (kind: 'call_incoming' | 'call_missed' = 'call_incoming') =>
    makeCallAlertRequestedEventV1({ callId: CALL, kind, occurredAt: AT })

const delivery = (registrationId = 'reg_a', kind: 'call_incoming' | 'call_missed' = 'call_incoming') =>
    makeCallAlertDeliveryRequestedEventV1({
        callId: CALL, kind, registrationId, sessionBindingId: 'bind_a', occurredAt: AT,
    })

describe('fanning one alert out to the eligible devices', () => {
    it('no eligible device is not a failure, and nothing is appended', async () => {
        const h = harness({ devices: [] })
        await h.dispatch.fanOut(alert())
        expect(h.appended).toHaveLength(0)
        expect(h.logs.map(l => l.event)).toContain('call_alert_no_eligible_devices')
    })

    it('one eligible device gets one delivery', async () => {
        const h = harness()
        await h.dispatch.fanOut(alert())
        expect(h.appended).toHaveLength(1)
        expect(h.appended[0].data.registrationId).toBe('reg_a')
    })

    it('every eligible device gets one delivery: broadcast, not routing', async () => {
        const h = harness({ devices: [
            { registrationId: 'reg_a', sessionBindingId: 'bind_a' },
            { registrationId: 'reg_b', sessionBindingId: 'bind_b' },
            { registrationId: 'reg_c', sessionBindingId: 'bind_c' },
        ] })
        await h.dispatch.fanOut(alert())
        expect(h.appended.map(e => e.data.registrationId)).toEqual(['reg_a', 'reg_b', 'reg_c'])
    })

    it('a retried fan-out adds nothing, because identity is (call, kind, registration)', async () => {
        const h = harness({ devices: [
            { registrationId: 'reg_a', sessionBindingId: 'bind_a' },
            { registrationId: 'reg_b', sessionBindingId: 'bind_b' },
        ] })
        await h.dispatch.fanOut(alert())
        await h.dispatch.fanOut(alert())
        expect(h.appended).toHaveLength(2)
    })

    it('the same call fanned out for both kinds produces distinct deliveries', async () => {
        const h = harness()
        await h.dispatch.fanOut(alert('call_incoming'))
        await h.dispatch.fanOut(alert('call_missed'))
        expect(h.appended.map(e => e.data.kind)).toEqual(['call_incoming', 'call_missed'])
    })

    it('disabled delivery fans nothing out', async () => {
        const h = harness({ enabled: false })
        await h.dispatch.fanOut(alert())
        expect(h.appended).toHaveLength(0)
    })
})

describe('delivering one alert to one device', () => {
    it('sends exactly the privacy-safe payload and nothing else', async () => {
        const h = harness()
        await h.dispatch.deliver(delivery())
        expect(h.sent).toEqual([{ v: '1', kind: 'call_incoming', callId: CALL }])
        expect(Object.keys(h.sent[0]).sort()).toEqual(['callId', 'kind', 'v'])
    })

    it('carries no number, name, fsUuid, SIP or provider field', () => {
        const payload = callAlertDataPayloadV1('call_missed', CALL)
        const forbidden = ['fromNumber', 'toNumber', 'phone', 'displayName', 'contactName', 'fsUuid', 'sipCallId', 'url', 'recordingUrl', 'transcript']
        for (const key of forbidden) expect(payload).not.toHaveProperty(key)
    })

    it('a revoked, ineligible or stale-session device is skipped, not retried forever', async () => {
        for (const reason of ['revoked', 'ineligible', 'stale_session', 'not_found'] as const) {
            const h = harness({ target: { kind: 'skip', reason } })
            await h.dispatch.deliver(delivery())
            expect(h.sent).toHaveLength(0)
            expect(h.logs.some(l => l.event === 'call_alert_delivery_skipped')).toBe(true)
        }
    })

    it('a device between tokens retries rather than losing the alert', async () => {
        const h = harness({ target: { kind: 'await_token' } })
        await expect(h.dispatch.deliver(delivery())).rejects.toThrow(CallAlertRetryError)
    })

    it('a rejected token is cleared through identity_access and the delivery retries', async () => {
        const h = harness({ outcome: { kind: 'token_unregistered' } })
        await expect(h.dispatch.deliver(delivery())).rejects.toThrow(CallAlertRetryError)
        expect(h.rejected).toEqual(['reg_a'])
    })

    it('a sender mismatch revokes that registration and does not retry it', async () => {
        const h = harness({ outcome: { kind: 'sender_mismatch' } })
        await h.dispatch.deliver(delivery())
        expect(h.revoked).toEqual(['reg_a'])
    })

    it('a provider rate limit is retryable', async () => {
        const h = harness({ outcome: { kind: 'retryable', code: 'QUOTA_EXCEEDED' } })
        await expect(h.dispatch.deliver(delivery())).rejects.toThrow(CallAlertRetryError)
    })

    it('a malformed request is reported, never treated as a bad token', async () => {
        const h = harness({ outcome: { kind: 'terminal', code: 'INVALID_ARGUMENT' } })
        await expect(h.dispatch.deliver(delivery())).rejects.toThrow(CallAlertRetryError)
        expect(h.rejected).toHaveLength(0)
        expect(h.revoked).toHaveLength(0)
    })

    it('enabled with unusable provider configuration fails visibly, never silently', async () => {
        const h = harness({ transportProblem: 'missing_project_id' })
        await expect(h.dispatch.deliver(delivery())).rejects.toThrow(CallAlertRetryError)
        expect(h.logs.some(l => l.level === 'error' && l.event === 'call_alert_transport_misconfigured')).toBe(true)
    })

    it('disabled delivery sends nothing', async () => {
        const h = harness({ enabled: false })
        await h.dispatch.deliver(delivery())
        expect(h.sent).toHaveLength(0)
    })
})
