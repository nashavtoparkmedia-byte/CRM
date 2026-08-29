import { describe, expect, test } from 'vitest'
import { normalizeParkPhoneDigitsV1 } from './park-phone-search'

describe('Fleet park phone normalization', () => {
    test.each([
        ['+7 (999) 123-45-67', '79991234567'],
        ['8 999 123 45 67', '79991234567'],
        ['9991234567', '79991234567'],
    ])('normalizes %s', (input, expected) => {
        expect(normalizeParkPhoneDigitsV1(input)).toBe(expected)
    })
})
