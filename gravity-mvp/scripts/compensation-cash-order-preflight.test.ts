import { describe, expect, it } from 'vitest'

import { parseCashOrderPreflightArgsV1 } from './compensation-cash-order-preflight'

/**
 * The operator command's argument handling.
 *
 * The command decides nothing about ingestion: it parses a bounded park subset
 * and hands it to the owner operation, which enforces the configured scope.
 */

describe('parsing the operator arguments', () => {
    it('probes the whole configured scope when no park is named', () => {
        expect(parseCashOrderPreflightArgsV1([])).toEqual({ parks: [], error: null })
    })

    it('reads one park', () => {
        expect(parseCashOrderPreflightArgsV1(['--park', 'p1'])).toEqual({ parks: ['p1'], error: null })
    })

    it('reads a bounded subset without duplicates', () => {
        expect(parseCashOrderPreflightArgsV1(['--park', 'p1', '--park', 'p2', '--park', 'p1']))
            .toEqual({ parks: ['p1', 'p2'], error: null })
    })

    it('trims a park id', () => {
        expect(parseCashOrderPreflightArgsV1(['--park', '  p1  '])).toMatchObject({ parks: ['p1'] })
    })

    it('refuses a park flag with no value', () => {
        expect(parseCashOrderPreflightArgsV1(['--park']).error).toBe('--park needs a value')
        expect(parseCashOrderPreflightArgsV1(['--park', '--park', 'p1']).error).toBe('--park needs a value')
        expect(parseCashOrderPreflightArgsV1(['--park', '   ']).error).toBe('--park needs a value')
    })

    it('refuses an option it does not know', () => {
        expect(parseCashOrderPreflightArgsV1(['--force']).error).toBe('unknown option --force')
        // No window flags exist by design: the windows are canonical.
        expect(parseCashOrderPreflightArgsV1(['--from', '2026-01-01']).error).toBe('unknown option --from')
    })

    it('refuses a positional argument', () => {
        expect(parseCashOrderPreflightArgsV1(['p1']).error).toBe('unexpected argument p1')
    })

    it('does not validate the park itself: the owner operation decides scope', () => {
        expect(parseCashOrderPreflightArgsV1(['--park', 'not-enabled']))
            .toEqual({ parks: ['not-enabled'], error: null })
    })
})
