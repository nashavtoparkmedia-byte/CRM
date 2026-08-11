import { beforeEach, describe, expect, it, vi } from 'vitest'

const operations = vi.hoisted(() => ({
    callForJson: vi.fn(),
    callForText: vi.fn(),
}))

vi.mock('@/lib/pipeline/llmClient', () => operations)

import {
    callProviderJsonV1,
    callProviderTextV1,
} from './multi-provider-llm'

describe('multi-provider LLM infrastructure adapter', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('delegates text calls without broadening their options', async () => {
        const options = {
            provider: 'openai',
            model: 'model-1',
            apiKey: 'secret',
            systemPrompt: 'system',
            userMessage: 'user',
        }
        operations.callForText.mockResolvedValueOnce('text')

        await expect(callProviderTextV1(options)).resolves.toBe('text')
        expect(operations.callForText).toHaveBeenCalledWith(options)
    })

    it('delegates JSON calls without exposing a provider client', async () => {
        const options = {
            provider: 'anthropic',
            model: 'model-2',
            apiKey: 'secret',
            systemPrompt: 'system',
            messages: [{ role: 'user' as const, content: 'user' }],
        }
        operations.callForJson.mockResolvedValueOnce('{"ok":true}')

        await expect(callProviderJsonV1(options)).resolves.toBe('{"ok":true}')
        expect(operations.callForJson).toHaveBeenCalledWith(options)
    })
})
