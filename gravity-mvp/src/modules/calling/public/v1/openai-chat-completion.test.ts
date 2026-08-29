import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const operations = vi.hoisted(() => ({
    create: vi.fn(),
    createOpenAIClientV1: vi.fn(),
    getOpenAiRuntimeProviderCredentialV1: vi.fn(),
}))

vi.mock('@/infrastructure/providers/openai-client', () => ({
    createOpenAIClientV1: operations.createOpenAIClientV1,
}))
vi.mock('./ai-call-provider-settings', () => ({
    getOpenAiRuntimeProviderCredentialV1: operations.getOpenAiRuntimeProviderCredentialV1,
}))

describe('Calling OpenAI chat-completion capability', () => {
    beforeEach(() => {
        vi.resetModules()
        vi.clearAllMocks()
        delete process.env.OPENAI_API_KEY
        operations.createOpenAIClientV1.mockReturnValue({
            chat: { completions: { create: operations.create } },
        })
    })

    afterEach(() => {
        delete process.env.OPENAI_API_KEY
    })

    it('prefers the explicit environment credential and reuses one client', async () => {
        process.env.OPENAI_API_KEY = 'env-key'
        operations.create.mockResolvedValue({ id: 'completion-1' })
        const { createCallingOpenAiChatCompletionV1 } = await import('./openai-chat-completion')
        const request = { model: 'gpt-test', messages: [] }

        await expect(createCallingOpenAiChatCompletionV1(request)).resolves.toEqual({ id: 'completion-1' })
        await createCallingOpenAiChatCompletionV1(request)

        expect(operations.getOpenAiRuntimeProviderCredentialV1).not.toHaveBeenCalled()
        expect(operations.createOpenAIClientV1).toHaveBeenCalledTimes(1)
        expect(operations.createOpenAIClientV1).toHaveBeenCalledWith('env-key')
        expect(operations.create).toHaveBeenNthCalledWith(1, request)
    })

    it('falls back to the Calling-owned stored credential', async () => {
        operations.getOpenAiRuntimeProviderCredentialV1.mockResolvedValueOnce('stored-key')
        operations.create.mockResolvedValueOnce({ id: 'completion-2' })
        const { createCallingOpenAiChatCompletionV1 } = await import('./openai-chat-completion')

        await createCallingOpenAiChatCompletionV1({ model: 'gpt-test', messages: [] })

        expect(operations.createOpenAIClientV1).toHaveBeenCalledWith('stored-key')
    })

    it('fails before provider transport when no credential exists', async () => {
        operations.getOpenAiRuntimeProviderCredentialV1.mockResolvedValueOnce(null)
        const { createCallingOpenAiChatCompletionV1 } = await import('./openai-chat-completion')

        await expect(createCallingOpenAiChatCompletionV1({ model: 'gpt-test', messages: [] }))
            .rejects.toThrow('OPENAI_API_KEY is not set')
        expect(operations.createOpenAIClientV1).not.toHaveBeenCalled()
        expect(operations.create).not.toHaveBeenCalled()
    })
})
