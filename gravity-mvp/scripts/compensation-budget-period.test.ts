import { describe, expect, it } from 'vitest'

import { parseBudgetPeriodArgsV1 } from './compensation-budget-period'

/**
 * The operator command's argument handling.
 *
 * The command itself decides nothing about money: it parses, converts rubles to
 * the kopecks the monetary core uses, and hands both to the owner operation.
 */

describe('parsing the operator arguments', () => {
    it('reads a month and a limit in rubles', () => {
        expect(parseBudgetPeriodArgsV1(['--period', '2026-09', '--limit-rubles', '5000'])).toEqual({
            periodKey: '2026-09', limitKopecks: 500_000, dryRun: false, error: null,
        })
    })

    it('reads a limit already in kopecks', () => {
        expect(parseBudgetPeriodArgsV1(['--period', '2026-09', '--limit-kopecks', '500000'])).toMatchObject({
            limitKopecks: 500_000, error: null,
        })
    })

    it('carries the dry-run flag in any position', () => {
        expect(parseBudgetPeriodArgsV1(['--dry-run', '--period', '2026-09', '--limit-rubles', '5000']))
            .toMatchObject({ dryRun: true, error: null })
        expect(parseBudgetPeriodArgsV1(['--period', '2026-09', '--limit-rubles', '5000', '--dry-run']))
            .toMatchObject({ dryRun: true, error: null })
    })

    it('refuses a missing month or limit rather than guessing one', () => {
        expect(parseBudgetPeriodArgsV1(['--limit-rubles', '5000']).error).toBe('--period is required')
        expect(parseBudgetPeriodArgsV1(['--period', '2026-09']).error)
            .toBe('--limit-rubles or --limit-kopecks is required')
    })

    it('refuses a flag with no value', () => {
        expect(parseBudgetPeriodArgsV1(['--period', '--limit-rubles', '5000']).error).toBe('--period needs a value')
        expect(parseBudgetPeriodArgsV1(['--period', '2026-09', '--limit-rubles']).error)
            .toBe('--limit-rubles needs a value')
    })

    it('refuses a limit that is not a whole number', () => {
        for (const raw of ['5000.5', '-5000', 'много', '5e3']) {
            expect(parseBudgetPeriodArgsV1(['--period', '2026-09', '--limit-rubles', raw]).error)
                .toBe('--limit-rubles must be a whole number')
        }
    })

    it('refuses an option it does not know', () => {
        expect(parseBudgetPeriodArgsV1(['--period', '2026-09', '--limit-rubles', '5000', '--force']).error)
            .toBe('unknown option --force')
    })

    it('does not validate the month itself: the owner operation decides', () => {
        // Parsing only shapes the request; 2026-13 is refused downstream with
        // invalid_period_key, so the command has one source of truth.
        expect(parseBudgetPeriodArgsV1(['--period', '2026-13', '--limit-rubles', '5000']))
            .toMatchObject({ periodKey: '2026-13', limitKopecks: 500_000, error: null })
    })
})
