import OpenAI from 'openai'

export type OpenAIChatCompletionRequestV1 =
  OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming
export type OpenAIChatCompletionV1 = OpenAI.Chat.Completions.ChatCompletion

/** Exact OpenAI SDK construction capability; credentials stay with the caller. */
export function createOpenAIClientV1(apiKey: string): OpenAI {
  return new OpenAI({ apiKey, fetch: globalThis.fetch as any })
}
