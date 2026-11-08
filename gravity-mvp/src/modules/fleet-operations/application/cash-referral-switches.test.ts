import { afterEach, describe, expect, it } from 'vitest'

import { cashReferralManagerEnabledV1 } from './cash-referral-manager-operations'
import {
    cashAccessLedgerEnabledV1,
    cashReferralAccessEnabledV1,
    cashReferralDecisionScheduleV1,
    runScheduledCashAccessChainCheckV1,
    runScheduledCashReferralDecisionsV1,
} from './cash-referral-operations'

/**
 * The two referral switches.
 *
 * The manager's ledger mode must never start the Telegram path: no code, no
 * capture and, above all, no automatic decision pass that grants access by
 * itself. The Telegram switch keeps meaning what it meant before.
 */

afterEach(() => {
    delete process.env.YOKO_CASH_ACCESS_LEDGER
    delete process.env.YOKO_CASH_REFERRAL_ACCESS
})

describe('referral switches', () => {
    it('are both off by default, and then nothing runs', async () => {
        expect(cashAccessLedgerEnabledV1()).toBe(false)
        expect(cashReferralAccessEnabledV1()).toBe(false)
        expect(cashReferralManagerEnabledV1()).toBe(false)
        expect(cashReferralDecisionScheduleV1().enabled).toBe(false)
        expect(await runScheduledCashReferralDecisionsV1()).toEqual({ skipped: 'disabled' })
        expect(await runScheduledCashAccessChainCheckV1()).toEqual({ skipped: 'disabled' })
    })

    it('in ledger mode read access and open the manager screens, but never run the automatic decision pass', async () => {
        process.env.YOKO_CASH_ACCESS_LEDGER = 'on'
        expect(cashAccessLedgerEnabledV1()).toBe(true)
        expect(cashReferralManagerEnabledV1()).toBe(true)
        expect(cashReferralAccessEnabledV1()).toBe(false)
        // The hourly job is registered for the chain check; the pass inside it answers skipped.
        expect(cashReferralDecisionScheduleV1().enabled).toBe(true)
        expect(await runScheduledCashReferralDecisionsV1()).toEqual({ skipped: 'disabled' })
    })

    it('keep the Telegram switch as before: it implies the ledger read, not the manager screens', () => {
        process.env.YOKO_CASH_REFERRAL_ACCESS = 'on'
        expect(cashReferralAccessEnabledV1()).toBe(true)
        expect(cashAccessLedgerEnabledV1()).toBe(true)
        expect(cashReferralDecisionScheduleV1().enabled).toBe(true)
        expect(cashReferralManagerEnabledV1()).toBe(false)
    })

    it('accept only the exact value on', () => {
        process.env.YOKO_CASH_ACCESS_LEDGER = 'true'
        process.env.YOKO_CASH_REFERRAL_ACCESS = 'ON'
        expect(cashAccessLedgerEnabledV1()).toBe(false)
        expect(cashReferralManagerEnabledV1()).toBe(false)
    })
})
