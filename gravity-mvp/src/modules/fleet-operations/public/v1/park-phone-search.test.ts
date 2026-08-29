import { describe, expect, test } from 'vitest'
import {
    normalizeParkPhoneDigitsV1,
    parkDriverMatchesQueryV1,
    parkDriverProfileFromYandexV1,
} from './park-phone-search'

describe('Fleet park phone normalization', () => {
    test.each([
        ['+7 (999) 123-45-67', '79991234567'],
        ['8 999 123 45 67', '79991234567'],
        ['9991234567', '79991234567'],
    ])('normalizes %s', (input, expected) => {
        expect(normalizeParkPhoneDigitsV1(input)).toBe(expected)
    })
})

describe('Fleet multi-park driver name search', () => {
    const profile = parkDriverProfileFromYandexV1({
        driver_profile: {
            id: 'driver-bashkov',
            last_name: 'Башков',
            first_name: 'Максим',
            middle_name: 'Михайлович',
            phones: ['+7 999 000-11-22'],
            work_status: 'working',
        },
        current_status: { status: 'free' },
    })!

    test('keeps the patronymic and provider statuses', () => {
        expect(profile).toEqual({
            id: 'driver-bashkov',
            fullName: 'Башков Максим Михайлович',
            phones: ['+7 999 000-11-22'],
            workStatus: 'working',
            currentStatus: 'free',
        })
    })

    test.each([
        'Башков Максим Михайлович',
        'Максим Башков',
        '9990001122',
    ])('matches %s without depending on name token order', query => {
        expect(parkDriverMatchesQueryV1(profile, query)).toBe(true)
    })

    test('rejects a different surname', () => {
        expect(parkDriverMatchesQueryV1(profile, 'Максим Иванов')).toBe(false)
    })
})
