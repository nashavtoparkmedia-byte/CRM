import { describe, expect, it } from 'vitest'
import { requireSuccessfulOriginateResponse } from './esl-originate'

describe('FreeSWITCH AI-call originate response', () => {
    it('accepts an explicit successful provider response', () => {
        expect(requireSuccessfulOriginateResponse('  +OK 1234\n')).toBe('+OK 1234')
    })

    it('turns a FreeSWITCH -ERR body into a provider failure', () => {
        expect(() => requireSuccessfulOriginateResponse('-ERR USER_NOT_REGISTERED'))
            .toThrowError('FreeSWITCH rejected the originate command')
    })
})
