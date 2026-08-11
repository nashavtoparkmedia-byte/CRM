/**
 * Shared OpenAI client singleton.
 *
 * Both the Whisper transcription worker and the GPT-4o analysis worker need
 * an OpenAI handle — sharing one instance avoids reading the key twice
 * and keeps connection pooling consistent.
 *
 * Key resolution order:
 *   1. process.env.OPENAI_API_KEY (legacy / explicit override)
 *   2. AiProviderSetting (provider=openai, key=apiKey) — the path the CRM
 *      admin UI writes through. Encrypted at rest; we read plaintext via
 *      the provider-settings module which handles AES-GCM decryption.
 *
 * Throws on first access if neither source has a key. Workers handle this
 * by letting BullMQ mark the job as failed; the rest of the CRM keeps
 * running.
 */

import { createOpenAIClientV1 } from '@/infrastructure/providers/openai-client'

let client: ReturnType<typeof createOpenAIClientV1> | null = null

export async function getOpenAI(): Promise<ReturnType<typeof createOpenAIClientV1>> {
    if (client) return client

    let apiKey = process.env.OPENAI_API_KEY
    if (!apiKey) {
        // Dynamic import: provider-settings pulls in prisma, AES helpers,
        // and a 30s in-memory cache. Lazy-loading keeps cold-start cost
        // off CRM boot when nothing needs OpenAI yet.
        const { getOpenAiRuntimeProviderCredentialV1 } = await import('@/modules/calling/public/v1/ai-call-provider-settings')
        apiKey = (await getOpenAiRuntimeProviderCredentialV1()) ?? undefined
    }
    if (!apiKey) {
        throw new Error('OPENAI_API_KEY is not set (env or AiProviderSetting/openai/apiKey)')
    }

    // OpenAI SDK 4.x ships its own node-fetch shim and IGNORES the undici
    // globalDispatcher installed in init-proxy.ts. From RU that means every
    // chat/whisper call hits 403 "Country, region, or territory not
    // supported". We force the SDK onto Node's built-in fetch, which is
    // undici-backed and DOES honour the global ProxyAgent → Xray :10809.
    client = createOpenAIClientV1(apiKey)
    return client
}
