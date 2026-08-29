import { describe, expect, test } from 'vitest'
import {
    apiConnectionPublicMetadataBoundaryForTests,
    projectApiConnectionMetadata,
} from './api-connection-public-metadata'

describe('Fleet ApiConnection public metadata', () => {
    test('returns configured metadata without apiKey', () => {
        const dto = projectApiConnectionMetadata({
            id: 'api-1', clid: 'clid', parkId: 'park', name: null,
            createdAt: new Date('2026-08-10T00:00:00.000Z'), credentialConfigured: true,
        })
        expect(dto).toMatchObject({ id: 'api-1', apiKeyConfigured: true })
        expect(dto).not.toHaveProperty('apiKey')
    })

    test('fails closed if apiKey is introduced through a nested spread', () => {
        expect(() => apiConnectionPublicMetadataBoundaryForTests.assert({ nested: { apiKey: 'secret' } }))
            .toThrow('$.nested.apiKey')
    })
})
