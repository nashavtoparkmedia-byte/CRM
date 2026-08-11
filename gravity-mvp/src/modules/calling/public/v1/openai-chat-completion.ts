import {
    createOpenAIClientV1,
    type OpenAIChatCompletionRequestV1,
    type OpenAIChatCompletionV1,
} from '@/infrastructure/providers/openai-client'
import { getOpenAiRuntimeProviderCredentialV1 } from './ai-call-provider-settings'

let client: ReturnType<typeof createOpenAIClientV1> | null = null

async function getCallingOpenAiClient(): Promise<ReturnType<typeof createOpenAIClientV1>> {
    if (client) return client

    let apiKey = process.env.OPENAI_API_KEY
    if (!apiKey) {
        apiKey = (await getOpenAiRuntimeProviderCredentialV1()) ?? undefined
    }
    if (!apiKey) {
        throw new Error('OPENAI_API_KEY is not set (env or AiProviderSetting/openai/apiKey)')
    }

    client = createOpenAIClientV1(apiKey)
    return client
}

export async function createCallingOpenAiChatCompletionV1(
    request: OpenAIChatCompletionRequestV1,
): Promise<OpenAIChatCompletionV1> {
    const openai = await getCallingOpenAiClient()
    return openai.chat.completions.create(request)
}
