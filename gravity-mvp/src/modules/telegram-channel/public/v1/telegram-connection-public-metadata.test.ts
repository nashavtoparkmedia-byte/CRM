import { describe, expect, test } from 'vitest'
import {
    projectTelegramConnectionMetadata,
    telegramPublicMetadataBoundaryForTests,
} from './telegram-connection-public-metadata'

describe('Telegram connection public metadata', () => {
    test('returns only connection state and configured flags', () => {
        const dto = projectTelegramConnectionMetadata({
            id: 'tg-1', apiId: 123, isActive: true, phoneNumber: null,
            createdAt: new Date(0), updatedAt: new Date(0), isDefault: true,
            name: 'Telegram', apiHashConfigured: true, sessionConfigured: true,
        })
        expect(dto).toMatchObject({ apiHashConfigured: true, sessionConfigured: true })
        expect(dto).not.toHaveProperty('apiHash')
        expect(dto).not.toHaveProperty('sessionString')
    })

    test.each(['apiHash', 'sessionString'])('rejects nested %s', key => {
        expect(() => telegramPublicMetadataBoundaryForTests.assert({ relation: { [key]: 'secret' } }))
            .toThrow(`$.relation.${key}`)
    })
})
