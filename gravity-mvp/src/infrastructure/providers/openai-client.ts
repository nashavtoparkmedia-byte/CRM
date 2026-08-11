import OpenAI from 'openai'

/** Exact OpenAI SDK construction capability; credentials stay with the caller. */
export function createOpenAIClientV1(apiKey: string): OpenAI {
  return new OpenAI({ apiKey, fetch: globalThis.fetch as any })
}
