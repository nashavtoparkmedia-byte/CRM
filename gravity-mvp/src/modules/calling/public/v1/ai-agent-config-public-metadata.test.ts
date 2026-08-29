import { describe, expect, test } from 'vitest'
import {
    aiConfigPublicMetadataBoundaryForTests,
    projectAiAgentConfigMetadata,
} from './ai-agent-config-public-metadata'

describe('Calling AI agent config public metadata', () => {
    test('returns only provider credential configured state', () => {
        const dto = projectAiAgentConfigMetadata({
            id: 'singleton', provider: 'openai', apiKeyEncrypted: 'plaintext-secret',
        })
        expect(dto.providerCredentialConfigured).toBe(true)
        expect(dto).not.toHaveProperty('apiKeyEncrypted')
        expect(JSON.stringify(dto)).not.toContain('plaintext-secret')
    })

    test('rejects apiKeyEncrypted introduced through a nested spread', () => {
        expect(() => aiConfigPublicMetadataBoundaryForTests.assert({ nested: { apiKeyEncrypted: 'secret' } }))
            .toThrow('$.nested.apiKeyEncrypted')
    })
})
