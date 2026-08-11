import {
    callForJson,
    callForText,
} from '@/lib/pipeline/llmClient'

export interface ProviderLlmCallOptionsV1 {
    provider: string
    model: string
    apiKey: string
    systemPrompt: string
    messages?: Array<{ role: 'user' | 'assistant'; content: string }>
    userMessage?: string
    maxTokens?: number
    temperature?: number
}

export async function callProviderTextV1(options: ProviderLlmCallOptionsV1): Promise<string> {
    return callForText(options)
}

export async function callProviderJsonV1(options: ProviderLlmCallOptionsV1): Promise<string> {
    return callForJson(options)
}
