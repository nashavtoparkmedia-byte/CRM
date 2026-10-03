import { describe, expect, it } from 'vitest'
import { callAlertKindForTransitionV1, type CallStateSnapshotV1 } from './call-alert-transition'

const inbound = (status: string, isSimulation = false): CallStateSnapshotV1 =>
    ({ direction: 'inbound', status, isSimulation })
const outbound = (status: string): CallStateSnapshotV1 =>
    ({ direction: 'outbound', status, isSimulation: false })

describe('which transition warrants a call alert', () => {
    it('a real inbound call coming into existence is an incoming alert', () => {
        expect(callAlertKindForTransitionV1({ before: null, after: inbound('ringing') })).toBe('call_incoming')
    })

    it('the terminal statement that an inbound call was never answered is a missed alert', () => {
        expect(callAlertKindForTransitionV1({ before: inbound('ringing'), after: inbound('missed') })).toBe('call_missed')
    })

    it('one call can produce incoming and then missed, and they are different kinds', () => {
        const incoming = callAlertKindForTransitionV1({ before: null, after: inbound('ringing') })
        const missed = callAlertKindForTransitionV1({ before: inbound('ringing'), after: inbound('missed') })
        expect([incoming, missed]).toEqual(['call_incoming', 'call_missed'])
    })

    it('re-persisting an already missed call is not a second alert', () => {
        expect(callAlertKindForTransitionV1({ before: inbound('missed'), after: inbound('missed') })).toBeNull()
    })

    it('outbound calls never alert: the operator started them and is already there', () => {
        expect(callAlertKindForTransitionV1({ before: null, after: outbound('ringing') })).toBeNull()
        expect(callAlertKindForTransitionV1({ before: outbound('ringing'), after: outbound('no_answer') })).toBeNull()
    })

    it('no_answer is the outbound terminal and is never a missed alert', () => {
        expect(callAlertKindForTransitionV1({ before: inbound('ringing'), after: inbound('no_answer') })).toBeNull()
    })

    it('every other inbound terminal is distinguished from missed', () => {
        for (const status of ['completed', 'busy', 'rejected', 'failed', 'cancelled', 'active']) {
            expect(callAlertKindForTransitionV1({ before: inbound('ringing'), after: inbound(status) })).toBeNull()
        }
    })

    it('a controlled proof row never rings a real operator', () => {
        expect(callAlertKindForTransitionV1({ before: null, after: inbound('ringing', true) })).toBeNull()
        expect(callAlertKindForTransitionV1({
            before: inbound('ringing', true),
            after: inbound('missed', true),
        })).toBeNull()
    })

    it('an inbound call that was answered and then ended is not missed', () => {
        expect(callAlertKindForTransitionV1({ before: inbound('active'), after: inbound('completed') })).toBeNull()
    })
})
