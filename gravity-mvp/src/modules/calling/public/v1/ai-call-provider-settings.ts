import 'server-only'

import {
    deleteValue,
    getValue,
    saveValue,
    type Key,
    type Provider,
    type SaveOpts,
} from '@/lib/ai-call/provider-settings'

export type { Key as AiCallProviderSettingKey, Provider as AiCallProvider }

export async function saveAiCallProviderSettingV1(
    provider: Provider,
    key: Key,
    value: string,
    options: SaveOpts,
): Promise<void> {
    await saveValue(provider, key, value, options)
}

export async function deleteAiCallProviderSettingV1(provider: Provider, key: Key): Promise<void> {
    await deleteValue(provider, key)
}

export async function getOpenAiRuntimeProviderCredentialV1(): Promise<string | null> {
    return getValue('openai', 'apiKey')
}
