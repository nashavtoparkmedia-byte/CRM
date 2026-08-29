import { describe, expect, it } from 'vitest'

import { phoneFromWaChatName } from './enrichChatName'

describe('WhatsApp visible phone extraction', () => {
    it('accepts only a title made entirely from phone punctuation', () => {
        expect(phoneFromWaChatName('+7 (922) 123-45-67')).toBe('+79221234567')
        expect(phoneFromWaChatName('922 123-45-67')).toBe('+79221234567')
        expect(phoneFromWaChatName('Driver 9221234567')).toBeNull()
        expect(phoneFromWaChatName('12345')).toBeNull()
        expect(phoneFromWaChatName('opaque@lid')).toBeNull()
    })
})
