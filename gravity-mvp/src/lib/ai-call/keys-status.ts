/**
 * Read-only access to AI-call API key configuration status, served to the
 * settings UI.
 *
 * History: in the previous PR (#7) secrets lived in process.env. As of
 * this PR they live in the AiProviderSetting DB table (encrypted), with
 * .env kept only as a dev fallback. This module is the thin adapter that
 * shapes the DB rows into the JSON the settings page already consumes.
 *
 * Never returns plaintext secrets — only "configured / not configured",
 * last-4 mask, and the source ('db' | 'env' | 'none') for UX.
 */

import { getStatus, type SettingStatus, type Provider, type Key } from './provider-settings'

export type KeyStatus = SettingStatus & { envName: string }

export interface AiCallKeysStatus {
    openai: KeyStatus
    yandexSpeechkit: KeyStatus
    yandexFolderId: KeyStatus
    mockMode: KeyStatus & { enabled: boolean }
}

const ENV_NAMES: Record<`${Provider}/${Key}`, string> = {
    'openai/apiKey': 'OPENAI_API_KEY',
    'openai/folderId': 'N/A',
    'openai/mockMode': 'N/A',
    'openai/activeProjectId': 'N/A',
    'yandex/apiKey': 'YANDEX_API_KEY',
    'yandex/folderId': 'YANDEX_FOLDER_ID',
    'yandex/mockMode': 'N/A',
    'yandex/activeProjectId': 'N/A',
    'system/apiKey': 'N/A',
    'system/folderId': 'N/A',
    'system/mockMode': 'AI_CALL_MOCK_MODE',
    'system/activeProjectId': 'N/A',
}

async function statusFor(provider: Provider, key: Key): Promise<KeyStatus> {
    const status = await getStatus(provider, key)
    return { ...status, envName: ENV_NAMES[`${provider}/${key}`] }
}

export async function getAiCallKeysStatus(): Promise<AiCallKeysStatus> {
    const [openai, yandexSpeechkit, yandexFolderId, mockMode] = await Promise.all([
        statusFor('openai', 'apiKey'),
        statusFor('yandex', 'apiKey'),
        statusFor('yandex', 'folderId'),
        statusFor('system', 'mockMode'),
    ])
    return {
        openai,
        yandexSpeechkit,
        yandexFolderId,
        // mock-mode is a boolean toggle, not a key — surface `enabled` for
        // the UI but keep the `configured` field for symmetry with the
        // other cards.
        mockMode: { ...mockMode, enabled: mockMode.configured },
    }
}

// Legacy named export kept for older imports — re-exports the helper from
// crypto so existing callers don't break.
export { maskSecret } from './crypto'
