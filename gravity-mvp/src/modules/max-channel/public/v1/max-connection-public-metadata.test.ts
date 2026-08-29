import { describe, expect, test } from 'vitest'
import { maxPublicMetadataBoundaryForTests, projectMaxConnectionMetadata } from './max-connection-public-metadata'

describe('MAX connection public metadata', () => {
    test('returns configured status without botToken', () => {
        const dto = projectMaxConnectionMetadata({
            id: 'max-1', name: null, isActive: true, isDefault: false,
            createdAt: new Date(0), updatedAt: new Date(0), credentialConfigured: true,
        })
        expect(dto.botTokenConfigured).toBe(true)
        expect(dto).not.toHaveProperty('botToken')
    })

    test('rejects a nested botToken', () => {
        expect(() => maxPublicMetadataBoundaryForTests.assert({ relation: { botToken: 'secret' } }))
            .toThrow('$.relation.botToken')
    })
})
