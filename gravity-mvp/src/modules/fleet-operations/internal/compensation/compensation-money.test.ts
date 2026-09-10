import { describe, expect, it } from 'vitest'
import {
    CompensationMoneyErrorV1,
    MAX_COMPENSATION_KOPECKS,
    compensationAmountKopecksV1,
    formatKopecksAsRublesV1,
    parseClaimedAmountKopecksV1,
    parseVerifiedAmountKopecksV1,
} from './compensation-money'

describe('parseVerifiedAmountKopecksV1', () => {
    it('parses the four-decimal shape every sampled order used', () => {
        expect(parseVerifiedAmountKopecksV1('0.0000')).toBe(0)
        expect(parseVerifiedAmountKopecksV1('74.0000')).toBe(7400)
        expect(parseVerifiedAmountKopecksV1('306.0000')).toBe(30600)
        expect(parseVerifiedAmountKopecksV1('1318.0000')).toBe(131800)
        expect(parseVerifiedAmountKopecksV1('4420.0000')).toBe(442000)
    })

    it('truncates the third and fourth decimals toward zero', () => {
        expect(parseVerifiedAmountKopecksV1('12.9999')).toBe(1299)
        expect(parseVerifiedAmountKopecksV1('12.5099')).toBe(1250)
        expect(parseVerifiedAmountKopecksV1('12.0099')).toBe(1200)
        expect(parseVerifiedAmountKopecksV1('0.0099')).toBe(0)
    })

    it('never rounds up', () => {
        for (let fraction = 0; fraction < 10000; fraction += 7) {
            const raw = `5.${String(fraction).padStart(4, '0')}`
            const kopecks = parseVerifiedAmountKopecksV1(raw)
            expect(kopecks).toBeLessThanOrEqual(Math.floor(Number(raw) * 100))
            expect(kopecks).toBe(500 + Math.floor(fraction / 100))
        }
    })

    it('refuses every shape that is not exactly four decimals', () => {
        const rejected: unknown[] = [
            '12.999', '12.00000', '12', '12.', '.0000', '-1.0000', '+1.0000',
            '1e3.0000', ' 12.0000', '12.0000 ', '01.0000', 'NaN', '',
            12.0, 1200, null, undefined, {}, ['12.0000'], true,
        ]
        for (const raw of rejected) {
            expect(() => parseVerifiedAmountKopecksV1(raw)).toThrowError(CompensationMoneyErrorV1)
        }
    })

    it('reports a stable error code so callers can fail closed', () => {
        expect.assertions(1)
        try {
            parseVerifiedAmountKopecksV1('12.999')
        } catch (error) {
            expect((error as CompensationMoneyErrorV1).code).toBe('VERIFIED_AMOUNT_UNPARSEABLE')
        }
    })
})

describe('parseClaimedAmountKopecksV1', () => {
    it('accepts whole rubles only', () => {
        expect(parseClaimedAmountKopecksV1(1)).toBe(100)
        expect(parseClaimedAmountKopecksV1(750)).toBe(75000)
    })

    it('refuses fractions, zero, negatives and non-numbers', () => {
        for (const raw of [0, -1, 12.5, '300', null, undefined, NaN, Infinity]) {
            expect(() => parseClaimedAmountKopecksV1(raw)).toThrowError(CompensationMoneyErrorV1)
        }
    })
})

describe('compensationAmountKopecksV1', () => {
    it('takes the minimum of claim, verified amount and the 1000 RUB cap', () => {
        expect(compensationAmountKopecksV1(50_000, 80_000)).toBe(50_000)
        expect(compensationAmountKopecksV1(80_000, 50_000)).toBe(50_000)
        expect(compensationAmountKopecksV1(300_000, 400_000)).toBe(MAX_COMPENSATION_KOPECKS)
    })

    it('never exceeds the verified order amount, for any claim', () => {
        for (let verified = 1; verified <= 200_000; verified += 977) {
            for (const claimed of [100, 30_000, 99_999, 100_000, 500_000]) {
                const amount = compensationAmountKopecksV1(claimed, verified)
                expect(amount).toBeLessThanOrEqual(verified)
                expect(amount).toBeLessThanOrEqual(claimed)
                expect(amount).toBeLessThanOrEqual(MAX_COMPENSATION_KOPECKS)
            }
        }
    })

    it('refuses a zero verified amount rather than settling nothing', () => {
        expect(() => compensationAmountKopecksV1(50_000, 0)).toThrowError(CompensationMoneyErrorV1)
    })
})

describe('formatKopecksAsRublesV1', () => {
    it('renders whole rubles without a fraction', () => {
        expect(formatKopecksAsRublesV1(0)).toBe('0')
        expect(formatKopecksAsRublesV1(30600)).toBe('306')
    })

    it('renders a remainder with two digits', () => {
        expect(formatKopecksAsRublesV1(1299)).toBe('12.99')
        expect(formatKopecksAsRublesV1(1205)).toBe('12.05')
    })
})
