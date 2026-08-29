import { describe, expect, it } from 'vitest'
import {
    getSipExtensionForUser,
    getUserIdForSipExtension,
    listExtensions,
} from '../extensions'

describe('SIP extension mapping', () => {
    it.each([
        ['u1', '101'],
        ['u2', '102'],
        ['u3', '103'],
    ])('maps CRM user %s in both directions', (userId, extension) => {
        expect(getSipExtensionForUser(userId)?.extension).toBe(extension)
        expect(getUserIdForSipExtension(extension)).toBe(userId)
    })

    it('keeps the inbound ring group extension list complete', () => {
        expect(listExtensions()).toEqual(['101', '102', '103'])
        expect(getUserIdForSipExtension('999')).toBeNull()
    })
})
