/**
 * Bridge-wide runtime configuration for provider API keys.
 *
 * Why this module exists:
 *   The old design read keys directly from process.env at boot. That works
 *   on the dev box where you can put values in .env, but doesn't fit the
 *   production reality where admins configure keys via the CRM UI (rows
 *   in AiProviderSetting). Now the bridge fetches keys from
 *   GET /api/internal/ai-call-keys at the start of each session, and the
 *   provider modules (llm/stt/tts) read them from here.
 *
 * Resolution order for any one key:
 *   1. Value last set via setKeys() — DB-sourced via crm-client.fetchKeys().
 *   2. .env fallback — what was originally there at process start.
 *   3. null — feature disabled.
 *
 * This keeps Day-1 dev boxes working (set OPENAI_API_KEY in .env and skip
 * the UI) while letting the UI override env for prod deployments.
 */

const envSnapshot = {
    openaiApiKey: process.env.OPENAI_API_KEY ?? null,
    yandexApiKey: process.env.YANDEX_API_KEY ?? null,
    yandexFolderId: process.env.YANDEX_FOLDER_ID ?? null,
    mockMode: process.env.AI_CALL_MOCK_MODE === 'true',
}

let runtime = { ...envSnapshot }

function getKeys() {
    return {
        openaiApiKey: runtime.openaiApiKey || envSnapshot.openaiApiKey || null,
        yandexApiKey: runtime.yandexApiKey || envSnapshot.yandexApiKey || null,
        yandexFolderId: runtime.yandexFolderId || envSnapshot.yandexFolderId || null,
        mockMode: runtime.mockMode || envSnapshot.mockMode || false,
    }
}

/**
 * Replace runtime keys with values from a fresh CRM fetch. Pass partial
 * updates — undefined fields keep the existing runtime value, explicit
 * null clears it (forcing fallback to env).
 */
function setKeys(patch) {
    if (!patch || typeof patch !== 'object') return
    for (const k of ['openaiApiKey', 'yandexApiKey', 'yandexFolderId']) {
        if (k in patch) runtime[k] = patch[k] ?? null
    }
    if ('mockMode' in patch) runtime.mockMode = !!patch.mockMode
}

function getOpenAiKey() { return getKeys().openaiApiKey }
function getYandexApiKey() { return getKeys().yandexApiKey }
function getYandexFolderId() { return getKeys().yandexFolderId }
function getMockMode() { return getKeys().mockMode }

module.exports = {
    getKeys,
    setKeys,
    getOpenAiKey,
    getYandexApiKey,
    getYandexFolderId,
    getMockMode,
    envSnapshot,
}
