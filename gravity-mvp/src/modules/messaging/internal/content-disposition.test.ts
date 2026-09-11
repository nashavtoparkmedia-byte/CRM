import { describe, it, expect } from 'vitest'
import {
    asciiFileNameFallback,
    encodeRFC5987Value,
    inlineContentDisposition,
} from './content-disposition'

describe('asciiFileNameFallback', () => {
    it('folds non-ASCII characters instead of dropping the name', () => {
        expect(asciiFileNameFallback('договор.pdf')).toBe('_______.pdf')
    })
    it('strips quotes and backslashes that would break the header', () => {
        expect(asciiFileNameFallback('we"ird\\name.txt')).toBe('weirdname.txt')
    })
    it('never returns an empty name', () => {
        expect(asciiFileNameFallback('привет')).not.toBe('')
        expect(asciiFileNameFallback('   ')).toBe('file')
        expect(asciiFileNameFallback('""')).toBe('file')
    })
    it('leaves a plain ASCII name untouched', () => {
        expect(asciiFileNameFallback('report-2026.pdf')).toBe('report-2026.pdf')
    })
})

describe('encodeRFC5987Value', () => {
    it('percent-encodes the characters RFC 5987 reserves', () => {
        expect(encodeRFC5987Value("a'b(c)d*e")).toBe('a%27b%28c%29d%2Ae')
    })
    it('encodes UTF-8 multibyte sequences', () => {
        expect(encodeRFC5987Value('договор.pdf')).toBe(
            '%D0%B4%D0%BE%D0%B3%D0%BE%D0%B2%D0%BE%D1%80.pdf',
        )
    })
})

describe('inlineContentDisposition', () => {
    it('produces a header value that Headers() accepts for a Cyrillic name', () => {
        const value = inlineContentDisposition('договор.pdf')
        // Before this helper existed the raw name was interpolated and this threw.
        expect(() => new Headers({ 'Content-Disposition': value })).not.toThrow()
    })

    it('carries both the ASCII fallback and the exact UTF-8 name', () => {
        expect(inlineContentDisposition('договор.pdf')).toBe(
            `inline; filename="_______.pdf"; filename*=UTF-8''%D0%B4%D0%BE%D0%B3%D0%BE%D0%B2%D0%BE%D1%80.pdf`,
        )
    })

    it('stays header-safe for every stored name shape we have seen', () => {
        for (const name of ['договор.pdf', 'a"b.txt', 'файл со пробелами.jpg', 'plain.png', '💾.bin']) {
            expect(() => new Headers({ 'Content-Disposition': inlineContentDisposition(name) })).not.toThrow()
        }
    })
})
