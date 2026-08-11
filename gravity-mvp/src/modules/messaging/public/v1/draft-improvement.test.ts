import { beforeEach, describe, expect, it, vi } from 'vitest'

const operations = vi.hoisted(() => ({
    callProviderTextV1: vi.fn(),
}))

vi.mock('@/infrastructure/providers/multi-provider-llm', () => operations)

import { improveMessageDraftV1 } from './draft-improvement'

describe('Messaging draft-improvement capability', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('retains context bounds, provider options and response cleanup', async () => {
        operations.callProviderTextV1.mockResolvedValueOnce(' «Исправленный текст» ')
        const recentMessages = Array.from({ length: 8 }, (_, index) => ({
            direction: index % 2 === 0 ? 'inbound' as const : 'outbound' as const,
            content: `${index}: ${'x'.repeat(220)}`,
        }))

        await expect(improveMessageDraftV1({
            provider: 'openai',
            model: 'model-1',
            apiKey: 'secret',
            draft: '  исходный текст  ',
            preset: 'expand',
            recentMessages,
            styleGuide: 'Кратко',
        })).resolves.toBe('Исправленный текст')

        expect(operations.callProviderTextV1).toHaveBeenCalledWith(expect.objectContaining({
            provider: 'openai',
            model: 'model-1',
            apiKey: 'secret',
            maxTokens: 600,
            temperature: 0.4,
            systemPrompt: expect.stringContaining('РЕЖИМ: «Подробнее»'),
            userMessage: expect.stringContaining('Черновик менеджера:\nисходный текст'),
        }))
        const request = operations.callProviderTextV1.mock.calls[0][0]
        expect(request.userMessage).not.toContain('0: ')
        expect(request.userMessage).not.toContain('1: ')
        expect(request.userMessage).toContain('2: ')
        expect(request.userMessage).not.toContain('x'.repeat(201))
    })

    it('rejects an empty draft before provider access', async () => {
        await expect(improveMessageDraftV1({
            provider: 'openai',
            model: 'model-1',
            apiKey: 'secret',
            draft: '  ',
            preset: 'improve',
        })).rejects.toThrow('Черновик пустой')
        expect(operations.callProviderTextV1).not.toHaveBeenCalled()
    })
})
