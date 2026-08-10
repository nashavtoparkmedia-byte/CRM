import { describe, expect, test } from 'vitest'
import {
    projectWhatsAppConnectionMetadata,
    whatsappPublicMetadataBoundaryForTests,
} from './whatsapp-connection-public-metadata'

describe('WhatsApp connection public metadata', () => {
    test('distinguishes established session metadata without returning sessionData', () => {
        const dto = projectWhatsAppConnectionMetadata({
            id: 'wa-1', name: null, status: 'ready', phoneNumber: null,
            createdAt: new Date(0), updatedAt: new Date(0), sessionConfigured: true,
        })
        expect(dto.sessionConfigured).toBe(true)
        expect(dto).not.toHaveProperty('sessionData')
    })

    test('rejects a nested sessionData field', () => {
        expect(() => whatsappPublicMetadataBoundaryForTests.assert({ relation: { sessionData: 'secret' } }))
            .toThrow('$.relation.sessionData')
    })
})
