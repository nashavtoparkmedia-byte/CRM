import { afterEach, describe, expect, test } from 'vitest'
import {
    clearAllPendingWhatsAppQrsForTests,
    clearPendingWhatsAppQr,
    publishPendingWhatsAppQr,
    readPendingWhatsAppQr,
} from './whatsapp-qr-ceremony'

afterEach(clearAllPendingWhatsAppQrsForTests)

describe('ephemeral WhatsApp QR ceremony', () => {
    test('returns a current QR and expires it deterministically', () => {
        const qr = 'data:image/png;base64,cXItYXV0aC1tYXRlcmlhbA=='
        publishPendingWhatsAppQr('wa-1', 'instance-1', qr, { now: 1_000, ttlMs: 2_000 })
        expect(readPendingWhatsAppQr('wa-1', 2_999)).toBe(qr)
        expect(readPendingWhatsAppQr('wa-1', 3_000)).toBeNull()
    })

    test('clears only the current transport instance', () => {
        const qr = 'data:image/png;base64,cXItYXV0aC1tYXRlcmlhbA=='
        publishPendingWhatsAppQr('wa-1', 'instance-2', qr, { now: 1_000 })
        clearPendingWhatsAppQr('wa-1', 'stale-instance')
        expect(readPendingWhatsAppQr('wa-1', 1_001)).toBe(qr)
        clearPendingWhatsAppQr('wa-1', 'instance-2')
        expect(readPendingWhatsAppQr('wa-1', 1_001)).toBeNull()
    })

    test('rejects non-QR payloads and unbounded retention', () => {
        expect(() => publishPendingWhatsAppQr('wa-1', 'instance-1', 'raw-session-json'))
            .toThrow('payload is invalid')
        expect(() => publishPendingWhatsAppQr(
            'wa-1', 'instance-1', 'data:image/png;base64,cXI=', { ttlMs: 90_001 },
        )).toThrow('TTL is invalid')
    })
})
