/**
 * Compensation money representation.
 *
 * Every amount in the monetary core is an integer number of kopecks. There is
 * no floating point, no Decimal and no string arithmetic past the single strict
 * parse below. Yandex reports an order price as a string with exactly four
 * decimals; the 3rd and 4th digits were zero in every sampled order, but the
 * parse truncates rather than rounds so that a non-zero digit can only ever
 * lower the verified amount. Truncation plus `Math.min` are both monotonically
 * non-increasing, which is what makes "compensation never exceeds the verified
 * order amount" a property of the arithmetic instead of a property of a test.
 */

export const KOPECKS_PER_RUBLE = 100
/** Product cap: 1000 RUB. */
export const MAX_COMPENSATION_KOPECKS = 100_000
/** Sanity bound on driver input; the product cap above does the real clamping. */
export const MAX_CLAIMED_RUBLES = 100_000

export type CompensationMoneyErrorCodeV1 =
    | 'VERIFIED_AMOUNT_UNPARSEABLE'
    | 'CLAIMED_AMOUNT_INVALID'
    | 'NON_POSITIVE_AMOUNT'

export class CompensationMoneyErrorV1 extends Error {
    readonly code: CompensationMoneyErrorCodeV1
    constructor(code: CompensationMoneyErrorCodeV1, message: string) {
        super(message)
        this.name = 'CompensationMoneyErrorV1'
        this.code = code
    }
}

/**
 * Yandex Fleet renders `price` as a decimal string with exactly four fraction
 * digits. Anything else is refused outright rather than best-effort parsed: a
 * shape we have never observed is not evidence we can put money behind.
 */
// Seven integer digits keep the parsed value inside a 32-bit kopeck column:
// 9 999 999.9999 RUB is 999 999 999 kopecks, well under 2 147 483 647. A wider
// pattern would let a provider glitch price reach the database and fail there as
// a raw driver error instead of a clean domain refusal.
const VERIFIED_PRICE_PATTERN = /^(0|[1-9][0-9]{0,6})\.([0-9]{4})$/

/** Strict four-decimal price string to integer kopecks, truncating toward zero. */
export function parseVerifiedAmountKopecksV1(raw: unknown): number {
    if (typeof raw !== 'string') {
        throw new CompensationMoneyErrorV1(
            'VERIFIED_AMOUNT_UNPARSEABLE',
            `verified order price must be a string, received ${typeof raw}`,
        )
    }
    const match = VERIFIED_PRICE_PATTERN.exec(raw)
    if (match === null) {
        throw new CompensationMoneyErrorV1(
            'VERIFIED_AMOUNT_UNPARSEABLE',
            'verified order price must match <rubles>.<4 digits>',
        )
    }
    const rubles = Number(match[1])
    const fraction = Number(match[2])
    return rubles * KOPECKS_PER_RUBLE + Math.floor(fraction / 100)
}

/** Driver-entered claim: whole rubles only. */
export function parseClaimedAmountKopecksV1(raw: unknown): number {
    if (typeof raw !== 'number' || !Number.isInteger(raw)) {
        throw new CompensationMoneyErrorV1(
            'CLAIMED_AMOUNT_INVALID',
            'claimed amount must be a whole number of rubles',
        )
    }
    if (raw < 1 || raw > MAX_CLAIMED_RUBLES) {
        throw new CompensationMoneyErrorV1(
            'CLAIMED_AMOUNT_INVALID',
            `claimed amount must be between 1 and ${MAX_CLAIMED_RUBLES} rubles`,
        )
    }
    return raw * KOPECKS_PER_RUBLE
}

/** min(claimed, verified order amount, 1000 RUB) over integers. */
export function compensationAmountKopecksV1(claimedKopecks: number, verifiedKopecks: number): number {
    if (!Number.isInteger(claimedKopecks) || !Number.isInteger(verifiedKopecks)) {
        throw new CompensationMoneyErrorV1('CLAIMED_AMOUNT_INVALID', 'amounts must be integer kopecks')
    }
    const amount = Math.min(claimedKopecks, verifiedKopecks, MAX_COMPENSATION_KOPECKS)
    if (amount <= 0) {
        throw new CompensationMoneyErrorV1(
            'NON_POSITIVE_AMOUNT',
            'compensation amount resolved to zero or less',
        )
    }
    return amount
}

/** Display helper for statistics; never used in domain arithmetic. */
export function formatKopecksAsRublesV1(kopecks: number): string {
    if (!Number.isInteger(kopecks) || kopecks < 0) {
        throw new CompensationMoneyErrorV1('CLAIMED_AMOUNT_INVALID', 'kopecks must be a non-negative integer')
    }
    const rubles = Math.floor(kopecks / KOPECKS_PER_RUBLE)
    const remainder = kopecks % KOPECKS_PER_RUBLE
    return remainder === 0 ? String(rubles) : `${rubles}.${String(remainder).padStart(2, '0')}`
}
