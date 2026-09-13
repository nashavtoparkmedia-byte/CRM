import { describe, expect, it } from 'vitest'

import {
    comparablePhoneV1,
    matchYandexProfileByExactPhoneV1,
    type YandexProfileCandidateV1,
} from './yandex-profile-match'

function profile(id: string, phone: string, workStatus: string | null = 'working'): YandexProfileCandidateV1 {
    return { id, phones: [phone], workStatus }
}

describe('comparable phone', () => {
    it('treats the 8 and 7 forms of one line as equal', () => {
        expect(comparablePhoneV1('+79001112233')).toBe(comparablePhoneV1('89001112233'))
    })

    it('ignores formatting', () => {
        expect(comparablePhoneV1('+7 (900) 111-22-33')).toBe('9001112233')
    })

    it('refuses anything too short to be a line', () => {
        expect(comparablePhoneV1('12345')).toBeNull()
        expect(comparablePhoneV1('')).toBeNull()
    })
})

describe('exact profile matching', () => {
    it('matches the one profile carrying that line', () => {
        const result = matchYandexProfileByExactPhoneV1('+79001112233', [
            profile('p1', '+79001112233'),
            profile('p2', '+79005554433'),
        ])
        expect(result).toEqual({ kind: 'matched', profileId: 'p1' })
    })

    it('does not match a longer number that merely contains the attested one', () => {
        const result = matchYandexProfileByExactPhoneV1('9001112233', [profile('p1', '79001112233123')])
        expect(result).toEqual({ kind: 'no_match' })
    })

    it('does not match a shorter number contained in the attested one', () => {
        const result = matchYandexProfileByExactPhoneV1('+79001112233', [profile('p1', '1112233')])
        expect(result).toEqual({ kind: 'no_match' })
    })

    it('resolves the park swap where one of two profiles is fired', () => {
        const result = matchYandexProfileByExactPhoneV1('+79001112233', [
            profile('old', '+79001112233', 'fired'),
            profile('new', '+79001112233', 'working'),
        ])
        expect(result).toEqual({ kind: 'matched', profileId: 'new' })
    })

    it('fails closed when two live profiles share the line', () => {
        const result = matchYandexProfileByExactPhoneV1('+79001112233', [
            profile('a', '+79001112233', 'working'),
            profile('b', '+79001112233', 'working'),
        ])
        expect(result).toEqual({ kind: 'ambiguous', profileIds: ['a', 'b'] })
    })

    it('fails closed when every matching profile is fired', () => {
        const result = matchYandexProfileByExactPhoneV1('+79001112233', [
            profile('a', '+79001112233', 'fired'),
            profile('b', '+79001112233', 'fired'),
        ])
        expect(result).toMatchObject({ kind: 'ambiguous' })
    })

    it('returns no match on an empty park', () => {
        expect(matchYandexProfileByExactPhoneV1('+79001112233', [])).toEqual({ kind: 'no_match' })
    })

    it('never reads a name: candidates carry no name field', () => {
        const candidate = profile('p1', '+79001112233')
        expect(Object.keys(candidate)).toEqual(['id', 'phones', 'workStatus'])
    })
})
